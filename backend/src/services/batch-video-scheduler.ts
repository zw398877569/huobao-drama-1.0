/**
 * Batch Video Scheduler (Sprint 10 PM msg-20261014-001)
 *
 * 项目内 node-cron 调度, 触发 batch_video_schedules 计划批量生成视频.
 *
 * 工单设计:
 *   - 一次性计划 (one-off), 触发后即废 (scheduled: true)
 *   - 串行跑每个 shot_id (用户拍板 D)
 *   - video_config_id NULL 时用 episode.videoConfigId 锁定 fallback (用户拍板 D5/A)
 *   - status enum: pending / running / done / failed / cancelled
 *   - 失败不自动重跑, 用户走原『生成视频』按钮手动重跑
 *
 * node-cron 配置:
 *   - 6 字段 cron 表达式 (sec min hour dom mon dow)
 *   - timezone: 'Asia/Shanghai' (sprint 10 用户拍板 电脑本地时间)
 *   - scheduled: true (one-shot)
 *   - backend 重启后内存级 cronJobs 失效, initBatchVideoScheduler 重读 pending 重建
 */
import cron, { type ScheduledTask } from 'node-cron'
import { eq, and } from 'drizzle-orm'
import { Mutex } from 'async-mutex'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn, logTaskError } from '../utils/task-logger.js'
import { generateVideo } from './video-generation.js'
import { getConfigById } from './ai.js'

// Sprint 10 v2 Task E (PM msg-20261014-002): 多 plan 防并发 — singleton Semaphore(1)
//   防止多个 plan 同时 triggerPlan 时视频生成 API 撞 rate limit.
//   当前单进程 node-cron 串行触发, 实际不并发; 但 scale 后多进程 / 手动重排都需要.
//   Semaphore(1) = 1 个跑, 其他排队等. 跨进程需要 Redis lock (sprint 10 v2 暂不做).
const videoGenLock = new Mutex()

// 内存级 cron job registry: cronJobId (string) -> node-cron task
// backend 重启后失效, D 任务 initBatchVideoScheduler 重读 pending 重建
const cronJobs = new Map<string, ScheduledTask>()

// Sprint 10 v2 Task B (PM msg-20261014-002): per-shot 执行状态, 存 batch_video_schedules.per_shot_status JSON
//   格式: [{ shot_id, status: 'completed' | 'failed', video_generation_id?, error? }]
export interface ShotStatus {
  shot_id: number
  status: 'completed' | 'failed'
  video_generation_id?: number
  error?: string
}

/**
 * Sprint 10 v2 Task C (PM msg-20261014-002): 过期 pending plan lazy sweep
 *   把 scheduled_at 已过 (> now) 但还没触发的 pending plan mark cancelled,
 *   避免永远 pending (backend 重启 + cron miss 后 plan 注册卡住的场景).
 *
 * 模式跟 cron_runs 一样: 在 GET /plans handler 头部调, lazy sweep, 不开独立 cron.
 * 选 JS 端 compare (不依赖 SQL datetime() 函数) 是因为 scheduledAt 字段可能是
 * 'YYYY-MM-DDTHH:MM:SS+08:00' 或 'YYYY-MM-DDTHH:MM:SSZ' 两种格式, 字符串比较
 * 可能出错; 走 new Date().getTime() parse 后再比, 不管哪种格式都正确.
 *
 * @returns swept 数量
 */
export function sweepExpiredPlans(): number {
  const nowMs = Date.now()
  const pendingPlans = db.select().from(schema.batchVideoSchedules)
    .where(eq(schema.batchVideoSchedules.status, 'pending'))
    .all()
  let swept = 0
  for (const p of pendingPlans) {
    // sprint 10 D5 fix: scheduledAt 可能是 +08:00 或 Z 后缀, new Date() 都能正确 parse
    const ts = new Date(p.scheduledAt).getTime()
    if (Number.isFinite(ts) && ts < nowMs) {
      db.update(schema.batchVideoSchedules)
        .set({ status: 'cancelled', finishedAt: now() })
        .where(eq(schema.batchVideoSchedules.id, p.id))
        .run()
      swept++
    }
  }
  if (swept > 0) {
    logTaskWarn('BatchVideoScheduler', 'sweep-expired-plans', {
      sweptCount: swept,
      hint: 'pending plan scheduledAt 已过期, lazy sweep mark cancelled',
    })
  }
  return swept
}

const SCHEDULER_TZ = 'Asia/Shanghai' as const

/**
 * ISO datetime string → cron 6 字段表达式 (node-cron 格式: sec min hour dom mon dow)
 * 输入: '2026-10-14T15:30:00' (本地时间, 无时区后缀)
 * 输出: '0 30 15 14 10 *' (6 字段)
 */
function isoToCron6(iso: string): string | null {
  // 解析 ISO 字符串, 兼容 'YYYY-MM-DDTHH:MM:SS' 跟 'YYYY-MM-DDTHH:MM:SSZ'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, yyyy, mm, dd, HH, MM, SS] = m
  return `${SS} ${MM} ${HH} ${dd} ${mm} *`
}

/**
 * backend 启动时调 — 读 batch_video_schedules WHERE status='pending', 重建 cron job
 * 由 D 任务 backend/src/index.ts 在 ensureLogDir() 之后调
 */
export async function initBatchVideoScheduler(): Promise<void> {
  const pendingPlans = db.select().from(schema.batchVideoSchedules)
    .where(eq(schema.batchVideoSchedules.status, 'pending'))
    .all()

  if (pendingPlans.length === 0) {
    logTaskProgress('BatchVideoScheduler', 'init-no-pending', { hint: '没有 pending plan, 跳过 rebuild' })
    return
  }

  let rebuiltCount = 0
  let failedCount = 0
  for (const plan of pendingPlans) {
    // 用 plan.id 作 cronJobId, 因为 plan.id 唯一 (DB 主键) — registerPlan 第二个参数 reuseCronJobId 传 `plan-${plan.id}`
    let cronJobId: string | null = null
    try {
      cronJobId = await registerPlan({
        id: plan.id,
        episodeId: plan.episodeId,
        scheduledAt: plan.scheduledAt,
        shotIds: plan.shotIds,
        videoConfigId: plan.videoConfigId,
      }, `plan-${plan.id}`) // reuse plan.id-derived cronJobId (避免重启后产生多个 cron job)
      db.update(schema.batchVideoSchedules)
        .set({ cronJobId })
        .where(eq(schema.batchVideoSchedules.id, plan.id))
        .run()
      rebuiltCount++
    } catch (err: any) {
      failedCount++
      logTaskWarn('BatchVideoScheduler', 'init-skip-fail', {
        planId: plan.id, error: err?.message || String(err),
      })
    }
  }

  logTaskSuccess('BatchVideoScheduler', 'init-done', {
    total: pendingPlans.length,
    rebuilt: rebuiltCount,
    failed: failedCount,
    hint: 'backend 重启后内存级 cronJobs 重建',
  })
}

/**
 * 注册单个 plan 的 cron job — POST 创建 plan 时调
 * @param plan batch_video_schedules 行
 * @param reuseCronJobId 可选, 重启重建时复用 DB 已存的 ID
 * @returns 是否注册成功
 */
export async function registerPlan(
  plan: {
    id: number
    episodeId: number
    scheduledAt: string
    shotIds: string
    videoConfigId: number | null
  },
  reuseCronJobId?: string,
): Promise<string> {
  // 返回 cronJobId, 失败 throw Error (routes/videos.ts 期望 Promise<string>)
  // 调用方 (initBatchVideoScheduler) try/catch 处理失败
  const cronExpr = isoToCron6(plan.scheduledAt)
  if (!cronExpr) {
    logTaskError('BatchVideoScheduler', 'register-parse-fail', {
      planId: plan.id,
      scheduledAt: plan.scheduledAt,
      hint: 'scheduledAt 解析失败, 无法转 cron 6 字段',
    })
    throw new Error(`registerPlan ${plan.id}: scheduledAt parse fail: ${plan.scheduledAt}`)
  }

  // 校验 cron 表达式合法性
  if (!cron.validate(cronExpr)) {
    logTaskError('BatchVideoScheduler', 'register-validate-fail', {
      planId: plan.id,
      cronExpr,
    })
    throw new Error(`registerPlan ${plan.id}: cron validate fail: ${cronExpr}`)
  }

  const cronJobId = reuseCronJobId || `plan-${plan.id}`

  // 如果已存在同 cronJobId 的, 先 stop (避免重复触发)
  const existing = cronJobs.get(cronJobId)
  if (existing) {
    existing.stop()
    cronJobs.delete(cronJobId)
  }

  const task = cron.schedule(cronExpr, async () => {
    try {
      await triggerPlan(plan.id)
    } catch (err: any) {
      logTaskError('BatchVideoScheduler', 'trigger-throw', {
        planId: plan.id,
        error: err?.message || String(err),
      })
    }
  }, {
    scheduled: true,  // one-shot 不需要 recurring
    timezone: SCHEDULER_TZ,
  })

  cronJobs.set(cronJobId, task)
  logTaskSuccess('BatchVideoScheduler', 'register', {
    planId: plan.id,
    cronJobId,
    cronExpr,
    scheduledAt: plan.scheduledAt,
    timezone: SCHEDULER_TZ,
  })

  // Bug B fix: 如果 scheduledAt 已过, node-cron scheduled:true 不会立即 fire (等不到下个匹配时间, one-shot 默认不重复).
  // 立即调 triggerPlan 一次, 让用户即便错过 cron 触发时间, 也能跑 plan.
  // 注意: registerPlan 是 async, 但 routes/videos.ts 调它时 await, 所以 triggerPlan 跟 create API 同步,
  //       plan 在返回 201 时已经 status=pending; 立即 trigger 改 status=running/done/failed
  const nowMs = Date.now()
  const targetMs = new Date(plan.scheduledAt).getTime()
  if (targetMs <= nowMs) {
    logTaskWarn('BatchVideoScheduler', 'register-already-due', {
      planId: plan.id,
      scheduledAt: plan.scheduledAt,
      hint: 'scheduledAt 已过, 立即 fire triggerPlan (node-cron one-shot 不 catch-up)',
    })
    // fire-and-forget, 不阻塞 create API response
    triggerPlan(plan.id).catch((err) => {
      logTaskError('BatchVideoScheduler', 'immediate-trigger-fail', {
        planId: plan.id, error: err?.message || String(err),
      })
    })
  }

  return cronJobId
}

/**
 * 取消 plan — DELETE batch-schedules/:id 时调
 */
export async function unregisterPlan(cronJobId: string): Promise<void> {
  const task = cronJobs.get(cronJobId)
  if (task) {
    task.stop()
    cronJobs.delete(cronJobId)
    logTaskSuccess('BatchVideoScheduler', 'unregister', { cronJobId })
  } else {
    // cronJobId 不存在 (e.g. backend 重启后没 init), warn 但不 throw
    logTaskWarn('BatchVideoScheduler', 'unregister-not-found', {
      cronJobId,
      hint: 'cronJobId 不在内存, 可能 backend 重启后丢失, 但 DB status 已 cancelled, 无副作用',
    })
  }
}

/**
 * 内部触发器 — node-cron 到点调 (或 batch-video-scheduler 重启后 plan.scheduledAt 已过期)
 * 串行跑每个 shot_id, 失败不重试 (用户走原『生成视频』按钮重跑)
 */
export async function triggerPlan(planId: number): Promise<void> {
  // Sprint 10 v2 Task E: 多 plan 防并发. acquire 时排队等, release 时下一个起跑.
  const release = await videoGenLock.acquire()
  try {
    await triggerPlanImpl(planId)
  } finally {
    release()
  }
}

// triggerPlan 实际实现 (Task E 拆分: 外面套 Semaphore, 内部纯业务逻辑)
async function triggerPlanImpl(planId: number): Promise<void> {
  const [plan] = db.select().from(schema.batchVideoSchedules)
    .where(eq(schema.batchVideoSchedules.id, planId))
    .all()
  if (!plan) {
    logTaskError('BatchVideoScheduler', 'trigger-plan-not-found', { planId })
    return
  }
  if (plan.status !== 'pending') {
    logTaskWarn('BatchVideoScheduler', 'trigger-skip-non-pending', {
      planId,
      status: plan.status,
      hint: 'plan 不在 pending 状态, 跳过 trigger (可能已被取消或已跑)',
    })
    return
  }

  // 1. UPDATE status: pending → running
  db.update(schema.batchVideoSchedules)
    .set({ status: 'running', startedAt: now(), lastRunAt: now() })
    .where(eq(schema.batchVideoSchedules.id, planId))
    .run()

  // 2. 解析 shotIds
  let shotIds: number[] = []
  try {
    shotIds = JSON.parse(plan.shotIds) as number[]
    if (!Array.isArray(shotIds)) throw new Error('shotIds not array')
  } catch (err: any) {
    logTaskError('BatchVideoScheduler', 'trigger-shotIds-parse-fail', {
      planId, shotIdsRaw: plan.shotIds, error: err?.message,
    })
    db.update(schema.batchVideoSchedules)
      .set({ status: 'failed', finishedAt: now(), lastError: `shotIds parse fail: ${err?.message}` })
      .where(eq(schema.batchVideoSchedules.id, planId))
      .run()
    return
  }

  // 3. 决定 configId fallback 链: plan.videoConfigId (active 校验) → episode.videoConfigId → getActiveConfig (在 generateVideo 内部)
  // Bug E fix: plan.videoConfigId 可能 inactive (用户在设置页关掉), 校验后 fallback 避免 generateVideo throw
  let resolvedConfigId: number | undefined = plan.videoConfigId ?? undefined
  if (resolvedConfigId !== undefined) {
    const cfg = getConfigById(resolvedConfigId)
    if (!cfg) {
      // getConfigById 已经 log config-not-found 或 config-inactive
      logTaskWarn('BatchVideoScheduler', 'trigger-config-fallback', {
        planId, shotId: 'pre-loop',
        configuredConfigId: resolvedConfigId,
        hint: '用户配的 configId 无效或 inactive, fallback 到 episode 锁定',
      })
      resolvedConfigId = undefined
    }
  }
  if (resolvedConfigId === undefined) {
    const [ep] = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, plan.episodeId)).all()
    if (ep?.videoConfigId != null) {
      // 同样校验 episode 锁定的 configId
      const epCfg = getConfigById(ep.videoConfigId)
      if (epCfg) {
        resolvedConfigId = ep.videoConfigId
      } else {
        logTaskWarn('BatchVideoScheduler', 'trigger-config-fallback-episode', {
          planId, episodeId: plan.episodeId, episodeConfigId: ep.videoConfigId,
          hint: 'episode 锁定的 configId 也无效, 让 generateVideo 内部用 getActiveConfig fallback',
        })
      }
    }
  }

  // 4. 串行跑每个 shot
  let successCount = 0
  let failedCount = 0
  let lastError: string | null = null
  // Sprint 10 v2 Task B: 每 shot 完成 / 失败 push 一项, 最后跟 plan 一起 UPDATE 到 per_shot_status JSON
  const perShotStatus: ShotStatus[] = []

  for (const shotId of shotIds) {
    const [sb] = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, shotId)).all()
    if (!sb) {
      failedCount++
      lastError = `shotboard ${shotId} 不存在 (可能被删除)`
      perShotStatus.push({ shot_id: shotId, status: 'failed', error: 'shotboard not found' })
      logTaskWarn('BatchVideoScheduler', 'trigger-skip-shot-not-found', {
        planId, shotId,
      })
      continue
    }

    const prompt = sb.videoPrompt || sb.imagePrompt || sb.description || sb.action || ''
    if (!prompt) {
      failedCount++
      lastError = `shot ${shotId} 无 prompt 字段`
      perShotStatus.push({ shot_id: shotId, status: 'failed', error: 'no prompt field' })
      logTaskWarn('BatchVideoScheduler', 'trigger-skip-shot-no-prompt', {
        planId, shotId,
      })
      continue
    }

    // Bug G fix (user 拍板 2026-10-15): triggerPlan 智能选 autodl-comfyui workflow mode
    //   - 有 first+last frame → first_last (FL2V, 'minimax_h3_lightx2v')
    //   - 只有 first frame + duration >= 8s → single + model=Ref2V-15s (显式 'minimax_h3_lightx2v_v5_15s')
    //   - 只有 first frame + duration < 8s → single + model=undefined (autodl 默认 v5, 1-10s)
    //   - 都没 frame → none (T2V, 'minimax_h3_lightx2v_no_pic')
    //   duration 阈值 8s 是 user 拍板 (autodl 默认是 10s)
    let referenceMode: 'first_last' | 'single' | 'none'
    let modelOverride: string | undefined
    let imageUrlArg: string | undefined
    let firstFrameUrlArg: string | undefined
    let lastFrameUrlArg: string | undefined

    if (sb.firstFrameImage && sb.lastFrameImage) {
      referenceMode = 'first_last'
      firstFrameUrlArg = sb.firstFrameImage
      lastFrameUrlArg = sb.lastFrameImage
    } else if (sb.firstFrameImage) {
      // 只有 first frame: 走 single mode (autodl 单图参考), 8s 分界
      referenceMode = 'single'
      imageUrlArg = sb.firstFrameImage
      if ((sb.duration ?? 10) >= 8) {
        modelOverride = 'minimax_h3_lightx2v_v5_15s'  // Ref2V-15s, 1-15s
      }
      // < 8s: model=undefined → autodl 内部 pickRef2VWorkflowId → v5 (1-10s)
    } else {
      // 都没 frame: T2V 文生视频
      referenceMode = 'none'
    }
    logTaskProgress('BatchVideoScheduler', 'shot-mode-decided', {
      planId, shotId, referenceMode, modelOverride,
      hasFirst: !!sb.firstFrameImage, hasLast: !!sb.lastFrameImage, duration: sb.duration,
    })

    try {
      const videoGenerationId = await generateVideo({
        storyboardId: sb.id,
        dramaId: undefined, // storyboard 已带 episodeId
        source: 'storyboard',
        prompt,
        model: modelOverride,
        referenceMode,
        imageUrl: imageUrlArg,
        firstFrameUrl: firstFrameUrlArg,
        lastFrameUrl: lastFrameUrlArg,
        referenceImageUrls: undefined,
        duration: sb.duration || 10,
        aspectRatio: undefined,
        negativePrompt: sb.negativePrompt || undefined,
        seed: undefined,
        configId: resolvedConfigId,
        traceId: undefined,
      })
      successCount++
      perShotStatus.push({ shot_id: shotId, status: 'completed', video_generation_id: videoGenerationId })
      logTaskProgress('BatchVideoScheduler', 'shot-generated', {
        planId, shotId, successCount, failedCount,
      })
    } catch (err: any) {
      failedCount++
      lastError = `shot ${shotId}: ${err?.message || String(err)}`
      perShotStatus.push({ shot_id: shotId, status: 'failed', error: err?.message || String(err) })
      logTaskError('BatchVideoScheduler', 'shot-generate-fail', {
        planId, shotId, error: err?.message || String(err),
      })
      // 继续跑下一个 shot, 不 break (用户拍板 "失败不重跑, 但 batch 内串行继续")
    }
  }

  // 5. UPDATE plan final status (含 per_shot_status JSON, Sprint 10 v2 Task B)
  const finalStatus = failedCount === 0 ? 'done' : (successCount === 0 ? 'failed' : 'failed')  // 任何失败都标 failed (重跑走按钮)
  db.update(schema.batchVideoSchedules)
    .set({
      status: finalStatus,
      finishedAt: now(),
      successCount,
      failedCount,
      lastError,
      perShotStatus: JSON.stringify(perShotStatus),
    })
    .where(eq(schema.batchVideoSchedules.id, planId))
    .run()

  logTaskSuccess('BatchVideoScheduler', 'trigger-done', {
    planId,
    status: finalStatus,
    successCount,
    failedCount,
    shotCount: shotIds.length,
  })
}

// (triggerPlan wrapper 在文件顶部加了 acquire/release, 实际逻辑都在 triggerPlanImpl 里)

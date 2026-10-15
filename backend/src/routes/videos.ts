import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateVideo } from '../services/video-generation.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

/**
 * 规范化 scheduled_at 输入: 无 Z/时区后缀的 ISO 字符串当 Asia/Shanghai 本地时间, 转 UTC ISO 存 DB
 * 修 Bug D: 历史 plan 1 (2026-10-14T15:30:00 无 Z) 在前端 new Date() 解析为本地时区, 渲染跟实际 UTC 时间差 8 小时
 */
function normalizeScheduledAt(input: string): string {
  if (!input) return input
  // 已有 Z 或 +HH:MM 时区后缀, 已是 ISO 8601, 直接返回
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(input)) return input
  // 无后缀: 加 +08:00 当 Asia/Shanghai 本地时间 (保持本地时间语义, 不转 UTC, 让 cron 字段跟 timezone 字段匹配)
  return input + '+08:00'  // 后续 isoToCron6 regex 接受 +HH:MM 后缀
}
import { now } from '../utils/response.js'
import { registerPlan, unregisterPlan } from '../services/batch-video-scheduler.js'

const app = new Hono()

// POST /videos — Generate video
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    // 防御性：兼容 "<configId>:<modelName>" 复合格式（多模型选择器）；目前前端用纯数字 ID，但保留解析以防未来改
    const { configId: explicitConfigId, model: explicitModel } = parseConfigIdWithModel(body.config_id)
    // 优先级: 用户在视频模型弹窗显式选的 > episode 锁定的 video_config_id > getActiveConfig fallback
    // (前端 Phase 2 之后, 弹窗选择是用户当前明确的意图, 不应被 episode 旧锁定覆盖)
    let configId: number | undefined = explicitConfigId
    // 自由创作不读 episode 锁定的 videoConfigId — 用户在表单里挑哪个 config 就用哪个
    if (configId === undefined && body.source !== 'free' && body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.videoConfigId != null) configId = ep.videoConfigId
      }
    }

    logTaskStart('VideoAPI', 'generate', {
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      source: body.source === 'free' ? 'free' : 'storyboard',
      referenceMode: body.reference_mode,
      duration: body.duration,
    })
    logTaskPayload('VideoAPI', 'request body', body)
    // 自由创作模式: source='free' 时不查 episode 锁定的 videoConfigId,
    // 避免误用正式分镜的配置; 同时 storyboardId/dramaId 保持 null 即可
    const source: 'storyboard' | 'free' = body.source === 'free' ? 'free' : 'storyboard'
    const traceId = (c as any).get('traceId') as string | undefined
    const id = await generateVideo({
      storyboardId: source === 'free' ? null : body.storyboard_id,
      dramaId: body.drama_id,
      source,
      prompt: body.prompt,
      model: body.model || explicitModel,
      referenceMode: body.reference_mode,
      imageUrl: body.image_url,
      firstFrameUrl: body.first_frame_url,
      lastFrameUrl: body.last_frame_url,
      referenceImageUrls: body.reference_image_urls,
      duration: body.duration,
      aspectRatio: body.aspect_ratio,
      negativePrompt: body.negative_prompt,
      seed: body.seed,
      configId,
      traceId,
    })

    const [record] = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id)).all()
    logTaskSuccess('VideoAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('VideoAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// ─── Batch Video Schedules (Sprint 10 PM msg-20261014-001) ────────────
// 一次性定时批量生成视频计划, 项目内 node-cron 调度 (D 任务启动集成)
// 工单 user_4_decisions_locked: D1 触发时间 UI 选 / D2 一次性 / D3 status enum + 失败手动重跑 / D4 单 episode
//
// ⚠️ 路由声明顺序必须在 app.get('/:id') 和 app.delete('/:id') 之前 (Bug C 治本)
// 修前 (Sprint 10 B commit 4ab8107): POST/GET/DELETE /batch-schedules 声明在 L124/L175/L192,
//   晚于 app.get('/:id') (L87). 当 GET /videos/batch-schedules 请求进来,
//   :id 通配段抢先把 'batch-schedules' 当 id 参数 → Number('batch-schedules') = NaN
//   → db.select().where(id === NaN).all() 永远查不到 → success(c, null)
//   → 前端 useApi req() 拿到的 data 是 {code:200, data:null, ...} → useBatchVideoSchedule 兜底 list=[]
//   → console 看到 data:null, 页面空 (4 条 plan 在 DB 但永远渲染不出来)
// 修后: batch-schedules 三个路由上移到 :id 之前, 字面段优先匹配, handler 真正跑

// POST /videos/batch-schedules — 创建计划 (注册 cron job)
app.post('/batch-schedules', async (c) => {
  const body = await c.req.json()
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  if (!body.scheduled_at) return badRequest(c, 'scheduled_at is required')
  if (!Array.isArray(body.shot_ids) || body.shot_ids.length === 0) return badRequest(c, 'shot_ids must be non-empty array')

  const episodeId = Number(body.episode_id)
  const videoConfigId = body.video_config_id ? Number(body.video_config_id) : null
  const shotIds = body.shot_ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
  if (shotIds.length === 0) return badRequest(c, 'shot_ids contain no valid integer IDs')

  try {
    const createdAt = now()
    const insertResult = db.insert(schema.batchVideoSchedules).values({
      episodeId,
      scheduledAt: normalizeScheduledAt(String(body.scheduled_at)),
      status: 'pending',
      videoConfigId,
      shotIds: JSON.stringify(shotIds),
      shotCount: shotIds.length,
      successCount: 0,
      failedCount: 0,
      createdAt,
    }).returning().all()

    const plan = insertResult[0]
    if (!plan) return badRequest(c, 'insert failed')

    // 注册 cron job (stub 现在返回 cronJobId, C 任务填充实际调度逻辑)
    const cronJobId = await registerPlan({
      id: plan.id,
      episodeId: plan.episodeId,
      scheduledAt: plan.scheduledAt,
      shotIds: plan.shotIds,
      videoConfigId: plan.videoConfigId,
    })
    db.update(schema.batchVideoSchedules)
      .set({ cronJobId })
      .where(eq(schema.batchVideoSchedules.id, plan.id))
      .run()
    plan.cronJobId = cronJobId

    logTaskSuccess('BatchVideoSchedule', 'create', { planId: plan.id, episodeId, shotCount: shotIds.length })
    return created(c, plan)
  } catch (err: any) {
    logTaskError('BatchVideoSchedule', 'create', { error: err.message, episodeId })
    return badRequest(c, err.message)
  }
})

// GET /videos/batch-schedules?episode_id=N — 列出某 episode 的所有计划
app.get('/batch-schedules', async (c) => {
  const episodeId = c.req.query('episode_id')
  try {
    let rows: any[] = db.select().from(schema.batchVideoSchedules).all() ?? []
    if (episodeId) rows = rows.filter(r => r.episodeId === Number(episodeId))
    rows.sort((a, b) => (b.scheduledAt || '').localeCompare(a.scheduledAt || ''))
    return success(c, rows)
  } catch (err: any) {
    // Bug C 防御: 抛错时也返回 200 with 空 array, 前端能正常显示 '没有计划' 不再 stuck
    logTaskError('BatchVideoSchedule', 'list-throw', { error: err?.message || String(err), stack: err?.stack?.slice(0, 500) })
    return success(c, [])
  }
})

// DELETE /videos/batch-schedules/:id — 取消 pending 计划 (unregister cron job, status -> cancelled)
app.delete('/batch-schedules/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [plan] = db.select().from(schema.batchVideoSchedules)
    .where(eq(schema.batchVideoSchedules.id, id)).all()
  if (!plan) return badRequest(c, `batch-schedule ${id} not found`)
  if (plan.status !== 'pending') return badRequest(c, `cannot cancel plan in status '${plan.status}' (only pending can cancel)`)

  if (plan.cronJobId) await unregisterPlan(plan.cronJobId)
  db.update(schema.batchVideoSchedules)
    .set({ status: 'cancelled', finishedAt: now() })
    .where(eq(schema.batchVideoSchedules.id, id))
    .run()

  logTaskSuccess('BatchVideoSchedule', 'cancel', { planId: id })
  return success(c)
})

// GET /videos/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /videos — List by storyboard_id / drama_id / source
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')
  // source 过滤: ?source=free 取自由创作记录; ?source=storyboard 取正式分镜; 不传返回所有
  const source = c.req.query('source')

  let rows = db.select().from(schema.videoGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  if (source === 'free' || source === 'storyboard') {
    rows = rows.filter(r => (r.source || 'storyboard') === source)
  }

  return success(c, rows)
})

// DELETE /videos/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).run()
  return success(c)
})

export default app

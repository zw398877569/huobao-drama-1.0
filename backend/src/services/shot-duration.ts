/**
 * 镜头时长体系 (共享模块)
 *
 * Sprint 11 R1/R2/R3 (PM msg-20261016-002 V4 时长体系回归审计):
 *   Sprint 9 V4 (msg-20261010-003) 用 services/storyboard-planner-service.ts 三步新链路
 *   替换旧分镜生成时, 旧路径 agents/tools/storyboard-tools.ts 里 7 个时长相关函数
 *   全部遗落 (新链路 0 引用), 导致整集被系统性压短:
 *     - R1 computeShotDuration 五因子估算 → 新链路只有 LLM 自由给 duration
 *     - R2 convergeShotDurations + getEpisodeTargetSeconds Σ 收敛 → 新链路纯靠 LLM 自觉
 *     - R3 getHookMin / applySceneTransitionBonus / isCliffhangerScene /
 *        buildFirstInSceneIndices 钩子与场景过渡 → 新链路 0 引用
 *
 *   实测 (PM 2026-10-16): episode 3 (旧链路) duration 10/11/12/13/15s 五档 Σ=327s;
 *   episode 12 (新链路) 只有 4/5/6s 三档 Σ=92s — 19 镜全 4-6s 匀速短镜头,
 *   这正是漫剧"AI 味""平"的直接原因之一 (节奏被压平)。
 *
 * 本模块从 storyboard-tools.ts 原样抽出, 两条链路共用:
 *   1. 旧 agent 路径 (storyboard-tools.ts) — import 本模块, 行为完全不变
 *   2. V4 三步新链路 (storyboard-planner-service.ts) — 经 applyDurationPolicy() 接入
 *
 * 硬约束 (用户 2026-10-16 拍板 D2):
 *   VIDEO_MAX_DURATION = 15 是 H3 平台硬上限, 严禁放宽。
 *   需要更长镜头时靠【拆成两镜】实现, 不靠突破上限。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  getBaselineFor,
  getMoveScale,
  FALLBACK_DENSITY_SCALE,
  computeDialogueFloor,
  SHORT_DIALOGUE_THRESHOLD,
  SHORT_DIALOGUE_MAX,
  // ★ Sprint 47 T5 (PM msg-20261115-188): 台词 floor 的有效口径 (与拆解校验 T9 共用同一份常量)
  computeEffectiveDialogueFloor,
  countDialogueChars,
  HOOK_OPENING_MIN,
  HOOK_CLOSING_MIN,
  HOOK_CLIFFHANGER_MIN,
  CLIFFHANGER_TAGS,
  SCENE_TRANSITION_BONUS,
  DEFAULT_EPISODE_TARGET_SECONDS,
  EPISODE_TARGET_TOLERANCE,
  CLIMAX_BONUS_COEFFICIENT,
} from '../constants/shot-type-baseline.js'
import { estimateTargetDuration } from '../lib/episode-duration-estimator.js'
import { INTENTION_TEMPLATES, type DramaticFunctionKey } from '../agents/director-intent-templates.js'
import { classifyEpisodeScenes, type EpisodeSceneData, type SceneTag } from '../lib/scene-classifier.js'
// Sprint 17 (PM msg-20261021-076) Task F④: 场景 Σ 密度区间约束 (老路径 轴4.5) 的告警
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

// ★ Sprint 47 T5: 纯逻辑部分拆到 services/shot-duration-rules.ts (不碰 DB → 可离线断言)
//   这里保留 DB 相关部分 (目标时长查询 / 整集策略 / 回写) 并 re-export 纯逻辑, 旧 import 路径照常可用
export {
  VIDEO_MIN_DURATION,
  VIDEO_MAX_DURATION,
  computeShotDuration,
  getHookMin,
  applySceneTransitionBonus,
  buildFirstInSceneIndices,
  isCliffhangerScene,
  convergeShotDurations,
  scaleShotDurations,
  SCENE_DENSITY_RULES,
} from './shot-duration-rules.js'
import {
  computeShotDuration,
  applySceneTransitionBonus,
  buildFirstInSceneIndices,
  isCliffhangerScene,
  convergeShotDurations,
  scaleShotDurations,
  SCENE_DENSITY_RULES,
  type DensityTier,
  VIDEO_MIN_DURATION,
  VIDEO_MAX_DURATION,
} from './shot-duration-rules.js'

/**
 * episode target 来源  [R2]
 *  PM msg-20260920-004 Step 3.D 接入 (三级取值):
 *    1. 先查 episodes.target_duration 字段 (如有且不为 null 且 > 0) → 直接返回
 *    2. 否则调 estimateTargetDuration() (聚合 storyboards dialogue + sceneIntention)
 *    3. 再 fallback DEFAULT_EPISODE_TARGET_SECONDS (100s)
 *
 *  用户 2026-10-16 拍板 D1: 短剧目标时长【保持系统按内容自动评估】, 本期不做 UI 手动设置入口。
 *  episodes.target_duration 字段保留 (用户手动改过 DB 就能生效), 代码层读取能力保留。
 */
export function getEpisodeTargetSeconds(episodeId: number): number {
  // 1. user-set target duration (字段保留, 用户手动改过 DB 就生效)
  const episodeRow = db.select({ targetDuration: schema.episodes.targetDuration, dramaId: schema.episodes.dramaId })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (episodeRow?.targetDuration != null && episodeRow.targetDuration > 0) {
    return episodeRow.targetDuration
  }

  if (!episodeRow || episodeRow.dramaId == null) {
    return DEFAULT_EPISODE_TARGET_SECONDS
  }

  // 2. 聚合 estimator 所需数据
  //    drama 内所有 episodes (算 episode position penalty)
  const dramaEpisodes = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, episodeRow.dramaId))
    .all()

  //    本 episode 所有 scenes
  const scenes = db.select().from(schema.scenes)
    .where(eq(schema.scenes.episodeId, episodeId))
    .all()

  //    本 episode 所有 storyboards (聚合 dialogue + intentionFunction per scene)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()

  const dialogueByScene = new Map<number, string>()
  const intentionByScene = new Map<number, DramaticFunctionKey>()
  for (const sb of storyboards) {
    if (sb.sceneId == null) continue
    if (sb.dialogue) {
      dialogueByScene.set(sb.sceneId, (dialogueByScene.get(sb.sceneId) ?? '') + sb.dialogue)
    }
    if (sb.sceneIntention) {
      // first-wins: 取第一个解析成功的 intention (同 scene 多 storyboard 时)
      if (!intentionByScene.has(sb.sceneId)) {
        try {
          const parsed = JSON.parse(sb.sceneIntention) as { function?: string }
          if (parsed.function) {
            intentionByScene.set(sb.sceneId, parsed.function as DramaticFunctionKey)
          }
        } catch {
          // 解析失败忽略, 下个 storyboard 再试
        }
      }
    }
  }

  //    构造 EpisodeSceneData[] (caller 负责组装 dialogue/intentionFunction)
  const episodeSceneData: EpisodeSceneData[] = scenes.map(s => ({
    ...s,
    dialogue: dialogueByScene.get(s.id),
    intentionFunction: intentionByScene.get(s.id),
  }))

  // 3. estimator (返回 [60, 240] clamp 后的秒数)
  return estimateTargetDuration(episodeId, dramaEpisodes, episodeSceneData)
}

/**
 * V4 三步新链路统一时长策略入口  [R1 + R3 + R2]
 *
 * 2026-10-16 用户拍板: 应用顺序与旧 agent 路径【完全一致】, 不创新逻辑:
 *   阶段 1 (逐镜, R1 + R3):
 *     candidate = computeShotDuration(sp, intentTemplate, sceneTag)   五因子估算
 *     candidate = applySceneTransitionBonus(candidate, isFirstInScene) 场景首镜 +0.5s
 *     duration  = clamp(candidate, VIDEO_MIN_DURATION, VIDEO_MAX_DURATION)
 *   阶段 2 (整集, R2):
 *     durations = convergeShotDurations(durations, target, isCliffhanger)
 *     └─ 钩子镜 (idx=0 / idx=last 且 cliffhanger) 不被缩, floor = hookMin
 *     └─ 其余镜缩放下限 = VIDEO_MIN_DURATION=4 (QA ISSUE-002 修复保留)
 *
 * 与旧路径 (storyboard-tools.ts:1136-1151 + 1324-1331) 逐行对应, 行为一致。
 * VIDEO_MAX_DURATION=15 是 H3 平台硬上限 (用户 D2 拍板), 严禁放宽。
 *
 * @param episodeId  用于查 target (episodes.target_duration → estimator → 100s fallback)
 * @param shots      step2 LLM 输出的 shot_details 数组 (会被就地写入 duration)
 * @returns 收敛后的 Σ 秒数
 */
export function applyDurationPolicy(
  episodeId: number,
  shots: Array<{
    scene_id?: number
    shot_type?: string
    movement?: string
    dialogue?: string
    intent_function?: string
    duration?: number
  }>,
): number {
  if (shots.length === 0) return 0

  const episodeTargetSeconds = getEpisodeTargetSeconds(episodeId)

  // scene_id → SceneTag (climax 1.3x bonus) + 是否 cliffhanger (钩子豁免 + 结尾镜下限)
  const sceneIds = [...new Set(shots.map(s => s.scene_id).filter((id): id is number => typeof id === 'number'))]
  const sceneRows = sceneIds.length > 0
    ? db.select().from(schema.scenes)
        .where(eq(schema.scenes.episodeId, episodeId))
        .all()
        .filter(s => sceneIds.includes(s.id))
    : []
  const sceneMap = new Map<number, { intention?: { function?: string } | null }>(
    sceneRows.map(s => [s.id, s as any]),
  )
  // sceneTagMap: classifyEpisodeScenes 3-vote (跟旧路径 storyboard-tools.ts:1060-1087 逐行一致)
  //   intentionFunction 来自 storyboards.scene_intention JSON 按 scene_id 聚合 (first-wins),
  //   不是读 scenes 表 (scenes 表无 intention 字段)。
  const intentionByScene = new Map<number, DramaticFunctionKey>()
  {
    const sbs = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
    for (const sb of sbs) {
      if (sb.sceneId == null) continue
      if (sb.sceneIntention && !intentionByScene.has(sb.sceneId)) {
        try {
          const parsed = JSON.parse(sb.sceneIntention) as { function?: string }
          if (parsed.function) intentionByScene.set(sb.sceneId, parsed.function as DramaticFunctionKey)
        } catch { /* malformed sceneIntention JSON, skip */ }
      }
    }
  }
  const episodeScenesForClf: EpisodeSceneData[] = sceneRows
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(s => ({ ...s, intentionFunction: intentionByScene.get(s.id) }))
  const sceneClimaxTags = classifyEpisodeScenes(episodeScenesForClf)
  const sceneTagMap = new Map<number, SceneTag>(
    episodeScenesForClf.map((s, idx) => [s.id, sceneClimaxTags[idx]])
  )

  // scene 内首镜索引 (场景过渡 bonus) — 按 shots 当前顺序算
  const firstInSceneIndices = new Set<number>()
  {
    const seen = new Set<number>()
    shots.forEach((s, i) => {
      if (typeof s.scene_id !== 'number') return
      if (!seen.has(s.scene_id)) {
        seen.add(s.scene_id)
        firstInSceneIndices.add(i)
      }
    })
  }

  // ★ Sprint 47 T5 (PM msg-20261115-188): 每镜的【台词 floor】(硬下界)
  //   口径 = computeEffectiveDialogueFloor(countDialogueChars(dialogue)) —— 与阶段 1 算 candidate 用的是同一份
  //   (floor 受平台 15s 上限约束: 64 字 → floor 15)
  const dialogueFloors = shots.map((sp) => computeEffectiveDialogueFloor(countDialogueChars(sp.dialogue)))

  // ── 阶段 1: 逐镜五因子 + 场景过渡 + clamp  [R1 + R3]
  shots.forEach((sp, i) => {
    const intentTemplate = sp.intent_function
      ? INTENTION_TEMPLATES[sp.intent_function as DramaticFunctionKey]
      : undefined
    const sceneTag = (typeof sp.scene_id === 'number' ? sceneTagMap.get(sp.scene_id) : undefined) ?? 'normal'
    let candidate = computeShotDuration(
      { shot_type: sp.shot_type || '', dialogue: sp.dialogue, movement: sp.movement },
      intentTemplate,
      sceneTag,
    )
    candidate = applySceneTransitionBonus(candidate, firstInSceneIndices.has(i))
    sp.duration = Math.max(VIDEO_MIN_DURATION, Math.min(VIDEO_MAX_DURATION, candidate))
  })

  // ── 阶段 1.5: 场景 Σ 密度区间 (Sprint 17 Task F④, 老路径 轴4.5) ──
  //   老路径 agents/index.ts:1054-1062 的 scene 密度软联动约束:
  //     low    (铺垫/余韵/悬念):      单镜 ≥8s, 本场景 Σ 25-50s
  //     medium (揭露/对峙):          单镜 ≥5s, 本场景 Σ 15-35s
  //     high   (反转/高潮/情感爆发):  单镜 ≥3s, 本场景 Σ 10-25s
  //
  //   老路径的做法是【抛错让 planner retry】(agents/tools/storyboard-tools.ts:893-940)。
  //   V4 路径改成【自动拉伸/压缩】(PM Task F④ 拍板) —— retry 一次要 +3~5 分钟,
  //   Sprint 16 实测整集拆解已经跑到 700s, 不能再来一轮整集重试。
  //
  //   ⚠️ 只管【场景 Σ 区间】, 不动单镜下限:
  //      - 单镜时长由 R1 的五因子估算负责 (景别 baseline × 密度 × 运镜 × 对白下限)
  //      - 老路径的"低密度场景单镜 ≥8s"会把悬念戏的特写也拉成 8s, 节奏反而更平
  //      - PM 明确要求"不破坏 Sprint 11 R1/R2/R3 的单镜时长逻辑"
  //      → 单镜下限违反只告警, 由人工决定要不要拉长
  // 被阶段 1.5 调整过的 scene (阶段 3 要复查有没有被 Σ 收敛压回去)
  const sceneAdjusted = new Map<number, { before: number; after: number; density: string }>()

  // 按 scene_id 分组 (保持 shots 顺序)
  const sceneGroups = new Map<number, number[]>()
  shots.forEach((sp, i) => {
    if (typeof sp.scene_id !== 'number') return
    const list = sceneGroups.get(sp.scene_id)
    if (list) list.push(i)
    else sceneGroups.set(sp.scene_id, [i])
  })

  for (const [sceneId, indices] of sceneGroups) {
    // 密度档: 优先用【本场景第一镜】的 intent_function (老路径口径: 场景功能是本场所有镜头的叙事锚),
    //   拿不到再退回 DB 里的 scene_intention.function。
    const firstShotFn = shots[indices[0]]?.intent_function
    const fn = firstShotFn || intentionByScene.get(sceneId)
    const density = (fn && INTENTION_TEMPLATES[fn as DramaticFunctionKey]?.shotDensity) || 'medium'
    const rule = SCENE_DENSITY_RULES[density as DensityTier]
    if (!rule) continue

    const total = indices.reduce((a, i) => a + (shots[i].duration || 0), 0)
    if (total <= 0) continue

    // 单镜下限: 只告警不动 (见上面说明)
    const minShot = Math.min(...indices.map((i) => shots[i].duration || 0))
    if (minShot < rule.minMirror) {
      logTaskWarn('ShotDuration', 'scene-shot-below-density-floor', {
        sceneId,
        density,
        minShot,
        floor: rule.minMirror,
        shotNumbers: indices.map((i) => shots[i].shot_type),
        hint: '本场景有镜头短于该密度档的单镜下限 —— 老路径轴4.5 的要求, 这里只告警不自动改 (R1 五因子估算负责单镜)',
      })
    }

    let scale = 1
    if (total < rule.sceneMinTotal) scale = rule.sceneMinTotal / total
    else if (total > rule.sceneMaxTotal) scale = rule.sceneMaxTotal / total
    if (Math.abs(scale - 1) < 0.01) continue

    // 拉伸时保 VIDEO_MAX, 压缩时保台词 floor (★ Sprint 47 T5: 场景 Σ 压缩同样不得突破台词 floor)
    let after = 0
    indices.forEach((i) => {
      const cur = shots[i].duration || 0
      const next = scaleShotDurations([cur], scale, [dialogueFloors[i] ?? 0])[0]
      shots[i].duration = next
      after += next
    })
    sceneAdjusted.set(sceneId, { before: total, after, density })
    logTaskProgress('ShotDuration', 'scene-sum-adjusted', {
      sceneId,
      density,
      before: total,
      after,
      targetRange: [rule.sceneMinTotal, rule.sceneMaxTotal],
      scale: Math.round(scale * 100) / 100,
      shotCount: indices.length,
      hint: '老路径轴4.5 场景Σ密度区间 —— V4 路径自动拉伸/压缩 (老路径是抛错重试, 这里改成自动修正)',
    })
  }

  // ── 阶段 2: Σ 收敛 (钩子镜豁免)  [R2]
  const converged = convergeShotDurations(
    shots.map(sp => sp.duration ?? VIDEO_MIN_DURATION),
    episodeTargetSeconds,
    (idx) => (typeof shots[idx].scene_id === 'number'
      ? isCliffhangerScene(shots[idx].scene_id as number, sceneMap)
      : false),
    // ★ Sprint 47 T5: 台词 floor 是收敛的硬下界 —— 缩放不得把某镜压到装不下台词
    dialogueFloors,
  )
  shots.forEach((sp, i) => { sp.duration = converged[i] })

  // ── 阶段 3: 复查场景 Σ 有没有又被收敛压出密度区间 ──
  //   阶段 1.5 把场景 Σ 拉到区间里, 但阶段 2 的整集 Σ 收敛会按比例缩回来, 可能把场景 Σ 压出区间。
  //   老路径也是这个顺序 (轴4.5 校验 → Σ 收敛), 强行反过来会破坏 episode target 收敛,
  //   所以这里【不强制改】, 只告警让这事可见 —— 静默覆盖的话用户会以为密度规则生效了, 实际没有。
  for (const [sceneId, indices] of sceneGroups) {
    const adj = sceneAdjusted.get(sceneId)
    if (!adj) continue
    const fn = shots[indices[0]]?.intent_function || intentionByScene.get(sceneId)
    const density = (fn && INTENTION_TEMPLATES[fn as DramaticFunctionKey]?.shotDensity) || 'medium'
    const rule = SCENE_DENSITY_RULES[density as DensityTier]
    if (!rule) continue
    const total = indices.reduce((a, i) => a + (shots[i].duration || 0), 0)
    if (total >= rule.sceneMinTotal && total <= rule.sceneMaxTotal) continue
    logTaskWarn('ShotDuration', 'scene-sum-clipped-by-global-converge', {
      sceneId,
      density,
      total,
      targetRange: [rule.sceneMinTotal, rule.sceneMaxTotal],
      adjustedTo: adj.after,
      convergedTo: total,
      hint: '场景 Σ 被整集 Σ 收敛压出了密度区间 —— 老路径同样是这个顺序 (轴4.5 → Σ 收敛), 只能靠调 episode target 解决',
    })
  }

  const convergedTotal = converged.reduce((a, b) => a + b, 0)

  // ★ Sprint 47 T5 (PM msg-20261115-188): 目标时长【对齐实际】
  //   PM D2: 台词 floor 之和超过目标时长时, 允许整集变长 (target 跟着台词涨), 而不是压台词
  //   回写后: 用户看到的是真实值; 下次重跑用同一个目标 (一致)
  alignEpisodeTargetDuration(episodeId, convergedTotal, episodeTargetSeconds, dialogueFloors)

  return convergedTotal
}

/**
 * ★ Sprint 47 T5 (PM msg-20261115-188): 把收敛后的【实际总时长】回写到剧集目标时长字段。
 *
 * 【为什么】
 *   · PM D2 (用户 2026-11-15 拍板): "target 允许跟着台词涨" —— 台词 floor 挡住压缩时, 整集变长是正确结果,
 *     那目标时长就不能还停在旧值 (否则用户看到的和实际的不一样, 下次重跑也会打架)。
 *   · 差值要【可见】: 超出目标的部分写进 flow-log (不静默)。
 *
 * @param actualTotal 收敛后的实际 Σ (秒)
 * @param targetBefore 收敛前用的目标 (秒)
 * @param dialogueFloors 各镜台词 floor (只用于日志里说明超出是被台词撑出来的)
 */
export function alignEpisodeTargetDuration(
  episodeId: number,
  actualTotal: number,
  targetBefore: number,
  dialogueFloors: number[] = [],
): { updated: boolean; newTarget: number; overBy: number } {
  const newTarget = Math.max(1, Math.round(actualTotal))
  const overBy = Math.round((actualTotal - targetBefore * EPISODE_TARGET_TOLERANCE) * 100) / 100
  const floorsSum = dialogueFloors.reduce((a, b) => a + b, 0)
  // ★ 只【涨】不【跌】: 目标时长是"这一集允许有多长"的上限,
  //   跌下去会让内容变短时被上一次的旧值压住 (目标越缩越小)。
  //   涨上去 = 台词 floor 撑出来的长度 (PM D2: target 允许跟着台词涨) → 下次重跑不会被压回去。
  const updated = newTarget > targetBefore
  try {
    if (updated) {
      db.update(schema.episodes)
        .set({ targetDuration: newTarget, updatedAt: new Date().toISOString() })
        .where(eq(schema.episodes.id, episodeId)).run()
    }
  } catch (err: any) {
    logTaskWarn('ShotDuration', 'episode-target-align-write-fail', {
      episodeId, error: err?.message || String(err),
    })
  }
  logTaskProgress('ShotDuration', 'episode-target-aligned', {
    episodeId, targetBefore, actualTotal, newTarget, overBy, floorsSum,
    hint: overBy > 0
      ? '台词 floor 挡住了压缩 → 整集按台词变长 (PM D2: target 允许跟着台词涨)'
      : (updated ? '目标时长已上调到实际总时长' : '实际总时长没超过目标 → 目标时长不动 (只涨不跌)'),
  })
  if (overBy > 0) {
    logTaskWarn('ShotDuration', 'episode-target-exceeded-by-dialogue-floor', {
      episodeId, targetBefore, allowed: targetBefore * EPISODE_TARGET_TOLERANCE, actualTotal, overBy, floorsSum,
      hint: '★ 台词装不下 → 不压台词, 整集变长 (用户 2026-11-15 拍板: target 允许跟着台词涨)',
    })
  }
  return { updated, newTarget, overBy }
}

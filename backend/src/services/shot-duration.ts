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
  VIDEO_MIN_DURATION,
  VIDEO_MAX_DURATION,
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

export { VIDEO_MIN_DURATION, VIDEO_MAX_DURATION }

/**
 * 五因子粒度模型 → candidate duration (秒)  [R1]
 *  factor-1: 景别 baseline (getBaselineFor)
 *  factor-2: 密度系数 (getDensityScale from intentTemplate.durationCoefficient)
 *  factor-4: 运镜速度系数 (getMoveScale from sp.movement)
 *  → baseline.min × density × move
 *  factor-3: dialogueFloor = ceil(对白字数 / 4.5) + 1
 *  → candidate = max(floor, scaled)
 *  P3: 短对白 (<10字) 压缩到 ≤ 8s
 *  最终: [VIDEO_MIN_DURATION, VIDEO_MAX_DURATION] clamp
 */
export function computeShotDuration(
  sp: { shot_type: string; dialogue?: string; movement?: string },
  intentTemplate: { durationCoefficient?: number; shotDensity?: string } | undefined,
  // Step 3.G: scene-classifier 标记 climax 时应用 CLIMAX_BONUS_COEFFICIENT,
  // 让该 scene 所有镜头延长 (但不破坏 intent-template 快慢节奏 + 不突破 VIDEO_MAX=15)
  sceneTag: SceneTag = 'normal',
): number {
  const baseline = getBaselineFor(sp.shot_type)
  const densityScale = intentTemplate?.durationCoefficient ?? FALLBACK_DENSITY_SCALE
  const moveScale = getMoveScale(sp.movement)
  // 对白按 char count (去空白), 中文 4.5 字/秒常识
  const dialogueChars = (sp.dialogue || '').replace(/\s/g, '').length
  const scaled = baseline.min * densityScale * moveScale
  const floor = computeDialogueFloor(dialogueChars)
  let candidate = Math.max(floor, scaled)
  // Step 3.G: climax bonus (scene-classifier 3-vote 标记 climax 时)
  //   1.3x 乘到 candidate, 让该 scene 镜头延长落点时间.
  //   Σ 收敛时 climax 镜相对延长比例 1.3:1 仍保留 (绝对时长会被 Σ 缩, 但相对节奏稳).
  if (sceneTag === 'climax') {
    candidate *= CLIMAX_BONUS_COEFFICIENT
  }
  // P3: 短对白压缩 (< 10 字 → ≤ 8s, 避免空转)
  if (dialogueChars > 0 && dialogueChars < SHORT_DIALOGUE_THRESHOLD) {
    candidate = Math.min(candidate, SHORT_DIALOGUE_MAX)
  }
  return Math.round(candidate)
}

/**
 * 钩子保留 (O3)  [R3]
 *  idx=0 → HOOK_OPENING_MIN (3s, 开场钩子)
 *  idx=last → HOOK_CLIFFHANGER_MIN (10s, 仅 cliffhanger) 或 HOOK_CLOSING_MIN (8s)
 *  其他 → 0 (不强制)
 */
export function getHookMin(idx: number, total: number, isCliffhanger: boolean): number {
  if (idx === 0) return HOOK_OPENING_MIN
  if (idx === total - 1) {
    return isCliffhanger ? HOOK_CLIFFHANGER_MIN : HOOK_CLOSING_MIN
  }
  return 0
}

/**
 * 场景过渡 bonus (O2)  [R3]
 *  每个 scene 第一个镜 +0.5s (观众认知切换需要缓冲)
 */
export function applySceneTransitionBonus(candidate: number, isFirstInScene: boolean): number {
  return isFirstInScene ? candidate + SCENE_TRANSITION_BONUS : candidate
}

/**
 * scene 内第一镜索引集合 (Phase 2 C, 用于场景过渡 bonus)  [R3]
 *  shot_plan 按 shot_number 顺序, 同一 scene_id 第一次出现算 first
 */
export function buildFirstInSceneIndices(
  shot_plan: Array<{ scene_id: number }>
): Set<number> {
  const seenScenes = new Set<number>()
  const firstIndices = new Set<number>()
  shot_plan.forEach((sp, i) => {
    if (!seenScenes.has(sp.scene_id)) {
      seenScenes.add(sp.scene_id)
      firstIndices.add(i)
    }
  })
  return firstIndices
}

/**
 * cliffhanger 判定  [R3]
 *  检查 scene 的 intention.function 字段是否命中 CLIFFHANGER_TAGS
 *  scene.intention 不存在 → false (无 cliffhanger)
 *  Phase 3: lib/scene-classifier.ts 会加 fallback 推断 (结构位置后 30% + description 冲突词 + 场景对峙)
 */
export function isCliffhangerScene(
  sceneId: number,
  sceneMap: Map<number, { intention?: { function?: string } | null }>
): boolean {
  const fn = sceneMap.get(sceneId)?.intention?.function
  return fn ? CLIFFHANGER_TAGS.includes(fn as typeof CLIFFHANGER_TAGS[number]) : false
}

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
 * Σ 收敛 (Phase 2 C)  [R2]
 *  当 Σ > target × tolerance, 按比例缩放非钩子镜头
 *  钩子镜 (idx=0, idx=last 且 cliffhanger) 强制 >= hookMin 不被缩
 *  返回新的 durations 数组 (新数组, 不修改入参)
 *
 *  QA ISSUE-002 (msg-20260920-006) 修复保留: 缩放后非钩子镜必须 >= VIDEO_MIN_DURATION=4,
 *  否则会违反 H3 硬约束 (EP=5 Σ=258s scale≈0.43 大概率触发)。
 */
export function convergeShotDurations(
  durations: number[],
  episodeTargetSeconds: number,
  isCliffhanger: (idx: number) => boolean,
): number[] {
  const total = durations.reduce((a, b) => a + b, 0)
  const maxAllowed = episodeTargetSeconds * EPISODE_TARGET_TOLERANCE
  if (total <= maxAllowed) return durations.slice()  // 不超, 不缩
  const scale = maxAllowed / total
  return durations.map((d, i) => {
    const hookMin = getHookMin(i, durations.length, isCliffhanger(i))
    if (hookMin > 0) return Math.max(d, hookMin)  // 钩子镜不缩
    // QA ISSUE-002 (msg-20260920-006): 之前用 Math.max(1, ...) 兜底, 缩放后非钩子镜可能跌到 1-3s
    //   违反 H3 VIDEO_MIN_DURATION=4 硬约束. EP=5 Σ=258s scale≈0.43 大概率触发.
    //   修复: 兜底用 VIDEO_MIN_DURATION=4, 钩子镜仍保留 hook_min 不被缩
    return Math.max(VIDEO_MIN_DURATION, Math.round(d * scale))
  })
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
  const SCENE_DENSITY_RULES = {
    high:   { minMirror: 3, sceneMinTotal: 10, sceneMaxTotal: 25 },
    medium: { minMirror: 5, sceneMinTotal: 15, sceneMaxTotal: 35 },
    low:    { minMirror: 8, sceneMinTotal: 25, sceneMaxTotal: 50 },
  } as const
  type DensityTier = keyof typeof SCENE_DENSITY_RULES

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

    // 拉伸时保 VIDEO_MAX, 压缩时保 VIDEO_MIN
    let after = 0
    indices.forEach((i) => {
      const cur = shots[i].duration || 0
      let next = Math.round(cur * scale)
      if (scale < 1) next = Math.max(VIDEO_MIN_DURATION, next)
      else next = Math.min(VIDEO_MAX_DURATION, next)
      shots[i].duration = next
      after += next
    })
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
  )
  shots.forEach((sp, i) => { sp.duration = converged[i] })

  return converged.reduce((a, b) => a + b, 0)
}

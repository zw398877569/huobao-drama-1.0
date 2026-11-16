/**
 * ★ Sprint 47 T5 (PM msg-20261115-188): 时长链的【纯逻辑】部分 (不碰 DB → 可离线断言)
 *
 *   从 services/shot-duration.ts 拆出来 —— 那一半要查 DB (episodes/scenes/storyboards),
 *   打包离线跑不起来; 这里全是纯函数, 便于逐条断言:
 *   · 五因子估算 (computeShotDuration) / 钩子与场景 bonus / 场景密度规则
 *   · ★ 收敛硬下界 (convergeShotDurations 带台词 floor) / 场景压缩不破 floor (scaleShotDurations)
 *
 *   ★ 台词 floor 的【唯一口径】在 constants/shot-type-baseline.ts:
 *     computeEffectiveDialogueFloor(countDialogueChars(dialogue)) —— 收敛下界 (T5) 与拆解校验 (T9) 共用
 */
import {
  getBaselineFor,
  getMoveScale,
  FALLBACK_DENSITY_SCALE,
  computeDialogueFloor,
  SHORT_DIALOGUE_THRESHOLD,
  SHORT_DIALOGUE_MAX,
  VIDEO_MIN_DURATION,
  VIDEO_MAX_DURATION,
  computeEffectiveDialogueFloor,
  countDialogueChars,
  HOOK_OPENING_MIN,
  HOOK_CLOSING_MIN,
  HOOK_CLIFFHANGER_MIN,
  CLIFFHANGER_TAGS,
  SCENE_TRANSITION_BONUS,
  EPISODE_TARGET_TOLERANCE,
  CLIMAX_BONUS_COEFFICIENT,
} from '../constants/shot-type-baseline.js'
import { INTENTION_TEMPLATES, type DramaticFunctionKey } from '../agents/director-intent-templates.js'
import type { SceneTag } from '../lib/scene-classifier.js'

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
  // ★ Sprint 47 T5 (PM msg-20261115-188): 每镜的【台词 floor】(硬下界)。
  //   ★ 不传 = 老行为 (逐字一致, 零回归); 传了 = 缩放不得把某镜压到它自己的台词 floor 以下。
  //   ★ 台词可以少, 镜头不能少 → floor 之和超过 target 时整集允许变长 (PM D2), 不压台词。
  dialogueFloors: number[] = [],
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
    // ★ Sprint 47 T5: 再叠加【台词 floor】硬下界 —— 缩放不得把某镜压到装不下台词
    //   (64 字台词算出 floor=15, 被压到 6s → 台词念到一半没了, 字幕时间轴也超出音轨)
    const floor = Math.max(VIDEO_MIN_DURATION, dialogueFloors[i] ?? 0)
    return Math.max(floor, Math.round(d * scale))
  })
}

// ── 场景 Σ 密度区间 (Sprint 17 Task F④, 老路径 轴4.5) ──
//   ★ Sprint 47 T5: 提到模块级并导出 —— 离线断言/重跑模拟要用【同一份】规则, 别复制一份
export const SCENE_DENSITY_RULES = {
  // ★ Sprint 48 T1 (PM msg-20261116-194): 【场景 Σ 上限】放宽 —— 这是"台词被截断"的直接诱因。
  //   旧上限 (25/35/50) 决定的容量: ep21 有 5 个场景 → 容量上限 5×50 = 250 秒,
  //   而 1044 字台词需要 ~232 秒纯对白 → 几乎卡死 → LLM 为了满足规则就把台词截短。
  //   新上限按【容量】推导 (PM 口径: 68 镜 × ~5 秒 = 340 秒, 5~7 个场景 → 每场景 50~80 秒):
  //     high 70 / medium 80 / low 90 → 5 个场景至少装得下 350~450 秒
  //   ★ 【单镜下限】与【场景 Σ 下限】不变 (那是节奏规则, 不是容量规则)
  //   ★ 不得低于改写阶段的"每场景 30-60 秒"上限 (两个模块口径必须一致, 否则又打架)
  high:   { minMirror: 3, sceneMinTotal: 10, sceneMaxTotal: 70 },
  medium: { minMirror: 5, sceneMinTotal: 15, sceneMaxTotal: 80 },
  low:    { minMirror: 8, sceneMinTotal: 25, sceneMaxTotal: 90 },
} as const
export type DensityTier = keyof typeof SCENE_DENSITY_RULES

/**
 * ★ Sprint 47 T5 (PM msg-20261115-188): 场景 Σ 缩放时单镜的下界/上界 (纯函数 → 可离线断言)。
 *
 *   · 压缩 (scale<1): 下界 = max(VIDEO_MIN_DURATION, 该镜台词 floor) —— ★ 台词装不下就不能压
 *   · 拉伸 (scale>1): 上界 = VIDEO_MAX_DURATION (平台硬约束)
 *   · 不传 floors = 老行为 (逐字一致, 零回归)
 */
export function scaleShotDurations(
  durations: number[],
  scale: number,
  floors: number[] = [],
): number[] {
  return durations.map((d, i) => {
    let next = Math.round(d * scale)
    const floor = Math.max(VIDEO_MIN_DURATION, floors[i] ?? 0)
    if (scale < 1) next = Math.max(floor, next)
    else next = Math.min(VIDEO_MAX_DURATION, next)
    return next
  })
}


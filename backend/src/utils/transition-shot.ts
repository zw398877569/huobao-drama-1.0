/**
 * ★ Sprint 33 T2 (PM msg-20261103-140): 过渡镜的校验层后处理 (纯函数, 便于离线断言)。
 *
 * 三件事:
 *   ① 过渡镜 duration 【强制 2s】—— 不靠 LLM 给 (LLM 可能给 2.5 / 3, 而平台侧本来也会 Math.floor)
 *   ② shot_number 连续 1..N —— 加了过渡镜后 N 变大了, LLM 容易跳号。
 *      ★ 只在【检测到不连续】时才重编号 → 正常情况逐字不变 (老剧集零回归)。
 *   ③ total_duration = 成片真实总长 (主体 Σ + 过渡镜 Σ)。
 *      ★ 只在【有过渡镜】时才重算 → 没有过渡镜的剧集, total_duration 保持 LLM 原值 (零回归)。
 *
 * 为什么单独成文件: 这段是本单最容易出静默 bug 的地方 (过渡镜无声消失 / 时长被 LLM 带偏),
 *   抽成纯函数才能用 mock plan 离线断言, 不必真跑一次 LLM。
 */

/** 过渡镜时长 —— 由代码层强制, 不靠 LLM (PM 拍板 D3) */
export const TRANSITION_DURATION = 2

/** 该镜是不是过渡镜 */
export function isTransitionShot(shot: { is_transition?: boolean | null } | null | undefined): boolean {
  return shot?.is_transition === true
}

/** step1 的 plan 项 (只要用到的字段) */
export interface TransitionPlanItem {
  shot_number: number
  duration: number
  is_transition?: boolean | null
  transition_kind?: 'space' | 'character_entry' | null
  [k: string]: unknown
}

/**
 * ★ Sprint 33 T3 (PM msg-20261103-140): 从 step1_plan 建【shot_number → 过渡镜标记】的映射。
 *   step3 用它反查回填 (不透传给 step2 LLM, 也不靠 step2 复述)。
 *   抽成纯函数 → 能用 mock plan 离线断言, 不必真跑一次 LLM。
 */
export function buildTransitionMap(
  plan: Array<{ shot_number?: number; is_transition?: boolean | null; transition_kind?: string | null }> | null | undefined,
): Map<number, { isTransition: boolean; kind: 'space' | 'character_entry' | null }> {
  const map = new Map<number, { isTransition: boolean; kind: 'space' | 'character_entry' | null }>()
  for (const item of plan || []) {
    if (!item || typeof item.shot_number !== 'number') continue
    map.set(item.shot_number, {
      isTransition: item.is_transition === true,
      kind: item.transition_kind === 'space' || item.transition_kind === 'character_entry'
        ? item.transition_kind
        : null,
    })
  }
  return map
}

/**
 * step1 结果的后处理: 过渡镜 2s 强制 + shot_number 连续 + total_duration 重算。
 *
 * ★ 没有过渡镜 → 原样返回 (一个字段都不改) —— 老剧集拆解产出与改动前逐字一致。
 */
export function normalizeTransitionPlan<T extends { shot_plan: TransitionPlanItem[]; total_duration: number }>(
  result: T,
): T {
  const plan = Array.isArray(result?.shot_plan) ? result.shot_plan : []
  const hasTransition = plan.some(isTransitionShot)
  if (!hasTransition) return result

  // ① 过渡镜 duration 强制 2s
  let shot_plan = plan.map(s => (isTransitionShot(s) ? { ...s, duration: TRANSITION_DURATION } : s))

  // ② shot_number 连续 1..N (只有不连续时才重编号)
  const continuous = shot_plan.every((s, i) => s.shot_number === i + 1)
  if (!continuous) shot_plan = shot_plan.map((s, i) => ({ ...s, shot_number: i + 1 }))

  // ③ total_duration = 成片真实总长 (主体 Σ + 过渡镜 Σ)
  const total_duration = shot_plan.reduce((a, s) => a + (Number(s.duration) || 0), 0)

  return { ...result, shot_plan, total_duration }
}

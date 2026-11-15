/**
 * ★ Sprint 47 单 189 (PM msg-20261115-189): 剧情目的回填的纯逻辑 (不碰 DB → 可离线断言)
 */

/** 从 planning_data 里抽 shot_number → intent_function 映射 */
/** 从 planning_data 里抽 shot_number → intent_function 映射 */
export function extractIntentMap(planningData: string | null | undefined): Map<number, string> {
  const map = new Map<number, string>()
  if (!planningData) return map
  let parsed: any
  try {
    parsed = JSON.parse(planningData)
  } catch {
    return map
  }
  // step2_details (信息最全) 优先, step1_plan 兜底
  const lists = [parsed?.step2_details, parsed?.step1_plan].filter(Array.isArray)
  for (const list of lists) {
    for (const item of list) {
      const num = Number(item?.shot_number)
      const fn = String(item?.intent_function || '').trim()
      if (!Number.isFinite(num) || !fn) continue
      if (!map.has(num)) map.set(num, fn)
    }
  }
  return map
}

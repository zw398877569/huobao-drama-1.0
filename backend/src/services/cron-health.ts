/**
 * ★ Sprint 57 T2-A (PM msg-20261123-226): cron 调度健康度计算 —— ★ 纯函数, 零依赖, 可离线断言
 *
 * 问题: /tasks 看板只能回答「跑过几次、成功率多少」→ 回答不了「本该跑几次、漏了几次」
 *   → 定时器连续死掉一周, 看板仍然 100% 绿色 (因为老记录没有 source, 手动跑和定时跑混在一起)。
 *
 * ★ 口径 (PM 拍板):
 *   应跑 N = 该任务当天(Asia/Shanghai) 按 cron_schedules 档位表应有的条数
 *   实跑 M = 当天 status=success 且【明确的定时跑】的条数
 *   漏跑 K = max(0, N - M)
 * ★ 时区一律 Asia/Shanghai (跨天档位 22:45/00:45 按 UTC 会算错一天)
 * ★ source 缺失的老记录算 unknown → 【不计入实跑】(宁可显示漏跑也不虚报全绿)
 * ★ manual (手动 kickstart) 也不计入实跑 —— 否则调试跑会把定时覆盖率刷高, 正是这次的现象。
 *
 * ★★ Sprint 57 返工 (PM msg-20261126-239) —— 上面这套口径在【当天有定时跑】的日子里是错的:
 *   ① 每个任务的数字必须只来自【该任务自己】的记录 (之前把当天全部 runs 传给每个任务
 *      → 四个任务 actual/bySource 完全相同, 跟该任务跑没跑无关)
 *   ② actual = 【命中的去重档位数】(同档位跑多次只算 1 次) → actual <= expected 恒成立
 *      重复次数另设 duplicateRuns 可查, 【不混进 actual】
 *   ③ missing = expected - actual (【不 clamp 成 0】) → 恒 >= 0 且恒 === missedSlots.length
 *      (以前 clamp 成 0 → 卡片写"漏跑 0"却并列列着 7 个漏掉的档位)
 *   ④ 归属日只看【实际执行时间 startedAt (Asia/Shanghai)】; slot 字符串里的日期前缀
 *      【不决定命中哪一天】, 只做一致性校验 —— 与实际执行日期不一致的记录【不算命中】
 */

/** 一次运行(精简) —— 只需要这几个字段 */
export interface CronRunLite {
  /** ★ 任务名 —— 必须按它归属, 否则每个任务都会吃到当天【全部】任务的记录 */
  name?: string | null
  status?: string | null
  source?: string | null
  slot?: string | null
  startedAt?: number | null
}

/** source 的三个取值 */
export type CronSource = 'scheduled' | 'manual' | 'unknown'

/** 把 source 归一 (没传/不认识 → unknown) */
export function normalizeSource(raw: unknown): CronSource {
  if (raw === 'scheduled') return 'scheduled'
  if (raw === 'manual') return 'manual'
  return 'unknown'
}

/** 逗号分隔的档位串 → 数组 (去掉空项) */
export function parseSlots(csv: string | null | undefined): string[] {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 档位 key: '2026-11-25_2315' */
export function slotKey(date: string, hhmm: string): string {
  return `${date}_${hhmm}`
}

/** 某一天(Asia/Shanghai)的 [start, end) 毫秒区间 —— 跟 cron.ts 里现有的口径一致 */
export function dayRange(date: string): { start: number; end: number } {
  const start = new Date(`${date}T00:00:00+08:00`).getTime()
  if (!Number.isFinite(start)) return { start: 0, end: 0 }
  return { start, end: start + 86400000 }
}

export interface TaskHealth {
  taskName: string
  /** 该任务当天的档位 (HHMM) */
  slots: string[]
  /** 应跑 N */
  expected: number
  /** ★ 该任务当天命中的【去重档位数】(同一档位跑多次只算 1 次) → 恒 <= expected */
  actual: number
  /** ★ = expected - actual (恒 >= 0, 且恒等于 missedSlots.length) */
  missing: number
  /** ★ 该任务自己的记录按来源分桶 */
  bySource: { scheduled: number; manual: number; unknown: number }
  /** 该任务档位表里, 当天被命中的 */
  hitSlots: string[]
  /** 该任务档位表里, 当天没命中的 */
  missedSlots: string[]
  /** ★ 同一档位当天跑多次, 多出来的次数 (可查, 但不混进 actual) */
  duplicateRuns: number
  /** 跑了但失败的档位 (定时跑 + 非 success → 不占档位, 单列可查) */
  failedSlots: string[]
  /** 定时跑了但档位不在该任务档位表里 (排查用) */
  offGridRuns: number
  /** 定时跑了但没上报 slot → 不计入实跑 (排查用) */
  slotlessRuns: number
  /** ★ slot 里的日期 ≠ 实际执行日 → 记录自相矛盾, 不算命中 (排查用) */
  mismatchedSlotRuns: number
}

/** slot 里取 HHMM 部分 ('2026-11-25_2315' → '2315'); ★ 日期前缀只作冗余信息, 不参与归属判断 */
export function slotHhmm(slot: string | null | undefined): string | null {
  const s = String(slot || '').trim()
  if (!s) return null
  const m = s.match(/(\d{4})$/)
  if (!m) return null
  const hh = Number(m[1].slice(0, 2))
  const mm = Number(m[1].slice(2))
  if (hh > 23 || mm > 59) return null
  return m[1]
}

/** slot 里的日期前缀 ('2026-11-25_2315' → '2026-11-25'); 没有日期前缀 → null */
export function slotDate(slot: string | null | undefined): string | null {
  const m = String(slot || '').trim().match(/^(\d{4}-\d{2}-\d{2})_/)
  return m ? m[1] : null
}

/** startedAt 在 Asia/Shanghai 的 HHMM (记录没上报 slot 时的兜底展示用) */
export function hhmmOfTs(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000)
  return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
}

/**
 * 算某个任务在某天的调度健康度 —— ★ 纯函数 (入参 → 出参, 无副作用, 可离线断言)
 *
 * ★ 2026-11-26 返工修正 (单 239):
 *   ① 只算【该任务自己】的记录 (之前把当天全部 runs 传给每个任务 → 四个任务 actual 全一样)
 *   ② actual = 【去重后的命中档位数】(同档位跑多次只算 1 次) → actual <= expected 恒成立
 *   ③ missing = expected - actual, 恒 >= 0 且恒等于 missedSlots.length (不再静默 clamp 成 0)
 *   ④ 命中哪一天以【实际执行时间 startedAt (Asia/Shanghai)】为准, slot 里的日期前缀不参与判断
 *      (slot 日期与实际执行日不一致 → 记录自相矛盾 → 不算命中, 只计入 mismatchedSlotRuns)
 *   ⑤ 实跑 = 【定时跑 + 成功】; 跑了但失败 → failedSlots (不占档位); 没上报 slot → slotlessRuns
 *
 * @param date   YYYY-MM-DD (Asia/Shanghai 的日历日)
 * @param slots  该任务当天的档位 (HHMM 数组)
 * @param runs   当天的运行记录 (可多给, 内部按 name + startedAt 过滤)
 */
export function computeTaskHealth(
  taskName: string,
  slots: string[],
  runs: CronRunLite[],
  date: string,
): TaskHealth {
  const { start, end } = dayRange(date)
  const bySource = { scheduled: 0, manual: 0, unknown: 0 }
  const hitCount = new Map<string, number>()
  const failed = new Set<string>()
  const slotSet = new Set(slots)
  let offGridRuns = 0
  let slotlessRuns = 0
  let mismatchedSlotRuns = 0

  for (const r of runs || []) {
    // ★ ① 只算该任务自己的记录
    if (!r || r.name !== taskName) continue
    const ts = typeof r.startedAt === 'number' ? r.startedAt : null
    // ★ ④ 归属哪一天 = 实际执行时间 (startedAt, Asia/Shanghai); slot 里的日期串不参与
    if (ts == null || ts < start || ts >= end) continue
    const src = normalizeSource(r.source)
    bySource[src]++
    if (src !== 'scheduled') continue
    // 档位: 必须上报 slot (没上报 → 不计入实跑, 但计数可查)
    const hhmm = slotHhmm(r.slot)
    if (!hhmm) { slotlessRuns++; continue }
    // ★ slot 里的日期前缀【不决定归属哪一天】(归属日只看 startedAt), 只做一致性校验:
    //   slot 日期 ≠ 实际执行日 → 这条记录自相矛盾 → 不得算作命中 (PM 单 239 口径/AC5)
    const sDate = slotDate(r.slot)
    if (sDate && sDate !== date) { mismatchedSlotRuns++; continue }
    if (!slotSet.has(hhmm)) { offGridRuns++; continue }
    // 实跑 = 【定时跑 + 成功】(沿用 226 口径): 跑了但失败 → 记 failedSlots, 不占档位
    if (r.status !== 'success') { failed.add(hhmm); continue }
    hitCount.set(hhmm, (hitCount.get(hhmm) || 0) + 1)
  }

  const hitSlots = [...hitCount.keys()]
  const hitSet = new Set(hitSlots)
  const missedSlots = slots.filter((s) => !hitSet.has(s))
  const expected = slots.length
  const actual = hitSlots.length          // ★ 去重后的命中档位数
  const missing = expected - actual     // ★ 不 clamp; 恒 >= 0 且恒 == missedSlots.length
  let duplicateRuns = 0
  for (const n of hitCount.values()) if (n > 1) duplicateRuns += n - 1
  return {
    taskName, slots, expected, actual, missing, bySource,
    hitSlots, missedSlots, duplicateRuns,
    failedSlots: [...failed],
    offGridRuns,
    slotlessRuns,
    mismatchedSlotRuns,
  }
}

/**
 * ★ 一次性算多个任务 (按 cron_schedules 的 task_name 顺序) —— 纯函数
 */
export function computeAllTaskHealth(
  schedules: { taskName: string; slots: string }[],
  runs: CronRunLite[],
  date: string,
): TaskHealth[] {
  return (schedules || []).map((s) =>
    computeTaskHealth(s.taskName, parseSlots(s.slots), runs, date))
}

/**
 * ★ 正式任务名 → 【不允许被 DELETE /runs 删掉】(防手滑删掉真实调度记录)
 *   只有测试/探针类 name (array-retest / probe-test / log-test ...) 能删。
 */
export const PROTECTED_TASK_NAMES = [
  'dailylearn',
  'minimaxlearn',
  'videounderstand',
  'face-archive',
  'codex-slim',
  'model-monitor',
  'daily-hot-list',
]

/** 这个 name 是不是受保护的正式任务 (精确匹配 或 以前缀/子串形式出现) */
export function isProtectedTaskName(name: string): boolean {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return false
  return PROTECTED_TASK_NAMES.some((p) => n === p || n.includes(p) || n.startsWith(`${p}-`) || n.endsWith(`-${p}`))
}

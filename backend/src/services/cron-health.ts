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
 */

/** 一次运行(精简) —— 只需要这几个字段 */
export interface CronRunLite {
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
  /** 实跑 M (success 且 source=scheduled) */
  actual: number
  /** 漏跑 K */
  missing: number
  /** 按来源分桶 (scheduled / manual / unknown) —— 看板上要显示来源列 */
  bySource: { scheduled: number; manual: number; unknown: number }
  /** 当天按档位命中的实跑 (key = '2026-11-25_2315') */
  hitSlots: string[]
  /** 当天应跑但没跑到的档位 */
  missedSlots: string[]
}

/**
 * 算某个任务在某天的调度健康度 —— ★ 纯函数 (入参 → 出参, 无副作用, 可离线断言)
 * @param date   YYYY-MM-DD (Asia/Shanghai 的日历日)
 * @param slots  该任务当天的档位 (HHMM 数组)
 * @param runs   当天的运行记录 (可以多给, 内部按 startedAt 过滤)
 */
export function computeTaskHealth(
  taskName: string,
  slots: string[],
  runs: CronRunLite[],
  date: string,
): TaskHealth {
  const { start, end } = dayRange(date)
  const bySource = { scheduled: 0, manual: 0, unknown: 0 }
  const hitSlots = new Set<string>()
  let actual = 0

  for (const r of runs || []) {
    const ts = typeof r?.startedAt === 'number' ? r.startedAt : null
    if (ts == null || ts < start || ts >= end) continue
    const src = normalizeSource(r?.source)
    if (src === 'scheduled') {
      bySource.scheduled++
      if (r?.status === 'success') {
        actual++
        // 命中了哪个档位 (slot 形如 '2026-11-25_2315')
        const slot = String(r?.slot || '')
        const hhmm = slot.includes('_') ? slot.split('_')[1] : ''
        if (hhmm) hitSlots.add(hhmm)
      }
    } else if (src === 'manual') {
      bySource.manual++
    } else {
      bySource.unknown++
    }
  }

  const expected = slots.length
  const missing = Math.max(0, expected - actual)
  const missedSlots = slots.filter((s) => !hitSlots.has(s))
  return {
    taskName,
    slots,
    expected,
    actual,
    missing,
    bySource,
    hitSlots: [...hitSlots],
    missedSlots,
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

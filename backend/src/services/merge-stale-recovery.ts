/**
 * ★ Sprint 40 追加单 174 (PM msg-20261113-174): 僵死 merge 记录回收
 *
 * 【问题】服务重启 / 崩溃 / 被 Portainer 重启 → 正在跑的拼接进程被杀 → 那条 merge 记录
 *   永远停在 processing →
 *     ① 拼接导出区永远显示『拼接中...』, 按钮禁用
 *     ② 后端去重把它当成『有人在处理』→ 再点【重新拼接】也不起新任务
 *     ③ 死锁: 用户在这集上再也拼不了, 只能手工改数据库。
 *
 * 【两层回收】
 *   ① **启动时回收**（最安全, 覆盖用户实际遇到的『重新部署服务』场景）:
 *      服务刚起来时不可能有正在跑的拼接 → 所有 processing/pending 一律判死。
 *   ② **运行中超时兜底**: 一条 processing 超过阈值（默认 30 分钟）→ 判死 → 回收,
 *      之后可以正常起新任务。
 *      ★ 阈值故意放得很宽松 —— 正常拼接 2~5 分钟, 慢的更久。
 *        宁可让用户多等一会儿, 也不能误杀正在跑的（误杀 = 两个 ffmpeg 抢 CPU）。
 *
 * 【幂等】回收只动 status 是 processing/pending 的行 → 重复执行不会把 completed/failed 改坏。
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

/** 僵死判定阈值 (毫秒) —— 正常拼接 2~5 分钟 → 默认 30 分钟; env MERGE_STALE_MS 可调 (下限 1 分钟) */
export const MERGE_STALE_MS = (() => {
  const raw = Number(process.env.MERGE_STALE_MS)
  if (Number.isFinite(raw) && raw >= 60_000) return raw
  return 30 * 60 * 1000
})()

export const STALE_REASON_RESTART = '服务重启中断（拼接进程被中断）'
export const STALE_REASON_TIMEOUT = '拼接超时未完成（进程可能被中断），已自动回收'

export interface MergeStatusRow {
  id: number
  status?: string | null
  createdAt?: string | null
}

/**
 * 纯函数: 这条记录是不是已经僵死 (status 是 processing/pending 且超时)。
 * ★ 时间戳解析不出来 → 返回 false (不乱杀, 宁可让用户手工处理)。
 */
export function isStaleMerge(
  row: MergeStatusRow | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = MERGE_STALE_MS,
): boolean {
  if (!row) return false
  const st = row.status
  if (st !== 'processing' && st !== 'pending') return false
  const created = Date.parse(row.createdAt || '')
  if (!Number.isFinite(created)) return false
  return nowMs - created > staleMs
}

/**
 * 回收一条僵死记录 → 标 failed + 写明原因 + completedAt。
 * ★ 幂等: where 带上 status 条件 → 只动 processing/pending, 重复执行不会改坏已完成的记录。
 * @returns true = 真的回收了 (false = 已经被别的流程收走了)
 */
export function recoverStaleMerge(mergeId: number, reason: string): boolean {
  const result = db.update(schema.videoMerges)
    .set({ status: 'failed', errorMsg: reason, completedAt: now() })
    .where(and(
      eq(schema.videoMerges.id, mergeId),
      inArray(schema.videoMerges.status, ['processing', 'pending']),
    ))
    .run()
  return Number((result as any)?.changes ?? 0) > 0
}

/**
 * 启动时回收所有 processing/pending 的 merge 记录。
 * ★ 启动时不可能有正在跑的拼接 → 一律判死 (这是最安全的一层)。
 * @returns 回收条数
 */
export function recoverStaleMergesOnStartup(): number {
  const rows = db.select({ id: schema.videoMerges.id })
    .from(schema.videoMerges)
    .where(inArray(schema.videoMerges.status, ['processing', 'pending']))
    .all()
  if (!rows.length) return 0

  const result = db.update(schema.videoMerges)
    .set({ status: 'failed', errorMsg: STALE_REASON_RESTART, completedAt: now() })
    .where(inArray(schema.videoMerges.status, ['processing', 'pending']))
    .run()
  const n = Number((result as any)?.changes ?? 0)
  logTaskSuccess('MergeTask', 'stale-merges-recovered-on-startup', {
    count: n,
    mergeIds: rows.map(r => r.id),
    reason: STALE_REASON_RESTART,
    hint: '服务重启 → 上一轮被中断的拼接已回收 (页面可以重新拼接了)',
  })
  if (n > 0) logTaskWarn('MergeTask', 'stale-merges-recovered-on-startup-warn', {
    count: n, mergeIds: rows.map(r => r.id),
  })
  return n
}

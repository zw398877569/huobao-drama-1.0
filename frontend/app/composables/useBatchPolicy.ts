/**
 * ★ Sprint 41 (PM msg-20261113-175): 批量操作的共享策略 (并发闸门 + 退避重试)
 *
 * 【为什么要共享】生图批量与配音批量以前是两套口径:
 *   · 生图: scene 分链调度 + 并发上限 3 + 失败重试 1 次 (间隔 10 秒)
 *   · 配音: Promise.allSettled 一次性全发 → 必然撞 RPM, 且失败只弹一句「N 条配音生成失败」
 * → 现在两边用【同一份配置】(同一个 localStorage key / 同一个默认值) 与【同一套重试口径】。
 *
 * 【重试口径】PM 拍板: 首次 + 最多 2 次重试 = 总共 3 次尝试; 3 次都失败 → 标记失败, 交回用户手动重试
 *   (不无限重试、不自动死磕)。
 *   ★ 只重试【可重试】的错误 —— 错误文本里有后端打的【可重试】标记才算
 *     (鉴权失败/参数错误/内容安全拒绝 重试没有意义, 对着它们死磕 3 次纯属浪费)
 *   ★ 只重试【那一个】任务 —— 不整批重跑 (整批重跑会重复扣已经成功那些镜的钱)
 *   ★ 间隔要够覆盖 provider 的维护窗口: 30 秒起步, 递增 (×2), 封顶 120 秒
 *     (原来的 10 秒对『模型维护中』这种几分钟的窗口基本等于没重试)
 */

/** ★ 可重试标记 —— 协议常量 (与 backend/src/services/provider-error-classify.ts 一致;
 *   两个工程没有共享目录, 改的时候两边一起改) */
export const RETRYABLE_MARKER = '[可重试]'

/** 并发上限默认值 (与生图批量原有默认一致) */
export const BATCH_CONCURRENCY_DEFAULT = 3
/** 并发上限的 localStorage key (★ 生图与配音共用这一份配置) */
export const BATCH_CONCURRENCY_KEY = 'huobao.batchShotConcurrency'

/** 总共尝试次数 (首次 + 最多 2 次重试) */
export const BATCH_RETRY_MAX_ATTEMPTS = 3
/** 退避起始间隔 (毫秒) */
export const BATCH_RETRY_BASE_MS = 30_000
/** 退避封顶 (毫秒) —— 别把用户卡住太久 */
export const BATCH_RETRY_MAX_DELAY_MS = 120_000

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** 第 attempt 次失败后要等多久 (attempt 从 1 起: 30s → 60s → 封顶 120s) */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(BATCH_RETRY_MAX_DELAY_MS, BATCH_RETRY_BASE_MS * Math.pow(2, n - 1))
}

/** 错误文本里有没有【可重试】标记 (后端打的) */
export function isRetryableMessage(msg: string | null | undefined): boolean {
  return String(msg || '').includes(RETRYABLE_MARKER)
}

/** 去掉【可重试】标记 (展示给用户时用) */
export function stripRetryableMarker(msg: string | null | undefined): string {
  return String(msg || '').split(RETRYABLE_MARKER).join('').trim()
}

/** 读并发上限 (localStorage; 不可用 → 默认 3) */
export function loadBatchConcurrency(): number {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(BATCH_CONCURRENCY_KEY) : null
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 1 && v <= 8) return Math.floor(v)
  } catch { /* localStorage 不可用 → 用默认 */ }
  return BATCH_CONCURRENCY_DEFAULT
}

/** 存并发上限 (生图与配音共用同一个 key) */
export function saveBatchConcurrency(v: number): number {
  const n = Math.max(1, Math.min(8, Math.floor(Number(v) || BATCH_CONCURRENCY_DEFAULT)))
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(BATCH_CONCURRENCY_KEY, String(n))
  } catch { /* 存不了只是这次不记住 */ }
  return n
}

/**
 * 并发闸门: 同时最多跑 limit 个 (只影响同时在跑的数量, 不影响提交顺序/依赖顺序)。
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const runner = async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      await worker(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: n }, () => runner()))
}

export interface BatchAttemptResult {
  ok: boolean
  /** ★ 是不是【可重试】的错误 (只有 true 才重试) */
  retryable?: boolean
  /** 失败原因分类 (给失败明细展示) */
  reason?: string
  /** provider 原始错误文本 */
  error?: string
}

export interface BatchRetryOutcome {
  ok: boolean
  /** 实际尝试了几次 */
  attempts: number
  /** 最后一次的结果 */
  result: BatchAttemptResult
}

/**
 * 退避重试: 最多 maxAttempts 次尝试, 只重试【可重试】的错误。
 * ★ 每次只重试这一个任务 (调用方自己决定重试哪一条)。
 */
export async function runBatchWithRetry(
  attemptFn: (attempt: number) => Promise<BatchAttemptResult>,
  opts: {
    maxAttempts?: number
    onRetry?: (attempt: number, result: BatchAttemptResult, delayMs: number) => void
    sleepFn?: (ms: number) => Promise<void>
  } = {},
): Promise<BatchRetryOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? BATCH_RETRY_MAX_ATTEMPTS)
  const sleepFn = opts.sleepFn ?? sleep
  let result: BatchAttemptResult = { ok: false }
  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt
    try {
      result = await attemptFn(attempt)
    } catch (e: any) {
      // 抛异常也算一次失败 (但没有 retryable 标记 → 不重试)
      result = { ok: false, retryable: false, error: e?.message || String(e), reason: 'provider 报错' }
    }
    if (result.ok) return { ok: true, attempts, result }
    if (!result.retryable) break                    // 不可重试 → 直接交回
    if (attempt >= maxAttempts) break              // 到次数上限 → 交回 (不无限重试)
    const delay = retryDelayMs(attempt)
    opts.onRetry?.(attempt, result, delay)
    await sleepFn(delay)
  }
  return { ok: false, attempts, result }
}

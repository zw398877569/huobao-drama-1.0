/**
 * ★ Sprint 41 (PM msg-20261113-175) T1: provider 错误的【可重试性】分类
 *
 * 【为什么需要】现有的错误分类只认 HTTP 状态码 (TRANSIENT_STATUS = {408,429,500,502,503,504}),
 *   但 provider 常把临时性故障写在【响应文本】里:
 *     · 生图: 轮询结果里的『模型维护中』/『The model load is too high』
 *     · 配音: HTTP 响应体里的『rate limit exceeded(RPM)』
 *   这类不在状态码表里 → 直接判死 → 下一张依赖它的帧也跟着不提交 → 一整集缺好几镜。
 *
 * ★ **只有这一份关键词表** (生图与配音共用)。前端不另写关键词表 ——
 *   而是靠错误文本里的【可重试标记】判断 (标记由本模块打上)。
 *
 * 【判定原则】宁可漏判也不要误判: 不可重试的关键词【优先】匹配 ——
 *   例: 『参数错误: rate limit 参数不合法』必须判成【不可重试】,
 *   否则会对一个改参数就能解决的错误死磕 3 次。
 */

/** HTTP 状态码层面的临时错误 (沿用原有的口径) */
export const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** 不可重试的特征 (优先匹配): 鉴权/参数/内容安全/欠费 → 重试没有意义 */
export const PERMANENT_ERROR_PATTERNS: string[] = [
  'content_policy', 'content policy', 'safety_violation', 'nsfw', '违规', '敏感内容',
  'unauthorized', 'forbidden', '鉴权', '认证失败', 'invalid api key', 'invalid_api_key',
  'authentication', 'invalid_request', 'invalid request', 'invalid parameter',
  '参数错误', '参数不合法', 'bad request',
  'insufficient balance', 'insufficient_balance', 'quota exceeded', '余额不足', '欠费',
]

/** 可重试的特征 (文本形式): provider 的临时故障 */
export const TRANSIENT_ERROR_PATTERNS: string[] = [
  '模型维护中', '维护中', 'maintenance', 'model load is too high', 'model is busy',
  'overloaded', 'server is busy', 'server busy',
  'rate limit', 'rate_limit', 'too many requests',
  'timeout', 'timed out', 'time out', 'temporarily', 'temporary error', 'try again later',
  'service unavailable', 'bad gateway', 'gateway timeout', 'internal server error',
  'connection reset', 'connection aborted',
]

/**
 * ★ 可重试标记 —— 后端打上前端读 (前端不写关键词表, 只认这个标记)。
 * 协议常量: backend 与 frontend 各存一份 (两个工程没有共享目录), 改的时候两边一起改。
 */
export const RETRYABLE_MARKER = '[可重试]'

export interface ProviderErrorClass {
  /** 值不值得重试 */
  retryable: boolean
  /** 判定依据 (给 flow-log 看) */
  reason: string
  /** 命中的关键词 (没命中为 null) */
  matched: string | null
  /** 命中的不可重试关键词 (命中就一定不可重试) */
  matchedPermanent: string | null
}

/**
 * 判断一条 provider 错误文本 / HTTP 状态是不是【可重试】。
 * ★ 纯函数, 不依赖网络 → 可离线断言。
 */
export function classifyProviderError(
  text: string | null | undefined,
  status?: number | null,
): ProviderErrorClass {
  const lower = String(text || '').toLowerCase()

  // ① 不可重试的关键词优先 (宁可漏判也不要误判)
  for (const p of PERMANENT_ERROR_PATTERNS) {
    if (lower.includes(p)) {
      return {
        retryable: false,
        reason: `不可重试 (命中「${p}」)`,
        matched: p,
        matchedPermanent: p,
      }
    }
  }

  // ② 文本形式的临时错误
  for (const p of TRANSIENT_ERROR_PATTERNS) {
    if (lower.includes(p)) {
      return {
        retryable: true,
        reason: `可重试 (命中「${p}」)`,
        matched: p,
        matchedPermanent: null,
      }
    }
  }

  // ③ 状态码兜底
  if (status != null && TRANSIENT_STATUS.has(status)) {
    return {
      retryable: true,
      reason: `可重试 (HTTP ${status})`,
      matched: null,
      matchedPermanent: null,
    }
  }

  return {
    retryable: false,
    reason: '不可重试 (未命中任何临时错误特征)',
    matched: null,
    matchedPermanent: null,
  }
}

/** 给错误文本打上【可重试】标记 (已经打过就不重复加) */
export function markRetryable(msg: string): string {
  const s = String(msg || '')
  return s.includes(RETRYABLE_MARKER) ? s : `${RETRYABLE_MARKER}${s}`
}

/** 错误文本里有没有【可重试】标记 */
export function isRetryableMessage(msg: string | null | undefined): boolean {
  return String(msg || '').includes(RETRYABLE_MARKER)
}

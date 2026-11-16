/**
 * ★ Sprint 48 T7 (PM msg-20261116-194): 通用 agent 循环的【token 触顶防护】
 *
 * 【问题】
 *   llm-debug 日志实测: maxTokens=8192 的调用里, 有 28 次 completion=8192 (触顶),
 *   其中 reasoning=8191 → **thinking 把预算吃光, 正文几乎为空**;
 *   而且同一个 bodySize 反复出现 = 原样重试撞同一堵墙。
 *
 * 【为什么要单独一个模块】
 *   ① "模型正常返回空" 与 "预算被吃光导致空" 必须能区分 (工单硬要求):
 *      前者要重试/换 prompt, 后者要【调大 max_tokens 或关 thinking】→ 报同一个错等于没修。
 *   ② 每次调用都要能查到 maxTokens / completion_tokens / reasoning_tokens (可观测)。
 *   ③ 纯函数 → 可离线断言。
 */

/** LLM usage (兼容 AI SDK / OpenAI 兼容接口的几种字段名) */
export interface LlmUsage {
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

/** 从 agent 返回值里尽量把 usage 抠出来 (Mastra 的 result / steps / response 都试) */
export function extractUsage(result: any): LlmUsage | null {
  const candidates: any[] = [
    result?.usage,
    result?.response?.usage,
    result?.steps?.[result?.steps?.length - 1]?.usage,
    result?.steps?.[result?.steps?.length - 1]?.response?.usage,
    result?.metadata?.usage,
  ].filter(Boolean)
  for (const u of candidates) {
    const prompt = Number(u.promptTokens ?? u.input_tokens ?? u.prompt_tokens ?? 0) || undefined
    const completion = Number(u.completionTokens ?? u.output_tokens ?? u.completion_tokens ?? 0) || undefined
    const total = Number(u.totalTokens ?? u.total_tokens ?? 0) || undefined
    const reasoning = Number(
      u.reasoningTokens ?? u.reasoning_tokens
      ?? u.completionTokensDetails?.reasoningTokens ?? u.completion_tokens_details?.reasoning_tokens
      ?? 0,
    ) || undefined
    if (prompt || completion || total || reasoning) {
      return { promptTokens: prompt, completionTokens: completion, reasoningTokens: reasoning, totalTokens: total }
    }
  }
  return null
}

export interface TokenExhaustionCheck {
  /** 是否判定为"预算被吃光" */
  exhausted: boolean
  /** 是否正文为空 */
  emptyOutput: boolean
  /** thinking 是否吃掉了几乎全部预算 */
  thinkingDominates: boolean
  completionTokens?: number
  reasoningTokens?: number
  maxTokens?: number
  /** 给人看的判定依据 */
  reason: string
}

/**
 * ★ 判定一次模型输出是不是"max_tokens 被 thinking 吃光"。
 * @param text 模型正文
 * @param usage usage
 * @param maxTokens 本次请求的 max_tokens (上限)
 */
export function detectTokenExhaustion(opts: {
  text?: string | null
  usage?: LlmUsage | null
  maxTokens?: number | null
}): TokenExhaustionCheck {
  const text = String(opts.text ?? '')
  const emptyOutput = text.trim().length === 0
  const usage = opts.usage ?? null
  const completion = usage?.completionTokens
  const reasoning = usage?.reasoningTokens
  const maxTokens = opts.maxTokens ?? null

  // thinking 几乎吃掉全部 completion (>=90%) 且正文为空
  const thinkingDominates =
    !!completion && !!reasoning && reasoning >= completion * 0.9

  // 正文为空 + (触顶 或 thinking 吃掉预算) → 判定为预算被吃光
  const hitCap = !!completion && !!maxTokens && completion >= maxTokens
  const exhausted = emptyOutput && (hitCap || thinkingDominates)

  let reason: string
  if (!emptyOutput) {
    reason = '正文非空'
  } else if (hitCap && thinkingDominates) {
    reason = `max_tokens 触顶且 thinking 吃掉几乎全部预算 (completion=${completion}/${maxTokens}, reasoning=${reasoning})`
  } else if (hitCap) {
    reason = `max_tokens 触顶 (completion=${completion}/${maxTokens})`
  } else if (thinkingDominates) {
    reason = `thinking 吃掉几乎全部预算 (completion=${completion}, reasoning=${reasoning})`
  } else {
    reason = '正文为空, 但没有触顶证据 (不是预算被吃光)'
  }

  return {
    exhausted,
    emptyOutput,
    thinkingDominates,
    completionTokens: completion,
    reasoningTokens: reasoning,
    maxTokens: maxTokens ?? undefined,
    reason,
  }
}

/**
 * ★ 给"输出为空"生成【可读】的错误文案。
 *   · 预算被吃光 → 告诉用户去调 max_tokens / 关 thinking (换个策略, 别原样重试)
 *   · 模型正常返回空 → 明确说不是预算问题 (别误导人去调预算)
 */
export function describeEmptyModelResult(check: TokenExhaustionCheck): string {
  if (!check.emptyOutput) return ''
  if (check.exhausted) {
    return `模型输出为空: ${check.reason} → 调大该 agent 的 max_tokens 或关闭 thinking 后重试 (原样重试没有意义)`
  }
  return `模型返回了空结果 (${check.reason}) → 换个说法重试, 或检查该 agent 的提示词`
}

/** usage → 日志摘要 */
export function describeUsage(usage: LlmUsage | null, maxTokens?: number | null): Record<string, any> {
  return {
    maxTokens: maxTokens ?? null,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  }
}

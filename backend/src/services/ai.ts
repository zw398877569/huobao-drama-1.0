/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio'

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 不同 LLM provider 的 base path 前缀。
 * 与 prompt-sanitizer.ts 旧版 getTextProviderBaseUrlPath 同源, 提到此处统一。
 * (两个版本之前略有重复, 现在只有这一处定义)
 *
 * 注意: minimax 也在 /v1 端点上 (OpenAI 兼容), 跟 openai/openrouter/chatfire 同组
 */
function textProviderPath(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'openai' || p === 'openrouter' || p === 'chatfire' || p === 'minimax') return '/v1'
  if (p === 'volcengine') return '/api/v3'
  if (p === 'ali') return '/api/v1'
  return ''
}

/**
 * 返回带 provider 路径前缀的 base URL (无末尾 path 部分)
 * — 用于 Vercel AI SDK 这类需要自己拼 path 的库 (agents/index.ts:864)
 */
export function getTextProviderBaseUrl(config: AIConfig) {
  return joinProviderUrl(config.baseUrl, textProviderPath(config.provider), '')
}

/**
 * 返回完整的 chat completions URL — 多数 LLM provider 都用同一端点
 * — 替代之前 5 处手工拼接 (4 种写法), 见 PR commit message
 */
export function getTextChatCompletionsUrl(config: AIConfig): string {
  return joinProviderUrl(config.baseUrl, textProviderPath(config.provider), '/chat/completions')
}

export function getActiveConfig(serviceType: ServiceType): AIConfig | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = active.model ? JSON.parse(active.model) : []
  logTaskProgress('AIConfig', 'active-config-selected', {
    serviceType,
    configId: active.id,
    provider: active.provider,
    model: models[0] || '',
    priority: active.priority,
  })
  return {
    provider: active.provider || '',
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: models[0] || '',
  }
}

export function getTextConfig(): AIConfig {
  const config = getActiveConfig('text')
  if (!config) throw new Error('No active text AI config')
  return config
}

export function getAudioConfig(): AIConfig {
  const config = getActiveConfig('audio')
  if (!config) throw new Error('No active audio AI config — 请在设置中添加音频服务')
  return config
}

export function getAudioConfigById(id?: number | null): AIConfig {
  if (id) {
    const config = getConfigById(id)
    if (config) return config
  }
  return getAudioConfig()
}

export function getConfigById(id: number): AIConfig | null {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  const models = row.model ? JSON.parse(row.model) : []
  logTaskProgress('AIConfig', 'config-by-id-selected', {
    configId: id,
    provider: row.provider,
    model: models[0] || '',
    serviceType: row.serviceType,
  })
  return {
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: models[0] || '',
  }
}

/**
 * 检测 prompt 是否包含非英文字符
 */
export function hasNonEnglishChars(text: string): boolean {
  return /[^\x00-\x7F]/.test(text)
}

/**
 * 将非英文 prompt 翻译为英文（调用 text provider）
 */
export async function translatePromptToEnglish(prompt: string): Promise<string> {
  const config = getActiveConfig('text')
  if (!config) {
    logTaskWarn('PromptTranslation', 'text-config-missing', { reason: 'skipping translation, using original prompt' })
    return prompt
  }

  const url = getTextChatCompletionsUrl(config)
  const payload = {
    model: config.model || 'agnes-2.0-flash',
    messages: [
      {
        role: 'system',
        content: (
          'Translate the user\'s image/video generation prompt into fluent English. '
          + 'Preserve all concrete visual details, style words, camera motion, lighting, '
          + 'composition constraints, and negative instructions. Return only the English prompt.'
        ),
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 800,
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    logTaskWarn('PromptTranslation', 'translation-failed', { status: resp.status, error: errText.slice(0, 200) })
    return prompt // fallback to original
  }

  const data = await resp.json() as any
  const translated = data?.choices?.[0]?.message?.content?.trim()
  if (!translated) {
    logTaskWarn('PromptTranslation', 'empty-translation', { reason: 'no content in response' })
    return prompt
  }
  return translated
}

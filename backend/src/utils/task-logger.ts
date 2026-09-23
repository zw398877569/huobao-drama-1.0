import { writeFlowLog } from './file-log.js'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * AsyncLocalStorage 自动注入 traceId + business IDs (2026-09-23 用户验证反馈)
 * 之前 PM msg-20260922-002 task A/B 只在 middleware 设了 traceId 但下游 logTask* 调用
 * 需要手动传 opts 才能串通文件落盘 → 12 个 routes 漏改, 只有 aiVoicesAsync 一个文件生效.
 * 现在 middleware 把 traceId 放进 ALS, emit 函数自动从 ALS 读 → 所有 logTask* 调用零改动.
 * 手动 opts 仍生效 (覆盖 ALS 值, 向后兼容).
 */
export const taskStorage = new AsyncLocalStorage<LogTaskOpts>()

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'

/**
 * 透传上下文 — 用于 traceId 串通和落盘
 *
 * - traceId: middleware 注入，下游 handler 通过 c.get('traceId') 拿到后传入
 * - dramaId / episodeId / storyboardId / taskId: 自动合入 entry meta（不覆盖已有同名字段）
 */
export interface LogTaskOpts {
  traceId?: string
  dramaId?: number
  episodeId?: number
  storyboardId?: number
  taskId?: string
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
}

function colorFor(level: LogLevel) {
  if (level === 'SUCCESS') return C.green
  if (level === 'WARN') return C.yellow
  if (level === 'ERROR') return C.red
  return C.cyan
}

function timeText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function safeValue(value: unknown) {
  if (value == null) return value
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatMeta(meta?: Record<string, unknown>) {
  if (!meta) return ''
  const entries = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${safeValue(value)}`)
  return entries.length ? ` | ${entries.join(' ')}` : ''
}

/**
 * 拼出 console 行尾的 envelope：traceId + dramaId + episodeId + storyboardId + taskId
 * 只展示有值的字段，保持原有 `key=value` 风格
 */
function formatOpts(opts?: LogTaskOpts): string {
  if (!opts) return ''
  const parts: string[] = []
  if (opts.traceId) parts.push(`traceId=${opts.traceId}`)
  if (opts.dramaId !== undefined) parts.push(`dramaId=${opts.dramaId}`)
  if (opts.episodeId !== undefined) parts.push(`episodeId=${opts.episodeId}`)
  if (opts.storyboardId !== undefined) parts.push(`storyboardId=${opts.storyboardId}`)
  if (opts.taskId) parts.push(`taskId=${opts.taskId}`)
  return parts.length ? ` [${parts.join(' ')}]` : ''
}

/**
 * 构造 JSON Lines entry — 包含 ts/level/scope/action + opts 字段 + meta（去重）
 * meta 已有同名字段保留（opts 不覆盖）
 */
function buildEntry(
  level: LogLevel,
  scope: string,
  action: string,
  meta?: Record<string, unknown>,
  opts?: LogTaskOpts
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    action,
  }
  if (opts?.traceId) entry.traceId = opts.traceId
  if (opts?.dramaId !== undefined) entry.dramaId = opts.dramaId
  if (opts?.episodeId !== undefined) entry.episodeId = opts.episodeId
  if (opts?.storyboardId !== undefined) entry.storyboardId = opts.storyboardId
  if (opts?.taskId) entry.taskId = opts.taskId
  entry.meta = meta ?? {}
  return entry
}

export function redactUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    for (const key of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '***')
      }
    }
    return url.toString()
  } catch {
    return rawUrl
      .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&]+/gi, '$1***')
  }
}

function sanitizeValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return truncateString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item))
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (['authorization', 'api_key', 'apikey', 'apiKey', 'token', 'access_token'].includes(key) ||
        lower.includes('authorization') || lower.includes('token') || lower.includes('apikey') || lower.includes('api_key')) {
        out[key] = '***'
        continue
      }

      if (typeof raw === 'string' && (lower === 'url' || lower.endsWith('url'))) {
        out[key] = redactUrl(raw)
        continue
      }

      if (typeof raw === 'string' && (
        lower === 'data' ||
        lower === 'b64_json' ||
        lower.includes('base64') ||
        lower.includes('audiohex') ||
        lower.includes('inline') ||
        raw.startsWith('data:image/')
      )) {
        out[key] = truncateString(raw, 48)
        continue
      }

      out[key] = sanitizeValue(raw)
    }
    return out
  }

  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function truncateString(value: string, edge = 120) {
  if (value.length <= edge * 2 + 24) return value
  return `${value.slice(0, edge)}...<trimmed ${value.length} chars>...${value.slice(-edge)}`
}

function emit(level: LogLevel, scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  // ALS fallback: 如果调用方没传 opts, 从 AsyncLocalStorage 拿 middleware 注入的 traceId
  const contextOpts = opts ?? taskStorage.getStore()
  const color = colorFor(level)
  const suffix = formatOpts(contextOpts)
  console.log(`${C.dim}${timeText()}${C.reset} ${color}[${scope}]${C.reset} ${action}${formatMeta(meta)}${suffix}`)
  if (contextOpts?.traceId) {
    writeFlowLog(contextOpts.traceId, buildEntry(level, scope, action, meta, contextOpts))
  }
}

export function logTask(scope: string, action: string, meta?: Record<string, unknown>, level: LogLevel = 'INFO', opts?: LogTaskOpts) {
  emit(level, scope, action, meta, opts)
}

export function logTaskStart(scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  emit('INFO', scope, `START ${action}`, meta, opts)
}

export function logTaskProgress(scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  emit('INFO', scope, action, meta, opts)
}

export function logTaskSuccess(scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  emit('SUCCESS', scope, `DONE ${action}`, meta, opts)
}

export function logTaskWarn(scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  emit('WARN', scope, action, meta, opts)
}

export function logTaskError(scope: string, action: string, meta?: Record<string, unknown>, opts?: LogTaskOpts) {
  emit('ERROR', scope, `ERROR ${action}`, meta, opts)
}

export function logTaskPayload(scope: string, action: string, payload: unknown, opts?: LogTaskOpts) {
  const contextOpts = opts ?? taskStorage.getStore()
  const traceId = contextOpts?.traceId
  const sanitized = sanitizeValue(payload)
  const serialized = typeof sanitized === 'string'
    ? sanitized
    : JSON.stringify(sanitized, null, 2)
  console.log(`${C.dim}${timeText()}${C.reset} ${C.blue}[${scope}]${C.reset} ${action}${formatOpts(contextOpts)}\n${serialized}`)
  if (traceId) {
    writeFlowLog(traceId, {
      ...buildEntry('INFO', scope, action, undefined, contextOpts),
      meta: { payload: sanitized },
    })
  }
}

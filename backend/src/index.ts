// 全局 undici dispatcher (2026-09-21):
//   LLM API 偶发 5 分钟无响应 → undici headersTimeout 报 UND_ERR_HEADERS_TIMEOUT
//   (Minimax-M3 拆解剧情 + tools schema 大,首次调用 streaming 响应偏慢).
//   undici 默认 headersTimeout=300000 (5 分钟). 提高到 10 分钟容忍上游慢响应.
//   任何 fetch (包括 @ai-sdk/* / Mastra / node-fetch) 自动走这个 dispatcher.
// undici 是 Node.js 22+ 内置模块, 但 ESM 'undici' import 解析不到 (npm 包不存在).
// 用 createRequire 从 'node:undici' (Node 内置协议) 拿. 类型用 any 占位 (TS 解析失败 @ts-ignore).
import { createRequire } from 'node:module'
// @ts-ignore --node:undici types
const { Agent, setGlobalDispatcher } = createRequire(import.meta.url)('node:undici')
setGlobalDispatcher(new Agent({
  headersTimeout: 10 * 60 * 1000,  // 10 分钟
  bodyTimeout: 10 * 60 * 1000,
}))

// 一次性 LLM 请求 debug 日志 (2026-09-21, 用户要求):
//   排查拆解偶发 5+ 分钟慢响应. 默认写到 /app/data/llm-debug.log (挂载卷 host D:/aicg1.0/data/).
//   用法: docker exec huobao-drama-1.0 tail -f /app/data/llm-debug.log
//   关闭: DEBUG_LLM_FILE= (空值) 或设成 /dev/null, 或问题定位完删这段代码.
//   问题定位完 DEV 跟 USER 一起决定删除.
import fs from 'fs'
const DEBUG_LLM_FILE = process.env.DEBUG_LLM_FILE ?? '/app/data/llm-debug.log'
const debugStream = DEBUG_LLM_FILE ? fs.createWriteStream(DEBUG_LLM_FILE, { flags: 'a' }) : null
const origFetch = globalThis.fetch
// @ts-ignore --globalThis.fetch 类型推断覆盖
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? ''
  if (debugStream && url.includes('/chat/completions')) {
    const ts = new Date().toISOString()
    let meta: any = { error: 'parse_failed' }
    try {
      const bodyStr = typeof init?.body === 'string' ? init.body : ''
      const b = bodyStr ? JSON.parse(bodyStr) : {}
      meta = {
        bodySize: bodyStr.length,
        model: b.model,
        msgCount: b.messages?.length ?? 0,
        systemLen: b.messages?.[0]?.content?.length ?? 0,
        userLen: b.messages?.[1]?.content?.length ?? 0,
        toolsCount: b.tools?.length ?? 0,
        toolsNames: (b.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean),
        maxTokens: b.max_tokens,
        temperature: b.temperature,
      }
    } catch {}
    debugStream.write(`[LLM-REQ] ${ts} ${url} ${JSON.stringify(meta)}\n`)
  }
  return origFetch(input, init)
}) as typeof fetch

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import props from './routes/props.js'
import images from './routes/images.js'
import videos from './routes/videos.js'
import agnesDebug from './routes/agnesDebug.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders, ensureAgentDefaults } from './routes/aiConfigs.js'
import agentConfigs from './routes/agentConfigs.js'
import agent from './routes/agent.js'
import compose from './routes/compose.js'
import merge from './routes/merge.js'
import grid from './routes/grid.js'
import skills from './routes/skills.js'
import stylePresets from './routes/stylePresets.js'
import webhooks from './routes/webhooks.js'
import cron from './routes/cron.js'
import aiVoices from './routes/aiVoices.js'
import aiVoicesAsync from './routes/aiVoicesAsync.js'
import { requestLogger, errorHandler } from './middleware/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check
app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/props', props)
api.route('/images', images)
api.route('/videos', videos)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/agent-configs', agentConfigs)
api.route('/agent', agent)
api.route('/cron', cron)
api.route('/compose', compose)
api.route('/merge', merge)
api.route('/grid', grid)
api.route('/skills', skills)
api.route('/style-presets', stylePresets)
api.route('/ai-voices', aiVoices)
api.route('/ai-voices-async', aiVoicesAsync)

app.route('/api/v1/_debug', agnesDebug)
app.route('/api/v1', api)

// Webhook callbacks (Vidu, etc.) - outside /api/v1
app.route('/webhooks', webhooks)

// Serve static files (storage)
app.use('/static/*', serveStatic({ root: path.join(projectRoot, 'data') }))

// Serve frontend (production build)
const distPath = path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)

// 启动时 sync 每个 agent 的 T/MaxT 到 HUOBAO_AGENT_PARAMS 推荐值
// (幂等,只动 T/MaxT,不动 systemPrompt 等用户字段;2026-08-23 引入)
ensureAgentDefaults()

console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
serve({ fetch: app.fetch, port })

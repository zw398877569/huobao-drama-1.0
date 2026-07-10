/**
 * AI 音色异步合成 - 最小验证端点
 *
 * 端点:
 *   POST /api/v1/ai-voices/async/test     - 端到端测试: 创建任务 -> 轮询 -> 下载, 返回 base64 音频
 *   POST /api/v1/ai-voices/async/create   - 仅创建任务, 返回 task_id
 *   GET  /api/v1/ai-voices/async/query    - 查询任务状态 (?task_id=xxx)
 *
 * 数据源: 直接读 aiServiceConfigs 表中 serviceType='audio' 且 provider='minimax' 的配置
 */
import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTTSAsyncAdapter } from '../services/adapters/registry.js'
import { success, badRequest } from '../utils/response.js'

function fail(c: any, message: string, status = 500, extra: any = null) {
  return c.json({ code: status, message, ...(extra ? { data: extra } : {}) }, status)
}

const app = new Hono()

function getMiniMaxAudioConfig() {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.serviceType, 'audio'),
               eq(schema.aiServiceConfigs.provider, 'minimax')))
    .all()
  const active = rows.find((r: any) => r.isActive) || rows[0]
  if (!active) {
    throw new Error('No minimax audio config found. Add one in Settings first.')
  }
  if (!active.apiKey) {
    throw new Error('MiniMax API key is empty in the audio config.')
  }
  return { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model }
}

interface TestBody {
  text?: string
  textFileId?: string
  voiceId?: string
  model?: string
  speed?: number
  vol?: number
  pitch?: number
  languageBoost?: string
  audioSampleRate?: number
  bitrate?: number
  format?: 'mp3' | 'pcm' | 'flac' | 'wav'
  channel?: 1 | 2
  pronunciationDictTone?: string[]
  voiceModify?: { pitch?: number; intensity?: number; timbre?: number; soundEffects?: string }
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

const DEFAULT_TEST_TEXT = '微风拂过柔软的草地,清新的芳香伴随着鸟儿的歌唱。'

// POST /ai-voices/async/test - 端到端验证
app.post('/test', async (c) => {
  try {
    const cfg = getMiniMaxAudioConfig()
    const adapter = getTTSAsyncAdapter('minimax')
    if (!adapter) return fail(c, 'Async TTS adapter not available', 500)

    const body = (await c.req.json().catch(() => ({}))) as TestBody
    const params = {
      text: body.text || DEFAULT_TEST_TEXT,
      voiceId: body.voiceId || 'audiobook_male_1',
      model: body.model || cfg.model || 'speech-2.8-hd',
      speed: body.speed ?? 1,
      vol: body.vol ?? 10,
      pitch: body.pitch ?? 1,
      languageBoost: body.languageBoost,
      audioSampleRate: body.audioSampleRate ?? 32000,
      bitrate: body.bitrate ?? 128000,
      format: body.format ?? 'mp3',
      channel: body.channel ?? 1,
      pronunciationDictTone: body.pronunciationDictTone,
      voiceModify: body.voiceModify,
    }
    const pollInterval = body.pollIntervalMs ?? 2000
    const pollTimeout = body.pollTimeoutMs ?? 90000

    // 1) 创建任务
    const createReq = adapter.buildCreateRequest(cfg, params)
    const t0 = Date.now()
    const createResp = await fetch(createReq.url, {
      method: createReq.method,
      headers: createReq.headers,
      body: JSON.stringify(createReq.body),
    })
    const createJson = await createResp.json().catch(() => ({}))
    if (!createResp.ok) {
      return fail(c, `create task failed: ${createResp.status} ${JSON.stringify(createJson).slice(0, 500)}`, 502)
    }
    const handle = adapter.parseCreateResponse(createJson)
    const createdAt = Date.now() - t0

    // 2) 轮询
    const q0 = Date.now()
    let pollResult: any = null
    while (Date.now() - q0 < pollTimeout) {
      const qReq = adapter.buildQueryRequest(cfg, handle.taskId)
      const qResp = await fetch(qReq.url, { method: qReq.method, headers: qReq.headers })
      const qJson = await qResp.json().catch(() => ({}))
      const parsed = adapter.parseQueryResponse(qJson)
      if (parsed.status === 'success') {
        pollResult = { ...parsed, raw: undefined } // 不回传整个 raw,避免太大
        break
      }
      if (parsed.status === 'failed') {
        return fail(c, `task failed: ${parsed.error || 'unknown'}`, 502, { taskId: handle.taskId, raw: parsed.raw })
      }
      await new Promise(r => setTimeout(r, pollInterval))
    }
    if (!pollResult) {
      return fail(c, `poll timeout after ${pollTimeout}ms`, 504, { taskId: handle.taskId })
    }
    const polledAt = Date.now() - q0

    // 3) 下载
    const dReq = adapter.buildDownloadRequest(cfg, pollResult.fileId)
    const dResp = await fetch(dReq.url, { method: dReq.method, headers: dReq.headers })
    if (!dResp.ok) {
      return fail(c, `download failed: ${dResp.status}`, 502, { fileId: pollResult.fileId })
    }
    const audioBuf = Buffer.from(await dResp.arrayBuffer())
    const audioB64 = audioBuf.toString('base64')

    return success(c, {
      ok: true,
      taskId: handle.taskId,
      fileId: pollResult.fileId,
      bytes: audioBuf.length,
      format: params.format,
      sampleRate: params.audioSampleRate,
      timings: {
        createMs: createdAt,
        pollMs: polledAt,
        totalMs: Date.now() - t0,
      },
      audioBase64: audioB64,
    })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500)
  }
})

// POST /ai-voices/async/create - 仅创建任务
app.post('/create', async (c) => {
  try {
    const cfg = getMiniMaxAudioConfig()
    const adapter = getTTSAsyncAdapter('minimax')
    if (!adapter) return fail(c, 'Async TTS adapter not available', 500)

    const body = (await c.req.json().catch(() => ({}))) as TestBody
    if (!body.text && !body.textFileId) {
      return badRequest(c, 'text or textFileId is required')
    }
    const params = {
      text: body.text,
      textFileId: body.textFileId,
      voiceId: body.voiceId || 'audiobook_male_1',
      model: body.model || cfg.model || 'speech-2.8-hd',
      speed: body.speed,
      vol: body.vol,
      pitch: body.pitch,
      languageBoost: body.languageBoost,
      audioSampleRate: body.audioSampleRate,
      bitrate: body.bitrate,
      format: body.format,
      channel: body.channel,
      pronunciationDictTone: body.pronunciationDictTone,
      voiceModify: body.voiceModify,
    }
    const req = adapter.buildCreateRequest(cfg, params)
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
    })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return fail(c, `create failed: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`, 502)
    }
    const handle = adapter.parseCreateResponse(json)
    return success(c, { taskId: handle.taskId, raw: json })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500)
  }
})

// GET /ai-voices/async/query?task_id=xxx
app.get('/query', async (c) => {
  try {
    const taskId = c.req.query('task_id')
    if (!taskId) return badRequest(c, 'task_id is required')
    const cfg = getMiniMaxAudioConfig()
    const adapter = getTTSAsyncAdapter('minimax')
    if (!adapter) return fail(c, 'Async TTS adapter not available', 500)

    const req = adapter.buildQueryRequest(cfg, taskId)
    const resp = await fetch(req.url, { method: req.method, headers: req.headers })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return fail(c, `query failed: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`, 502)
    }
    const parsed = adapter.parseQueryResponse(json)
    return success(c, { taskId, ...parsed })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500)
  }
})

export default app

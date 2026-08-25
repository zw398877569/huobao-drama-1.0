/**
 * AI 音色异步合成 - 验证端点
 *
 * 端点:
 *   POST /api/v1/ai-voices-async/test     - 端到端测试: 创建任务 -> 轮询 -> 下载, 返回 base64 音频
 *   POST /api/v1/ai-voices-async/create   - 仅创建任务, 返回 task_id
 *   GET  /api/v1/ai-voices-async/query    - 查询任务状态 (?task_id=xxx)
 *
 * 数据源: aiServiceConfigs 表中 serviceType='audio' 的 active 配置
 * 支持 provider:
 *   - minimax        - 同步返回 tar 归档(内含 mp3), download 解 tar 提 mp3
 *   - autodl-comfyui - 异步 results[].url 直接是远程 wav URL, 无需下载步骤
 *
 * 入口: ?provider=xxx (默认 'minimax')
 */
import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTTSAsyncAdapter } from '../services/adapters/registry.js'
import { success, badRequest } from '../utils/response.js'

function fail(c: any, message: string, status = 500, extra: any = null) {
  return c.json({ code: status, message, ...(extra ? { data: extra } : {}) }, status)
}

/** 读 provider 参数 (?provider=xxx 或 body.provider), 默认 minimax */
function readProvider(c: any, body: any): string {
  return (
    c.req.query('provider') ||
    body?.provider ||
    'minimax'
  ).toString().toLowerCase()
}

/** 找 serviceType=audio + provider=X 的 active 配置 */
function getAudioConfig(provider: string) {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.serviceType, 'audio'),
               eq(schema.aiServiceConfigs.provider, provider)))
    .all()
  const active = rows.find((r: any) => r.isActive) || rows[0]
  if (!active) {
    throw new Error(`No audio config for provider="${provider}". Add one in Settings first.`)
  }
  if (!active.apiKey) {
    throw new Error(`Audio config for "${provider}" has empty apiKey.`)
  }
  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    provider: active.provider,
  }
}

const DEFAULT_TEST_TEXT = '微风拂过柔软的草地,清新的芳香伴随着鸟儿的歌唱。'

/** minimax 的接口请求体 */
interface MinimaxTestBody {
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
  /** 端到端轮询参数 */
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** provider 派发 (默认 minimax) */
  provider?: string
}

/** autodl TTS 的接口请求体 */
interface AutoDLTestBody {
  promptText?: string
  promptSimple?: string
  emotion?: {
    happy?: number
    angry?: number
    sad?: number
    afraid?: number
    surprised?: number
    calm?: number
    melancholic?: number
    disgusted?: number
    random?: boolean
  }
  emoRefAudio?: string
  emoControlMethod?: '使用情感参考音频' | '使用情感向量控制' | '不使用情感'
  pollIntervalMs?: number
  pollTimeoutMs?: number
  provider?: string
}

const app = new Hono()

// POST /ai-voices-async/test - 端到端验证
app.post('/test', async (c) => {
  const t0 = Date.now()
  let provider = 'minimax'
  try {
    const body = (await c.req.json().catch(() => ({}))) as MinimaxTestBody & AutoDLTestBody
    provider = readProvider(c, body)
    const adapter = getTTSAsyncAdapter(provider)
    if (!adapter) return fail(c, `No async TTS adapter for provider="${provider}"`, 500)

    // 分 provider 构建 params — 不同 provider 接口签名不同
    let createReq: any
    let pollInterval = 2000
    let pollTimeout = 300000

    if (provider === 'autodl-comfyui') {
      const autodlBody = body as AutoDLTestBody
      const params = {
        promptText: autodlBody.promptText || DEFAULT_TEST_TEXT,
        promptSimple: autodlBody.promptSimple,
        emotion: autodlBody.emotion,
        emoRefAudio: autodlBody.emoRefAudio,
        emoControlMethod: autodlBody.emoControlMethod,
      }
      const cfg = getAudioConfig(provider)
      createReq = adapter.buildCreateRequest(cfg, params)
      pollInterval = autodlBody.pollIntervalMs ?? 3000
      pollTimeout = autodlBody.pollTimeoutMs ?? 300000
    } else {
      // 默认 minimax
      const mmBody = body as MinimaxTestBody
      const cfg = getAudioConfig(provider)
      const params = {
        text: mmBody.text || DEFAULT_TEST_TEXT,
        textFileId: mmBody.textFileId,
        voiceId: mmBody.voiceId || 'audiobook_male_1',
        model: mmBody.model || (typeof cfg.model === 'string' ? cfg.model : 'speech-2.8-hd'),
        speed: mmBody.speed ?? 1,
        vol: mmBody.vol ?? 10,
        pitch: mmBody.pitch ?? 1,
        languageBoost: mmBody.languageBoost,
        audioSampleRate: mmBody.audioSampleRate ?? 32000,
        bitrate: mmBody.bitrate ?? 128000,
        format: mmBody.format ?? 'mp3',
        channel: mmBody.channel ?? 1,
        pronunciationDictTone: mmBody.pronunciationDictTone,
        voiceModify: mmBody.voiceModify,
      }
      createReq = adapter.buildCreateRequest(cfg, params)
      pollInterval = mmBody.pollIntervalMs ?? 2000
      pollTimeout = mmBody.pollTimeoutMs ?? 300000
    }

    // 1) 创建任务
    const tCreate = Date.now()
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
    const createdAt = Date.now() - tCreate

    // 2) 轮询
    const tPoll = Date.now()
    let pollResult: any = null
    const cfg = getAudioConfig(provider)
    while (Date.now() - tPoll < pollTimeout) {
      const qReq = adapter.buildQueryRequest(cfg, handle.taskId)
      const qResp = await fetch(qReq.url, { method: qReq.method, headers: qReq.headers })
      const qJson = await qResp.json().catch(() => ({}))
      const parsed = adapter.parseQueryResponse(qJson)
      if (parsed.status === 'success') {
        pollResult = parsed
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
    const polledAt = Date.now() - tPoll

    // 3) 拿音频 — autodl 直接是 URL; minimax 是 file_id 需要 download
    if (provider === 'autodl-comfyui') {
      if (!pollResult.audioUrl) {
        return fail(c, 'autodl-comfyui task completed but no audioUrl in result', 502, { taskId: handle.taskId, raw: pollResult.raw })
      }
      return success(c, {
        ok: true,
        provider,
        taskId: handle.taskId,
        audioUrl: pollResult.audioUrl,
        format: 'wav',
        timings: {
          createMs: createdAt,
          pollMs: polledAt,
          totalMs: Date.now() - t0,
        },
      })
    }

    // minimax: 下载 + 解 tar 归档
    if (!adapter.buildDownloadRequest || !adapter.parseDownloadResponse) {
      return fail(c, `provider "${provider}" task succeeded but no download helper`, 500, { taskId: handle.taskId })
    }
    const dReq = adapter.buildDownloadRequest(cfg, pollResult.fileId)
    const dResp = await fetch(dReq.url, { method: dReq.method, headers: dReq.headers })
    if (!dResp.ok) {
      return fail(c, `download failed: ${dResp.status}`, 502, { fileId: pollResult.fileId })
    }
    let audioBuf: Buffer
    try {
      audioBuf = adapter.parseDownloadResponse(await dResp.arrayBuffer()).audio
    } catch (e: any) {
      return fail(c, `parse download failed: ${e?.message || 'unknown'}`, 502, { fileId: pollResult.fileId })
    }
    const audioB64 = audioBuf.toString('base64')

    return success(c, {
      ok: true,
      provider,
      taskId: handle.taskId,
      fileId: pollResult.fileId,
      bytes: audioBuf.length,
      format: 'mp3',
      sampleRate: 32000,
      timings: {
        createMs: createdAt,
        pollMs: polledAt,
        totalMs: Date.now() - t0,
      },
      audioBase64: audioB64,
    })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500, { provider })
  }
})

// POST /ai-voices-async/create - 仅创建任务
app.post('/create', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as MinimaxTestBody & AutoDLTestBody
    const provider = readProvider(c, body)
    const adapter = getTTSAsyncAdapter(provider)
    if (!adapter) return fail(c, `No async TTS adapter for provider="${provider}"`, 500)

    let req: any
    if (provider === 'autodl-comfyui') {
      const b = body as AutoDLTestBody
      if (!b.promptText) return badRequest(c, 'promptText is required')
      const cfg = getAudioConfig(provider)
      req = adapter.buildCreateRequest(cfg, {
        promptText: b.promptText,
        promptSimple: b.promptSimple,
        emotion: b.emotion,
        emoRefAudio: b.emoRefAudio,
        emoControlMethod: b.emoControlMethod,
      })
    } else {
      const b = body as MinimaxTestBody
      if (!b.text && !b.textFileId) return badRequest(c, 'text or textFileId is required')
      const cfg = getAudioConfig(provider)
      req = adapter.buildCreateRequest(cfg, {
        text: b.text,
        textFileId: b.textFileId,
        voiceId: b.voiceId || 'audiobook_male_1',
        model: b.model,
        speed: b.speed,
        vol: b.vol,
        pitch: b.pitch,
        languageBoost: b.languageBoost,
        audioSampleRate: b.audioSampleRate,
        bitrate: b.bitrate,
        format: b.format,
        channel: b.channel,
        pronunciationDictTone: b.pronunciationDictTone,
        voiceModify: b.voiceModify,
      })
    }

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
    return success(c, { provider, taskId: handle.taskId, raw: json })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500)
  }
})

// GET /ai-voices-async/query?task_id=xxx&provider=xxx
app.get('/query', async (c) => {
  try {
    const taskId = c.req.query('task_id')
    if (!taskId) return badRequest(c, 'task_id is required')
    const provider = readProvider(c, {})
    const adapter = getTTSAsyncAdapter(provider)
    if (!adapter) return fail(c, `No async TTS adapter for provider="${provider}"`, 500)

    const cfg = getAudioConfig(provider)
    const req = adapter.buildQueryRequest(cfg, taskId)
    const resp = await fetch(req.url, { method: req.method, headers: req.headers })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return fail(c, `query failed: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`, 502)
    }
    const parsed = adapter.parseQueryResponse(json)
    return success(c, { provider, taskId, ...parsed })
  } catch (e: any) {
    return fail(c, e?.message || 'unknown error', 500)
  }
})

export default app

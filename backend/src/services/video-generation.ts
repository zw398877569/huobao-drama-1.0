import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { getVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  duration?: number
  aspectRatio?: string
  configId?: number
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    referenceMode: params.referenceMode || 'none',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('VideoTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'none',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processVideoGeneration(lastId, config).catch(err => {
    logTaskError('VideoTask', 'process', { id: lastId, error: err.message })
    console.error(`Video generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processVideoGeneration(id: number, config: AIConfig) {
  const adapter = getVideoAdapter(config.provider)

  try {
    const rows = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    logTaskProgress('VideoTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    })

    const resolvedImageUrl = await normalizeVideoReferenceUrl(record.imageUrl)
    const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(record.firstFrameUrl)
    const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(record.lastFrameUrl)
    const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(record.referenceImageUrls)

    // 使用 Adapter 构建请求
    const { url, method, headers, body } = adapter.buildGenerateRequest(config, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      referenceMode: record.referenceMode,
      imageUrl: resolvedImageUrl,
      firstFrameUrl: resolvedFirstFrameUrl,
      lastFrameUrl: resolvedLastFrameUrl,
      referenceImageUrls: resolvedReferenceImageUrls ? JSON.stringify(resolvedReferenceImageUrls) : null,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
    })
    logTaskProgress('VideoTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
      referenceMode: record.referenceMode,
    })
    logTaskPayload('VideoTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    // 503/502/408/429 视为临时性错误,做指数退避重试;其他错误立即失败
    // 业务错误(如 num_frames 格式不对)直接抛,不浪费 retry 预算
    const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
    const MAX_RETRIES = 3
    let resp: Response | null = null
    let lastErrText = ''
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        })
      } catch (err: any) {
        lastErrText = err?.message || String(err)
        logTaskWarn('VideoTask', 'fetch-network-retry', { id, attempt: attempt + 1, error: lastErrText })
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(`fetch failed after ${MAX_RETRIES} attempts: ${lastErrText}`)
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        continue
      }
      if (resp.ok) break
      if (!TRANSIENT_STATUS.has(resp.status)) {
        // 业务错误(num_frames 格式 / content_policy / 鉴权 等)立即抛
        throw new Error(`API error ${resp.status}: ${await resp.text()}`)
      }
      lastErrText = await resp.text()
      logTaskWarn('VideoTask', 'transient-error-retry', {
        id,
        attempt: attempt + 1,
        status: resp.status,
        body: lastErrText.slice(0, 240),
      })
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(`API error ${resp.status} after ${MAX_RETRIES} attempts: ${lastErrText}`)
      }
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
    }
    if (!resp || !resp.ok) {
      // 防御性兜底
      throw new Error(`API error ${resp?.status}: ${lastErrText}`)
    }
    const result = await resp.json() as any
    logTaskPayload('VideoTask', 'response payload', result)

    const { isAsync, taskId, videoId: videoIdFromAdapter, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
      // 同步模式
      await handleVideoComplete(id, videoUrl, record.duration)
      return
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    // 记录 videoId 用于诊断(实际查询用的 ID)
    logTaskProgress('VideoTask', 'poll-start', { id, taskId, videoId: videoIdFromAdapter, provider: config.provider })

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === 'vidu') {
      logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
      return
    }

    // agnes 推荐用 video_id 查询,fallback 到 taskId(兼容旧版 /v1/videos/<task_id>)
    pollVideoTask(id, config, videoIdFromAdapter || taskId!, taskId!, record.storyboardId)
  } catch (err: any) {
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: err.message })
    db.update(schema.videoGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
  }
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

async function pollVideoTask(id: number, config: AIConfig, videoId: string, taskId: string, storyboardId?: number | null) {
  const adapter = getVideoAdapter(config.provider)
  // 总 poll 时长上限 30 分钟(180 次 × 10s);连续 5 次失败就放弃
  const MAX_POLLS = 180
  const MAX_CONSECUTIVE_FAILS = 5
  // 指数退避轮询: 5s → 10s → 15s → 30s(封顶)
  // 视频生成通常 1-3 分钟,起步快一点确认开始,后段慢一点减轻 agnes 压力
  const POLL_INTERVALS_MS = [5_000, 10_000, 15_000, 30_000]
  function getPollIntervalMs(attempt: number): number {
    const idx = Math.min(attempt - 1, POLL_INTERVALS_MS.length - 1)
    return POLL_INTERVALS_MS[idx]
  }
  // 视频任务超过 30 分钟强制 timeout
  const MAX_POLL_DURATION_MS = 30 * 60 * 1000
  // 4xx / JSON 解析错误视为"端点或响应格式不对",再重试无意义,直接放弃
  const PERMANENT_STATUS = new Set([400, 401, 403, 404, 410, 422])

  let consecutiveFails = 0
  const startedAt = Date.now()

  for (let i = 0; i < MAX_POLLS; i++) {
    // 总时长硬上限
    if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
      logTaskError('VideoTask', 'poll-duration-timeout', { id, taskId, maxDurationSec: MAX_POLL_DURATION_MS / 1000 })
      db.update(schema.videoGenerations)
        .set({ status: 'failed', errorMsg: `Poll timeout after ${Math.round((Date.now() - startedAt) / 1000)}s`, updatedAt: now() })
        .where(eq(schema.videoGenerations.id, id)).run()
      return
    }
    await new Promise(r => setTimeout(r, getPollIntervalMs(i + 1)))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, videoId, taskId)
      logTaskProgress('VideoTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const resp = await fetch(url, { method, headers })

      if (!resp.ok) {
        consecutiveFails++
        const body = await resp.text().catch(() => '')
        logTaskWarn('VideoTask', 'poll-http-error', {
          id,
          taskId,
          attempt: i + 1,
          status: resp.status,
          bodyPreview: body.slice(0, 200),
        })
        if (PERMANENT_STATUS.has(resp.status)) {
          // 端点不对/鉴权错,直接放弃
          logTaskError('VideoTask', 'poll-permanent-fail', {
            id, taskId, status: resp.status, error: body.slice(0, 240),
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll permanent error ${resp.status}: ${body.slice(0, 200)}`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          logTaskError('VideoTask', 'poll-giveup', {
            id, taskId, consecutiveFails, lastStatus: resp.status,
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll gave up after ${consecutiveFails} consecutive failures (last status ${resp.status})`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        continue
      }

      // 状态 200 但响应不是 JSON(比如 agnes 返回 HTML 404 页面),JSON.parse 抛 SyntaxError
      const contentType = resp.headers.get('content-type') || ''
      const rawText = await resp.text()
      if (!contentType.includes('application/json') && !rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
        consecutiveFails++
        logTaskWarn('VideoTask', 'poll-non-json-response', {
          id, taskId, attempt: i + 1, contentType,
          bodyPreview: rawText.slice(0, 200),
        })
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          logTaskError('VideoTask', 'poll-giveup-non-json', {
            id, taskId, consecutiveFails,
            lastBody: rawText.slice(0, 240),
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll gave up: ${consecutiveFails} consecutive non-JSON responses. Last: ${rawText.slice(0, 200)}`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        continue
      }

      const result = JSON.parse(rawText) as any
      consecutiveFails = 0  // 成功解析,清零
      const hasAnyUrl = !!(result.url || result.video_url || result.data?.url
        || result.data?.video_url || result.output?.url || result.result?.url)
      // 记录 poll 响应用于诊断(每个轮询都打印精简版)
      logTaskProgress('VideoTask', 'poll-response', {
        id, taskId, attempt: i + 1,
        status: result.status, progress: result.progress,
        hasUrl: hasAnyUrl,
        fields: Object.keys(result).join(','),
      })
      // 完整 body 在第 1 / 5 / 10 / status 变化时打印(帮助诊断 url 字段在哪)
      const lastStatus = (globalThis as any).__lastPollStatus
      if (i < 3 || (i + 1) % 5 === 0 || (lastStatus !== undefined && lastStatus !== result.status)) {
        logTaskPayload('VideoTask', 'poll-response-body', {
          id, taskId, attempt: i + 1,
          status: result.status, progress: result.progress,
          seconds: result.seconds, size: result.size,
          // 所有可能的 url 字段值(可能是 undefined)
          'url': result.url,
          'video_url': result.video_url,
          'remixed_from_video_id': result.remixed_from_video_id,
          'data.url': result.data?.url,
          'data.video_url': result.data?.video_url,
          'data.remixed_from_video_id': result.data?.remixed_from_video_id,
          'output.url': result.output?.url,
          'result.url': result.result?.url,
          'videos[0].url': result.videos?.[0]?.url,
          'metadata': result.metadata,  // 日志(16)新发现:可能有 url
          result_keys: Object.keys(result),
        })
        ;(globalThis as any).__lastPollStatus = result.status
      }
      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId)
        return
      }
      if (pollResp.status === 'failed') {
        logTaskError('VideoTask', 'poll-failed', { id, taskId, error: pollResp.error || 'Video generation failed' })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: pollResp.error || 'Video generation failed', updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id)).run()
        return
      }
      // 仍 processing,继续下一轮
    } catch (err: any) {
      consecutiveFails++
      logTaskWarn('VideoTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        logTaskError('VideoTask', 'poll-giveup-exception', { id, taskId, consecutiveFails, error: err.message })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: `Poll gave up after ${consecutiveFails} consecutive exceptions: ${err.message}`, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id)).run()
        return
      }
    }
  }
  // 用尽 MAX_POLLS
  logTaskError('VideoTask', 'poll-timeout', { id, taskId, maxPolls: MAX_POLLS })
  db.update(schema.videoGenerations)
    .set({ status: 'failed', errorMsg: `Poll timeout after ${MAX_POLLS} attempts (${MAX_POLLS * POLL_INTERVAL_MS / 1000}s)`, updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id)).run()
}

async function handleVideoComplete(id: number, videoUrl: string, duration: number | null | undefined, storyboardId?: number | null) {
  const localPath = await downloadFile(videoUrl, 'videos')
  db.update(schema.videoGenerations)
    .set({ videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
  logTaskSuccess('VideoTask', 'downloaded', { id, localPath, storyboardId, duration })

  if (storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }
}

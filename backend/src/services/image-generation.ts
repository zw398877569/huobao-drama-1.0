import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById, hasNonEnglishChars, translatePromptToEnglish } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { sanitizeImagePromptAggressive } from '../utils/prompt-sanitizer.js'

// 默认图片生成安全后缀：把"角色/场景"提示词从"剧情重现"重新框架为"电影概念艺术"，
// 以降低 Agnes 等内容审核服务的命中率。后缀里的关键词都是正向艺术语言，
// 避免直接说"no weapons / no blood"（这种否定式有时候反而会强化主题词）。
// 真正的根治仍需要 LLM 改写器（按敏感词动态重写 prompt），
// 那是后话 — 至少这个 suffix 把"血腥/医疗/武打"类 false positive 概率压下来。
export const DEFAULT_IMAGE_SAFETY_SUFFIX = ', 电影剧照, 戏剧张力, 艺术化构图'

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  prompt: string
  negativePrompt?: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')

  const res = db.insert(schema.imageGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('ImageTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processImageGeneration(lastId, config).catch(err => {
    logTaskError('ImageTask', 'process', { id: lastId, error: err.message })
    console.error(`Image generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processImageGeneration(id: number, config: AIConfig) {
  const adapter = getImageAdapter(config.provider)

  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return

    // 最多重试 1 次(用于 content_policy_violation 的 aggressive 清洗重试)
    let retryCount = 0
    const MAX_RETRIES = 3

    for (let attempt = 0; attempt < MAX_RETRIES || (attempt === MAX_RETRIES && retryCount === 0); attempt++) {
      // 首次循环(MAX_RETRIES 次) + 可选的 aggressive 重试(1 次)
      const isAggressiveRetry = attempt === MAX_RETRIES && retryCount === 0
      if (isAggressiveRetry) {
        logTaskWarn('ImageTask', 'policy-violation-retry', { id, attempt: 1 })
      }

      try {
        const genRows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
        const genRecord = genRows[0]
        if (!genRecord) return
        logTaskProgress('ImageTask', 'build-request', {
          id,
          provider: config.provider,
          storyboardId: genRecord.storyboardId,
          sceneId: genRecord.sceneId,
          characterId: genRecord.characterId,
          frameType: genRecord.frameType,
        })

        // 提示词翻译兜底: 非英文 prompt 先翻译成英文再发给上游(nano-banana/Agnes 等)。
        // 中文/日文等非英文 prompt 在大多数 diffusion 模型上效果差,翻译成英文提升出图质量。
        // 跟 video-generation.ts:113 同模式;失败 non-fatal,fallback 到原文。
        let finalPrompt = genRecord.prompt
        if (finalPrompt && hasNonEnglishChars(finalPrompt)) {
          try {
            logTaskProgress('ImageTask', 'translating-prompt', { id, original: finalPrompt.slice(0, 80) })
            finalPrompt = await translatePromptToEnglish(finalPrompt)
            logTaskProgress('ImageTask', 'translated-prompt', { id, translated: finalPrompt.slice(0, 80) })
          } catch (err: any) {
            logTaskWarn('ImageTask', 'translation-failed', { id, error: err.message })
            // translation failure is non-fatal, fall through with original prompt
          }
        }

        const resolvedReferenceImages = await normalizeReferenceImages(genRecord.referenceImages)
        const { url, method, headers, body } = adapter.buildGenerateRequest(config, {
          id: genRecord.id,
          model: genRecord.model,
          prompt: finalPrompt,
          size: genRecord.size,
          frameType: genRecord.frameType,
          referenceImages: resolvedReferenceImages ? JSON.stringify(resolvedReferenceImages) : null,
        })
        logTaskProgress('ImageTask', 'request', {
          id,
          provider: config.provider,
          method,
          url: redactUrl(url),
          model: genRecord.model,
        })
        logTaskPayload('ImageTask', 'request payload', {
          id,
          method,
          url,
          headers,
          body,
        })

        const resp = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        })

        if (resp.ok) {
          const respText = await resp.text()
          let result: any = null
          try {
            result = JSON.parse(respText)
          } catch (parseErr: any) {
            // JSON 解析失败(空 body / 非 JSON / 截断)— 记 body 帮后续诊断
            logTaskPayload('ImageTask', 'non-json-response', {
              id,
              status: resp.status,
              contentType: resp.headers.get('content-type'),
              body: respText.slice(0, 800),
              error: parseErr.message,
            })
            throw new Error(`Provider returned non-JSON (status ${resp.status}, content-type=${resp.headers.get('content-type')}): ${respText.slice(0, 200)}`)
          }
          logTaskPayload('ImageTask', 'response payload', { id, provider: config.provider, result })
          const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

          if (!isAsync && imageUrl) {
            db.update(schema.imageGenerations)
              .set({ imageUrl, status: 'processing', updatedAt: now() })
              .where(eq(schema.imageGenerations.id, id))
              .run()
            logTaskProgress('ImageTask', 'sync-complete', { id, imageUrl })
            await handleImageComplete(id, config.provider, imageUrl)
            return
          }

          if (!isAsync && !imageUrl) {
            const b64 = adapter.extractImageBase64(result)
            if (b64) {
              logTaskProgress('ImageTask', 'sync-base64-complete', { id, mimeType: b64.mimeType })
              await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
              return
            }
            throw new Error('No image URL or base64 data in response')
          }

          // 异步模式
          db.update(schema.imageGenerations)
            .set({ taskId, status: 'processing', updatedAt: now() })
            .where(eq(schema.imageGenerations.id, id))
            .run()
          logTaskProgress('ImageTask', 'poll-start', { id, taskId, provider: config.provider })
          if (adapter.provider === 'vidu') {
            logTaskProgress('ImageTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
            return
          }
          pollImageTask(id, config, taskId!)
          return
        }

        // 非 2xx 响应
        const errText = await resp.text().catch(() => '')
        const isPolicyViolation = resp.status === 400 && errText.includes('content_policy_violation')

        if (isPolicyViolation) {
          // 策略违规: 用更激进的清洗重试一次
          if (retryCount === 0) {
            retryCount++
            const originalPrompt = genRecord.prompt || ''
            const aggressivePrompt = sanitizeImagePromptAggressive(originalPrompt)
            logTaskWarn('ImageTask', 'policy-violation-retrying-with-aggressive', {
              id,
              originalPreview: originalPrompt.slice(0, 80),
              aggressivePreview: aggressivePrompt.slice(0, 80),
            })
            // 更新 DB 中的 prompt 为 aggressive 清洗后的版本
            db.update(schema.imageGenerations)
              .set({ prompt: aggressivePrompt, updatedAt: now() })
              .where(eq(schema.imageGenerations.id, id))
              .run()
            continue // 重试循环
          }
          // 已经重试过,直接失败
          throw new Error(`API error ${resp.status}: ${errText}`)
        }

        // 其他错误: 检查是否为临时性错误
        const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
        if (!TRANSIENT_STATUS.has(resp.status)) {
          throw new Error(`API error ${resp.status}: ${errText}`)
        }

        logTaskWarn('ImageTask', 'transient-error-retry', {
          id,
          attempt: attempt + 1,
          status: resp.status,
          body: errText.slice(0, 240),
        })
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      } catch (err: any) {
        // 网络层异常也重试
        const lastErrText = err?.message || String(err)
        logTaskWarn('ImageTask', 'fetch-network-retry', { id, attempt: attempt + 1, error: lastErrText })
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
          continue
        }
        throw err
      }
    }
  } catch (err: any) {
    logTaskError('ImageTask', 'process', { id, provider: config.provider, error: err.message })
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    markRelatedTablesFailed(record, err.message)
  }
}

// 统一失败回写：当 image_generation 标记 failed 时，同步回写关联主表(status=failed)，
// 让前端 watchAsyncResult 能正确识别终态并停止轮询。
// 注意：scenes 有 status 但无 errorMsg，characters 两列都没有，storyboards 有 status 无 errorMsg。
function markRelatedTablesFailed(record: any, errorMsg: string) {
  const ts = now()
  if (record?.sceneId) {
    // scenes 有 status，无 errorMsg
    db.update(schema.scenes).set({ status: 'failed', updatedAt: ts })
      .where(eq(schema.scenes.id, record.sceneId)).run()
    logTaskProgress('ImageTask', 'failed-backfill-scene', { sceneId: record.sceneId })
  }
  if (record?.storyboardId) {
    // storyboards 有 status，无 errorMsg
    const sbUpdate: Record<string, any> = { status: 'failed', updatedAt: ts }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = null
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = null
    else sbUpdate.composedImage = null
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
    logTaskProgress('ImageTask', 'failed-backfill-storyboard', { storyboardId: record.storyboardId })
  }
  // characters 表没有 status / errorMsg 列，跳过。
  // 角色图片失败时前端靠 imageAPI.get(genId) 的 pollImageGeneration 检测，不走 watchAsyncResult。
  if (record?.characterId) {
    logTaskProgress('ImageTask', 'skip-backfill-character', { characterId: record.characterId, reason: 'characters table has no status/errorMsg columns' })
  }
}

async function normalizeReferenceImages(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function pollImageTask(id: number, config: AIConfig, taskId: string) {
  const adapter = getImageAdapter(config.provider)
  const startedAt = Date.now()
  const maxDurationMs = 600_000
  // 指数退避轮询: 3s → 6s → 10s → 20s(封顶)。图片生成通常 5-30s 出图,
  // 起步快一点确认任务已被上游接受,后段拉长减轻 grsai/nano-banana 压力。
  const POLL_INTERVALS_MS = [3_000, 6_000, 10_000, 20_000]
  function getPollIntervalMs(attempt: number): number {
    const idx = Math.min(attempt - 1, POLL_INTERVALS_MS.length - 1)
    return POLL_INTERVALS_MS[idx]
  }

  for (let i = 0; i < 80; i++) {
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      const failMsg = 'Timeout: Polling exceeded 10 minutes'
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: failMsg, updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
      markRelatedTablesFailed(rows[0], failMsg)
      return
    }
    await new Promise(r => setTimeout(r, getPollIntervalMs(i + 1)))
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      const failMsg = 'Timeout: Polling exceeded 10 minutes'
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: failMsg, updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      const rows2 = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
      markRelatedTablesFailed(rows2[0], failMsg)
      return
    }
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress('ImageTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = Math.max(1_000, maxDurationMs - (Date.now() - startedAt))
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const respText = await resp.text()
      let result: any = null
      try {
        result = JSON.parse(respText)
      } catch (parseErr: any) {
        // 轮询响应非 JSON — 记 body 等下次重试
        logTaskPayload('ImageTask', 'non-json-poll-response', {
          id,
          taskId,
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: respText.slice(0, 500),
        })
        continue
      }

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.imageUrl) {
        // 同样先落上游 URL 再下载
        db.update(schema.imageGenerations)
          .set({ imageUrl: pollResp.imageUrl, status: 'processing', updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
        await handleImageComplete(id, config.provider, pollResp.imageUrl)
        return
      }
      if (pollResp.status === 'completed' && adapter.provider === 'gemini') {
        // Gemini 可能返回 base64
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType: b64.mimeType })
          await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
          return
        }
      }
      if (pollResp.status === 'failed') {
        const errorMsg = pollResp.error || 'Generation failed'
        logTaskError('ImageTask', 'poll-failed', { id, taskId, error: errorMsg })
        // 上游明确失败:直接标记 failed + 回写主表,避免被 catch 块当网络错误重试
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
        markRelatedTablesFailed(rows[0], errorMsg)
        return
      }
    } catch (err: any) {
      if (i === 119 || Date.now() - startedAt >= maxDurationMs) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: err.message })
        const failMsg = `Timeout: ${err.message}`
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: failMsg, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        const rows3 = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
        markRelatedTablesFailed(rows3[0], failMsg)
        return
      }
      logTaskWarn('ImageTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
    }
  }
}

async function handleImageComplete(id: number, provider: string, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]

  db.update(schema.imageGenerations)
    .set({ imageUrl, localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'downloaded', { id, provider, localPath })

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
    logTaskSuccess('ImageTask', 'character-image-synced', { id, characterId: record.characterId, localPath })
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
    logTaskSuccess('ImageTask', 'scene-image-synced', { id, sceneId: record.sceneId, localPath })
  }
}

async function handleImageCompleteBase64(id: number, provider: string, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]

  db.update(schema.imageGenerations)
    .set({ localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'saved-base64', { id, provider, mimeType, localPath })

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }
}

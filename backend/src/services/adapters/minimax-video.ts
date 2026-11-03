/**
 * MiniMax 视频生成 Adapter
 * API 风格：OpenAI Chat Completions content 数组格式
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
// ★ Sprint 32 (PM msg-20261103-138): 道具图并进多图参考的公共逻辑
import { mergePropRefsIntoSlots, buildPropRefNotes, logPropRefSlots } from './prop-refs.js'

export class MiniMaxVideoAdapter implements VideoProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    let promptText = record.prompt || ''
    // chatfire 代理的 MiniMax V1 API 实际范围不清楚, 用 4-10 兜底 (最常见的 MiniMax v1 范围).
    // 落库前 storyboard-tools 已 clamp 到 4-15, 这里再保一道防止上游没配 clamp.
    const duration = Math.max(4, Math.min(10, Math.floor(record.duration || 5)))
    promptText += `  --ratio ${record.aspectRatio || '16:9'}  --dur ${duration}`

    const content: any[] = [{ type: 'text', text: promptText }]

    if (record.referenceMode === 'single' && record.imageUrl) {
      content.push({ type: 'image_url', image_url: { url: record.imageUrl }, role: 'reference_image' })
    } else if (record.referenceMode === 'first_last') {
      if (record.firstFrameUrl) {
        content.push({ type: 'image_url', image_url: { url: record.firstFrameUrl }, role: 'first_frame' })
      }
      if (record.lastFrameUrl) {
        content.push({ type: 'image_url', image_url: { url: record.lastFrameUrl }, role: 'last_frame' })
      }
    } else if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        // ★ Sprint 32: 道具图并进 reference_image (末尾追加 → 首帧仍占第 1 位)
        const merged = mergePropRefsIntoSlots(refs, record.propReferenceImages || [], Number.MAX_SAFE_INTEGER)
        for (const url of merged.refs) {
          content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
        }
        if (merged.propSlots.length) {
          // ★ 说明文字插在【参数之前】—— --ratio/--dur 是 chatfire 的命令行参数, 必须在最后
          content[0].text = `${record.prompt || ''}\n${buildPropRefNotes(merged.propSlots)}  --ratio ${record.aspectRatio || '16:9'}  --dur ${duration}`
          logPropRefSlots('minimax', record, merged.refs.length, merged.propSlots, merged.dropped)
        }
      } catch {}
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: { model: record.model || config.model, content },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.task_id || result.id || result.data?.id
    if (!taskId) {
      // 同步返回
      const videoUrl = result.video_url || result.data?.video_url || result.content?.video_url
      if (videoUrl) {
        return { isAsync: false, videoUrl }
      }
      throw new Error('No task_id or video_url in response')
    }
    return { isAsync: true, taskId }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/video_generation/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status || result.state || result.data?.status
    if (status === 'completed' || status === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: result.video_url || result.data?.video_url || result.content?.video_url,
      }
    }
    if (status === 'failed' || status === 'error') {
      return { status: 'failed', error: result.error_msg || result.error || 'Video generation failed' }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_url || result.data?.video_url || result.content?.video_url || null
  }
}

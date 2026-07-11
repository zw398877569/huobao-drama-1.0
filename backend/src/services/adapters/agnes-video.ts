/**
 * Agnes AI 视频生成 Adapter
 * 创建任务: POST /v1/videos
 * 轮询结果: GET /agnesapi?video_id=<VIDEO_ID>
 * 异步任务，响应包含 video_id 和 task_id
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

export class AgnesVideoAdapter implements VideoProviderAdapter {
  provider = 'agnes'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const body: any = {
      model: record.model || 'agnes-video-v2.0',
      prompt: record.prompt || '',
      num_frames: 121,
      frame_rate: 24,
    }

    // 图生视频
    if (record.referenceMode === 'single' && record.imageUrl) {
      body.image = record.imageUrl
    }

    // 多图视频 / 关键帧动画
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (refs.length > 0) {
          body.extra_body = {
            image: refs,
            mode: 'keyframes',
          }
        }
      } catch {
        // ignore
      }
    }

    // 首尾帧
    if (record.referenceMode === 'first_last') {
      const urls = [record.firstFrameUrl, record.lastFrameUrl].filter(Boolean)
      if (urls.length > 0) {
        body.extra_body = {
          ...(body.extra_body || {}),
          image: urls,
          mode: 'keyframes',
        }
      }
    }

    // 时长控制 -> num_frames
    // agnes-video-v2.0 硬性要求 num_frames = 8n + 1 (9, 17, 25, ... 441)
    if (record.duration) {
      const target = Math.min(record.duration * 24, 441)
      body.num_frames = 8 * Math.round(target / 8) + 1
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    // 同步返回视频 URL（极少情况）
    const videoUrl = result.url || result.video_url || result.data?.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }

    // agnes 推荐用 video_id 查任务状态(/agnesapi?video_id=video_xxx)
    // 兼容旧版用 task_id(/v1/videos/<task_id>),两者都返回
    const taskId = result.task_id || result.id
    const videoId = result.video_id
    if (taskId || videoId) {
      return { isAsync: true, taskId, videoId }
    }
    throw new Error('No task_id or video_id in response')
  }

  buildPollRequest(config: AIConfig, videoId: string): ProviderRequest {
    // 推荐方式: GET /agnesapi?video_id=<video_id>
    // 兼容旧版: GET /v1/videos/<task_id> (由调用方传 taskId 进来)
    return {
      url: joinProviderUrl(config.baseUrl, '', `/agnesapi?video_id=${videoId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    // agnes 实际响应字段是 'url' (不是 'video_url')
    const status = result.status
    if (status === 'completed') {
      const videoUrl = result.url || result.video_url || result.remixed_from_video_id
      if (videoUrl) {
        return { status: 'completed', videoUrl }
      }
    }
    if (status === 'failed') {
      const errMsg = result.error?.message || (typeof result.error === 'string' ? result.error : null) || result.error_msg || 'Video generation failed'
      return { status: 'failed', error: errMsg }
    }
    // queued / in_progress 都算 processing
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.remixed_from_video_id || result.video_url || null
  }
}

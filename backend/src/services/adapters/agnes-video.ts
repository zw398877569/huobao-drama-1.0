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
    // 重要: agnes-video-v2.0 要求 image 是可公网访问的 URL,
    // 不接受 data:image base64(会静默失败,任务不进 worker)
    // 如果传进来的是 base64,fallback 到文生视频(去掉 image 字段)
    if (record.referenceMode === 'single' && record.imageUrl) {
      if (record.imageUrl.startsWith('data:')) {
        // 本地 base64,agnes 不支持 → 降级为文生视频
        console.warn('[AgnesVideo] imageUrl is base64, agnes does not support data URL. Falling back to text-to-video.')
      } else {
        body.image = record.imageUrl
      }
    }

    // 多图视频 / 关键帧动画
    // 过滤掉 base64(agnes 不支持),只保留 http URL
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        const httpRefs = refs.filter((r: string) => r && !r.startsWith('data:'))
        if (httpRefs.length > 0) {
          body.extra_body = {
            image: httpRefs,
            mode: 'keyframes',
          }
        }
      } catch {
        // ignore
      }
    }

    // 首尾帧 — 过滤 base64
    if (record.referenceMode === 'first_last') {
      const urls = [record.firstFrameUrl, record.lastFrameUrl]
        .filter((u: string) => u && !u.startsWith('data:'))
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

  buildPollRequest(config: AIConfig, videoId: string, taskId?: string): ProviderRequest {
    // agnes 实际行为(从 response payload 确认):
    //   video_id === task_id,都是 task_xxx 格式
    //   `/agnesapi?video_id=task_xxx` 端点对当前实例 404
    //   `/v1/videos/<task_id>` 兼容端点是真实可用的
    // 优先用 taskId 走 /v1/videos/<task_id>,只有 taskId 缺失才 fallback 到 videoId + 推荐端点
    if (taskId) {
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }
    if (videoId) {
      return {
        url: joinProviderUrl(config.baseUrl, '', `/agnesapi?video_id=${videoId}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }
    throw new Error('buildPollRequest: videoId 和 taskId 都为空')
  }

  parsePollResponse(result: any): VideoPollResponse {
    // agnes 实际响应字段是 'url' (不是 'video_url')
    // 日志(14) 案例: status=completed progress=100 但 result.url 为空,
    // 需要从 data/output/result 嵌套结构里再找一遍
    const status = result.status
    if (status === 'completed') {
      // 优先级: SKILL.md 文档明确说最终 URL 在 remixed_from_video_id
      // 其次尝试 url / video_url 等其他可能字段
      const videoUrl = result.remixed_from_video_id
        || result.url
        || result.video_url
        || result.data?.url
        || result.data?.video_url
        || result.data?.remixed_from_video_id
        || result.output?.url
        || result.output?.video_url
        || result.output?.remixed_from_video_id
        || result.result?.url
        || result.result?.remixed_from_video_id
        || result.videos?.[0]?.url
        || result.videos?.[0]?.remixed_from_video_id
        || result.metadata?.url
      if (videoUrl) {
        return { status: 'completed', videoUrl }
      }
      // status=completed 但 url 缺失(agnes bug 或私有 CDN 未就绪),
      // 标 failed 不再空转,让前端知道
      // 打印所有字段帮助调试
      console.error(`[AgnesVideo] completed but no URL found. Fields: ${Object.keys(result).join(', ')}. Full response:`, JSON.stringify(result).slice(0, 2000))
      return {
        status: 'failed',
        error: 'agnes reported status=completed but no url/video_url in response',
      }
    }
    if (status === 'failed') {
      const errMsg = result.error?.message
        || (typeof result.error === 'string' ? result.error : null)
        || result.error_msg
        || 'Video generation failed'
      return { status: 'failed', error: errMsg }
    }
    // queued / in_progress / processing 都算 processing
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.remixed_from_video_id
      || result.url
      || result.video_url
      || result.data?.remixed_from_video_id
      || result.data?.url
      || null
  }
}

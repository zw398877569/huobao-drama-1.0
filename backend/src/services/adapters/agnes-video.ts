/**
 * Agnes AI 视频生成 Adapter
 * 创建任务: POST /v1/videos
 * 轮询结果: GET /agnesapi?video_id=<VIDEO_ID> (推荐) 或 GET /v1/videos/<TASK_ID> (兼容)
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

// 合法帧数查找表 (8n+1, <= 441)
const VALID_NUM_FRAMES = [81, 121, 161, 201, 241, 281, 321, 361, 441]

function clampNumFrames(durationSec?: number | null): number {
  if (!durationSec) return 121
  const target = Math.min(durationSec * 24, 441)
  // 找最接近且不超标的合法帧数
  let best = VALID_NUM_FRAMES[0]
  for (const f of VALID_NUM_FRAMES) {
    if (f <= target) { best = f } else { break }
  }
  return best
}

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
    // 重要: agnes-video-v2.0 要求 image 是可公网访问的 URL 或 base64 数据
    if (record.referenceMode === 'single' && record.imageUrl) {
      body.image = record.imageUrl
    }

    // 多图视频 / 关键帧动画 — 保留所有有效 URL（http(s) 或 base64）
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        const validRefs = refs.filter((r: string) => r && (r.startsWith('http') || r.startsWith('data:')))
        if (validRefs.length > 0) {
          body.extra_body = {
            image: validRefs,
            mode: 'keyframes',
          }
        }
      } catch {
        // ignore
      }
    }

    // 首尾帧 — 保留所有有效 URL
    if (record.referenceMode === 'first_last') {
      const urls: string[] = []
      if (record.firstFrameUrl && (record.firstFrameUrl.startsWith('http') || record.firstFrameUrl.startsWith('data:'))) {
        urls.push(record.firstFrameUrl)
      }
      if (record.lastFrameUrl && (record.lastFrameUrl.startsWith('http') || record.lastFrameUrl.startsWith('data:'))) {
        urls.push(record.lastFrameUrl)
      }
      if (urls.length > 0) {
        body.extra_body = {
          ...(body.extra_body || {}),
          image: urls,
          mode: 'keyframes',
        }
      }
    }

    // 时长控制 -> num_frames (使用合法查找表)
    body.num_frames = clampNumFrames(record.duration)
    body.frame_rate = 24

    // 可选参数: negative_prompt, seed
    if (record.negativePrompt) body.negative_prompt = record.negativePrompt
    if (record.seed != null) body.seed = record.seed

    // 分辨率/宽高比
    if (record.aspectRatio) {
      if (record.aspectRatio === '9:16') {
        body.height = 768
        body.width = 432
      } else if (record.aspectRatio === '16:9') {
        body.height = 432
        body.width = 768
      } else {
        const [w, h] = record.aspectRatio.split(':').map(Number)
        if (w && h) { body.width = w; body.height = h }
      }
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

    // 优先使用 video_id（技能 v0.1.0 推荐）
    // 兼容旧版 task_id
    const taskId = result.task_id || result.id
    const videoId = result.video_id
    if (taskId || videoId) {
      return { isAsync: true, taskId, videoId }
    }
    throw new Error('No task_id or video_id in response')
  }

  buildPollRequest(config: AIConfig, videoId: string, taskId?: string): ProviderRequest {
    // 技能文档推荐优先使用 /agnesapi?video_id=...
    if (videoId) {
      const baseUrl = (config.baseUrl || '').replace(/\/+$/, '')
      return {
        url: `${baseUrl}/agnesapi?video_id=${videoId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }
    if (taskId) {
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
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

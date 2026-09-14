/**
 * MiniMax 官方 V2 视频生成 Adapter (Hailuo-03 / MiniMax-H3)
 *
 * API 文档: /Users/mac/Obsidian/ComfyUi/MiniMax官方/
 *   - 创建: POST /v2/video_generation
 *   - 查询: GET  /v2/query/video_generation/{task_id}
 *   - 模型: MiniMax-H3
 *
 * 与现有 minimax-video (代理路径 /v1) 的关键差异:
 * - baseUrl 直接走官方 https://api.minimax.cn (不走 chatfire 代理)
 * - 端点前缀 /v2 不是 /v1
 * - response 用 { task: { id, status, content: { url } } } 包装, 不是顶层字段
 * - content 数组 role 支持 first_frame / last_frame / reference_image (i2va/FL2V/r2va 互斥)
 * - resolution 必填 (enum: 480P / 768P / 2K), ratio 可选 (default adaptive)
 * - duration 必填 (4-15 秒)
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

export class MiniMaxOfficialVideoAdapter implements VideoProviderAdapter {
  readonly provider = 'minimax-official'

  /** 默认分辨率 — MiniMax-H3 支持 768P / 2K, 取 768P 控制成本 (后续可挂 record.resolution 让用户挑) */
  private static readonly DEFAULT_RESOLUTION = '768P'
  /** ratio 在 t2va 必填且不能是 adaptive, i2va/r2va 可选 (api 内部按 adaptive 处理) */
  private static readonly VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const baseUrl = config.baseUrl || 'https://api.minimax.cn'
    const content: any[] = [{ type: 'text', text: record.prompt || '' }]

    if (record.referenceMode === 'first_last') {
      // 首尾帧 (FL2V): text + first_frame + last_frame
      if (record.firstFrameUrl) {
        content.push({ type: 'image_url', image_url: { url: record.firstFrameUrl }, role: 'first_frame' })
      }
      if (record.lastFrameUrl) {
        content.push({ type: 'image_url', image_url: { url: record.lastFrameUrl }, role: 'last_frame' })
      }
    } else if (record.referenceMode === 'single' && record.imageUrl) {
      // 单图参考 (i2va): text + first_frame
      // 与官方 spec 对齐 — single 走 first_frame role (单图生视频)
      content.push({ type: 'image_url', image_url: { url: record.imageUrl }, role: 'first_frame' })
    } else if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      // 多图参考 (r2va): text + N 张 reference_image
      // V2 spec 限制 reference_image ≤ 9, 与 autodl-comfyui 行为对齐
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(refs)) {
          refs.slice(0, 9).forEach((url: string) => {
            if (typeof url === 'string' && url.length > 0) {
              content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
            }
          })
        }
      } catch {
        // ignore parse errors
      }
    }
    // mode === 'none' (或未识别): 只发 text (T2V)

    // ratio: t2va (无图) 必填且不能是 adaptive, i2va/r2va (有 first_frame/last_frame) 走 adaptive
    const isImageBased = record.referenceMode === 'single' || record.referenceMode === 'first_last' ||
      (record.referenceMode === 'multiple' && !!record.referenceImageUrls)
    const ratio = isImageBased ? 'adaptive' : (record.aspectRatio && record.aspectRatio !== 'adaptive' ? record.aspectRatio : '16:9')

    // duration 必填, MiniMax-H3 仅支持 4-15 秒, 缺省 5, 越界 clamp 到合法范围
    // (用户 storyboard 可能填 2/3/20 等, 不 clamp 直接报 400)
    const requestedDuration = record.duration || 5
    const duration = Math.max(4, Math.min(15, Math.floor(requestedDuration)))

    const body: any = {
      model: record.model || config.model || 'MiniMax-H3',
      content,
      // resolution 必填, enum: 480P / 768P / 2K; MiniMax-H3 支持 768P/2K, 默认 768P
      resolution: '768P',
      duration,
      ratio,
    }

    return {
      url: joinProviderUrl(baseUrl, '', '/v2/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    // V2 响应格式: { task_id: "..." } 顶层, 或 { data: { task_id: ... } } 包装
    const taskId = result?.task_id || result?.data?.task_id
    if (taskId) return { isAsync: true, taskId }
    // 兜底: 同步返回 content.url
    const videoUrl = result?.content?.url || result?.data?.content?.url
    if (videoUrl) return { isAsync: false, videoUrl }
    throw new Error(`MiniMax Official: no task_id or video_url in response: ${JSON.stringify(result).slice(0, 200)}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const baseUrl = config.baseUrl || 'https://api.minimax.cn'
    return {
      url: joinProviderUrl(baseUrl, '', `/v2/query/video_generation/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    // V2 响应: { task: { id, status, content: { url }, error: { code, message } } }
    const task = result?.task || result || {}
    const rawStatus = String(task?.status || '').toLowerCase()

    if (rawStatus === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: task?.content?.url || task?.video_url || undefined,
      }
    }
    if (rawStatus === 'failed' || rawStatus === 'cancelled') {
      const err = task?.error
      return {
        status: 'failed',
        error: err?.message || err?.code || `MiniMax Official generation ${rawStatus}`,
      }
    }
    // queued / running 都视为 processing
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result?.task?.content?.url || result?.content?.url || result?.video_url || null
  }
}

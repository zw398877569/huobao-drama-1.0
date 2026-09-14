/**
 * MiniMax Hailuo V1 视频生成 Adapter
 *
 * API 文档: /Users/mac/Obsidian/ComfyUi/MiniMax hailuo/
 *   - 文生视频 / 图生视频 / 首尾帧生成 / 查询任务状态 / 视频下载
 *   - 端点: POST /v1/video_generation  +  GET /v1/query/video_generation  +  GET /v1/files/retrieve
 *
 * 与现有 minimax-official (H3 V2) 的关键差异:
 *   - V1 只接 referenceMode: none | single (I2V) | first_last (FL2V) 三种, **不支持多图参考 (multiple)**
 *   - 端点前缀 /v1 不是 /v2
 *   - request body 字段: model, prompt, first_frame_image, last_frame_image, duration, resolution
 *   - resolution 是 enum (512P/768P/1080P), 不是 ratio
 *   - response 用 base_resp.status_code (0=成功) 包裹
 *   - 成功时返回 file_id, **需要再调一次 /v1/files/retrieve 拿下载 URL** (parsePollResponse 内部做第二步)
 *   - 状态值: Preparing / Queueing / Processing / Success / Fail (大小写敏感)
 *   - 鉴权头不带 MiniMax-H3 的 reference 指令行/首尾帧 role 字段, 直接用 first_frame_image / last_frame_image 字段名
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
import { logTaskWarn } from '../../utils/task-logger.js'

/** Hailuo V1 合法 duration 集合 (Hailuo-2.3 / Hailuo-02 在 768P 下) */
const VALID_DURATIONS = new Set([6, 10])

/** Hailuo V1 合法 resolution 集合 */
const VALID_RESOLUTIONS = new Set(['512P', '768P', '1080P'])

/** 把 ratio 映射到 Hailuo V1 resolution 枚举 (T2V 用, 图生视频走图片比例不需要这个) */
function pickResolution(aspectRatio?: string | null, model: string = ''): string {
  // Hailuo-02 支持 512P, 其他默认 768P
  if (model.includes('Hailuo-02') && (aspectRatio === '1:1' || aspectRatio === '21:9')) {
    return '512P'
  }
  return '768P' // 默认 768P (兼容所有模型)
}

export class MiniMaxHailuoVideoAdapter implements VideoProviderAdapter {
  readonly provider = 'minimax-hailuo'

  // 存最近一次 buildPollRequest 传入的 config, 给 parsePollResponse 用 (做 /v1/files/retrieve 二次拉)
  // interface VideoProviderAdapter.parsePollResponse 只接 result, 不传 config,
  // 不想改 interface, 走私有字段缓存 (一次 buildPollRequest 之后下次 parsePollResponse 必用同一 config)
  private lastConfig: AIConfig | null = null

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const baseUrl = config.baseUrl || 'https://api.minimax.cn'
    const model = record.model || config.model || 'MiniMax-Hailuo-2.3'

    const body: any = {
      model,
      prompt: record.prompt || '',
    }

    // Hailuo V1 不支持多图参考 (multiple), 用首张图 fallback 到 I2V 并 warn
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(refs) && refs.length > 0) {
          body.first_frame_image = refs[0]
          logTaskWarn('HailuoV1', 'multi-ref-not-supported', {
            storyboardId: (record as any).storyboardId,
            refCount: refs.length,
            fallback: 'used first ref as first_frame_image',
          })
        }
      } catch {
        // ignore parse error
      }
    } else if (record.referenceMode === 'first_last') {
      // FL2V: 必须有 first_frame_image + last_frame_image
      // 注意: FL2V 只支持 Hailuo-02 模型, 其他模型 backend 不报错但 frontend 应该 warn
      if (record.firstFrameUrl) body.first_frame_image = record.firstFrameUrl
      if (record.lastFrameUrl) body.last_frame_image = record.lastFrameUrl
    } else if (record.referenceMode === 'single' && record.imageUrl) {
      // I2V: first_frame_image
      body.first_frame_image = record.imageUrl
    }
    // mode === 'none' 或未识别: 只发 text (T2V), 不传 image 字段

    // duration 必填, Hailuo-2.3 / Hailuo-02 接受 6 / 10 (768P 下),
    // 数据层已 clamp 到 [4, 15], 这里 snap 到 6 或 10
    const requestedDuration = Math.floor(record.duration || 6)
    const duration = snapDuration(requestedDuration)

    // resolution: T2V (无 first_frame_image) 才用这个, I2V/FL2V 走图片比例
    if (!body.first_frame_image) {
      body.resolution = pickResolution(record.aspectRatio, model)
    } else {
      // I2V/FL2V: 默认 768P, 10s 时 Hailuo-2.3 也支持 768P (per spec)
      body.resolution = duration === 10 ? '768P' : '768P'
    }
    body.duration = duration

    return {
      url: joinProviderUrl(baseUrl, '', '/v1/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    // V1 响应: { task_id: "...", base_resp: { status_code: 0, status_msg: "success" } }
    const taskId = result?.task_id || result?.data?.task_id
    const statusCode = result?.base_resp?.status_code ?? result?.data?.base_resp?.status_code

    if (statusCode !== undefined && statusCode !== 0) {
      const msg = result?.base_resp?.status_msg || result?.data?.base_resp?.status_msg || 'unknown error'
      throw new Error(`MiniMax Hailuo create failed: status_code=${statusCode}, ${msg}`)
    }

    if (!taskId) {
      throw new Error(`MiniMax Hailuo: no task_id in response: ${JSON.stringify(result).slice(0, 200)}`)
    }
    return { isAsync: true, taskId }
  }

  buildPollRequest(config: AIConfig, videoId: string, taskId?: string): ProviderRequest {
    this.lastConfig = config
    const baseUrl = config.baseUrl || 'https://api.minimax.cn'
    const id = taskId || videoId
    return {
      url: `${joinProviderUrl(baseUrl, '', '/v1/query/video_generation')}?task_id=${encodeURIComponent(id)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  async parsePollResponse(result: any): Promise<VideoPollResponse> {
    // V1 响应: { task_id, status: "Success" | "Processing" | "Preparing" | "Queueing" | "Fail", file_id, base_resp, ... }
    const status = String(result?.status || '')

    if (status === 'Success') {
      const fileId = result?.file_id
      if (!fileId) {
        return { status: 'failed', error: 'MiniMax Hailuo: Success 但无 file_id' }
      }
      // 成功时再调一次 /v1/files/retrieve 拿 download URL
      try {
        const config = this.lastConfig
        if (!config) {
          return { status: 'failed', error: 'MiniMax Hailuo: no config available (lastConfig 未被 buildPollRequest 设置过)' }
        }
        const baseUrl = config.baseUrl || 'https://api.minimax.cn'
        const apiKey = config?.apiKey
        if (!apiKey) {
          return { status: 'failed', error: 'MiniMax Hailuo: missing apiKey for file retrieve' }
        }
        const url = `${joinProviderUrl(baseUrl, '', '/v1/files/retrieve')}?file_id=${fileId}`
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!resp.ok) {
          return { status: 'failed', error: `MiniMax Hailuo file retrieve failed: ${resp.status}` }
        }
        const body = await resp.json()
        // V1 文件响应: { file: { file_id, bytes, created_at, filename, purpose, download_url }, base_resp }
        const downloadUrl = body?.file?.download_url
        if (!downloadUrl) {
          return { status: 'failed', error: 'MiniMax Hailuo: file retrieve 无 download_url' }
        }
        return { status: 'completed', videoUrl: downloadUrl }
      } catch (e: any) {
        return { status: 'failed', error: `MiniMax Hailuo file retrieve error: ${e.message}` }
      }
    }

    if (status === 'Fail') {
      const baseResp = result?.base_resp || result?.data?.base_resp
      return { status: 'failed', error: baseResp?.status_msg || result?.error_msg || 'MiniMax Hailuo generation failed' }
    }

    // Preparing / Queueing / Processing 都视为 processing
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    // poll 阶段已通过 parsePollResponse 转成 videoUrl, 这里一般用不到
    return result?.video_url || result?.data?.video_url || null
  }
}

/**
 * Snap duration 到 Hailuo-2.3/02 的合法值 (6 / 10).
 * < 6 → 6, > 10 → 10, 中间值取最近的 (4-7→6, 8-15→10)
 */
function snapDuration(seconds: number): number {
  if (seconds < 6) return 6
  if (seconds > 10) return 10
  // 6-7 → 6, 8-10 → 10
  return seconds <= 7 ? 6 : 10
}

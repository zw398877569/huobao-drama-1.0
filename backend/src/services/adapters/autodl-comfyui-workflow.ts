/**
 * AutoDL 平台 ComfyUI Workflow 视频生成 Adapter
 *
 * API 文档: https://autodl.art/docs/comfyui_api/
 * 工作流: H3 三件套 (T2V / FL2V / Ref2V)
 *
 * 与 minimax-video 的关键差异:
 * - 鉴权头不带 Bearer (裸 token)
 * - URL 路径里嵌入 workflow_id,根据 referenceMode 路由
 * - resolution 字段是 autodl 自己的命名 (480p竖/480p横/1080p横/768p竖/768p横/1080p竖)
 * - 响应格式: { code: "Success", data: { status, results: [{url, type, ...}], task_id } }
 * - 单 provider 路由到 4 个 workflow_id (T2V / FL2V / Ref2V / Ref2V-15s)
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

export class AutoDLComfyUIWorkflowAdapter implements VideoProviderAdapter {
  readonly provider = 'autodl-comfyui'

  /** H3 文生视频 (T2V) — duration 1-10s */
  static readonly WORKFLOW_T2V = 'minimax_h3_lightx2v_no_pic'
  /** H3 首尾帧生视频 (FL2V) — duration 1-10s */
  static readonly WORKFLOW_FL2V = 'minimax_h3_lightx2v'
  /** H3 多图参考生视频 (Ref2V) — duration 1-10s, 最多 9 张参考图 */
  static readonly WORKFLOW_REF2V = 'minimax_h3_lightx2v_v5'
  /** H3 多图参考生视频 15 秒版 (Ref2V) — duration 1-15s, 最多 9 张参考图 */
  static readonly WORKFLOW_REF2V_15S = 'minimax_h3_lightx2v_v5_15s'

  /** Ref2V 1-10s 用 v5; 11-15s 自动切到 v5_15s */
  private static readonly REF2V_MAX_SHORT_S = 10

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const { workflowId, body } = this.buildBodyForRecord(record)
    const url = joinProviderUrl(
      config.baseUrl || 'https://autodl.art/api/v1',
      '',
      `/comfyui/comfyui_workflow/${workflowId}`
    )

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 裸 token, 不带 Bearer — autodl 平台特殊点
        'Authorization': config.apiKey,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result?.task_id || result?.data?.task_id
    if (!taskId) {
      const videoUrl = this.extractVideoUrl(result)
      if (videoUrl) return { isAsync: false, videoUrl }
      throw new Error('AutoDL ComfyUI: no task_id in response')
    }
    return { isAsync: true, taskId }
  }

  buildPollRequest(config: AIConfig, _videoId: string, taskId?: string): ProviderRequest {
    if (!taskId) {
      throw new Error('AutoDL ComfyUI: taskId required for polling')
    }
    const url = joinProviderUrl(
      config.baseUrl || 'https://autodl.art/api/v1',
      '',
      `/comfyui/comfyui_workflow/result/${taskId}`
    )
    return {
      url,
      method: 'GET',
      headers: {
        'Authorization': config.apiKey,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    // 响应格式: { code: "Success", data: { status, results: [...] } }
    const data = result?.data || result || {}
    const rawStatus = String(data?.status || '').toLowerCase()

    if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'succeeded') {
      const videoUrl = this.extractVideoUrl(result)
      return { status: 'completed', videoUrl: videoUrl || undefined }
    }

    if (rawStatus === 'failed' || rawStatus === 'error') {
      return {
        status: 'failed',
        error: data?.error || data?.message || `AutoDL ComfyUI generation failed (code=${result?.code})`,
      }
    }

    // pending / running / queued / processing 都视为 processing
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const data = result?.data || result || {}
    const results = data?.results
    if (Array.isArray(results) && results.length > 0) {
      // 优先找 type='video' 的 result, 没有就取第一个
      const video = results.find((r: any) => r?.type === 'video') || results[0]
      return video?.url || null
    }
    return null
  }

  // ============ 内部 helpers ============

  private buildBodyForRecord(record: VideoGenerationRecord): { workflowId: string; body: any } {
    const mode = record.referenceMode || 'none'
    const refCount = this.countRefImages(record.referenceImageUrls)
    const hasFirstLast = !!(record.firstFrameUrl && record.lastFrameUrl)

    let workflowId: string
    let refs: string[] = []
    let firstFrame: string | undefined
    let lastFrame: string | undefined

    if (mode === 'multiple' && refCount >= 1) {
      // 多图参考: 走 Ref2V 工作流 (按 duration 自动选 v5 / v5_15s)
      workflowId = this.pickRef2VWorkflowId(record.duration)
      refs = this.parseRefImages(record.referenceImageUrls)
    } else if (mode === 'single' && record.imageUrl) {
      // 单图参考: 走 Ref2V 工作流, 仅填 ref_image_0
      // 与 minimax-video 行为对齐 (single → reference_image, 不是 first_frame)
      workflowId = this.pickRef2VWorkflowId(record.duration)
      refs = [record.imageUrl]
    } else if (mode === 'first_last' || hasFirstLast) {
      // 首尾帧: 走 FL2V 工作流
      workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_FL2V
      firstFrame = record.firstFrameUrl || undefined
      lastFrame = record.lastFrameUrl || undefined
    } else {
      // 其他: 文生视频
      workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_T2V
    }

    const supports1080p =
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S
    const body: any = {
      prompt: record.prompt || '',
    }

    // duration 上限看具体路由: T2V/FL2V/Ref2V(v5) 1-10; Ref2V(v5_15s) 1-15
    const durationCap = workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S ? 15 : 10
    if (record.duration) {
      body.duration = Math.max(1, Math.min(durationCap, Math.floor(record.duration)))
    }

    // resolution: 纵横比 → autodl 命名
    body.resolution = this.mapResolution(record.aspectRatio, supports1080p)

    if (workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_FL2V) {
      if (firstFrame) body.first_frame = firstFrame
      if (lastFrame) body.last_frame = lastFrame
    } else if (
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S
    ) {
      refs.slice(0, 9).forEach((url, i) => {
        body[`ref_image_${i}`] = url
      })
    }

    return { workflowId, body }
  }

  /**
   * Ref2V 工作流按 duration 自动选 v5 (≤10s) 或 v5_15s (11-15s)
   * duration 缺省时 fallback 到 v5 (1-10s 是更常用的形态)
   */
  private pickRef2VWorkflowId(duration?: number | null): string {
    if (duration && duration > AutoDLComfyUIWorkflowAdapter.REF2V_MAX_SHORT_S) {
      return AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S
    }
    return AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V
  }

  private parseRefImages(json?: string | null): string[] {
    if (!json) return []
    try {
      const arr = JSON.parse(json)
      if (!Array.isArray(arr)) return []
      return arr.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(0, 9)
    } catch {
      return []
    }
  }

  private countRefImages(json?: string | null): number {
    return this.parseRefImages(json).length
  }

  /**
   * 纵横比 → autodl resolution 命名
   * 文生视频/首尾帧工作流支持 480p竖/480p横/768p竖/768p横
   * 多图参考工作流(及 15s 版)额外支持 1080p横/1080p竖
   */
  private mapResolution(aspectRatio?: string | null, supports1080p = false): string {
    if (!aspectRatio) return '768p竖'
    const isVert = aspectRatio === '9:16' || aspectRatio === '3:4' || aspectRatio === '2:3' || aspectRatio === '4:5'
    const isHor = aspectRatio === '16:9' || aspectRatio === '4:3' || aspectRatio === '21:9' || aspectRatio === '3:2'
    if (isVert) return supports1080p ? '1080p竖' : '768p竖'
    if (isHor) return supports1080p ? '1080p横' : '768p横'
    // 1:1 等不支持的纵横比, fallback 到 768p竖
    return '768p竖'
  }
}

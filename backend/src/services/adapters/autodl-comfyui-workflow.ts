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
 *
 * 工作流中文目录见 docs/comfyui-workflows.md
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

export class AutoDLComfyUIWorkflowAdapter implements VideoProviderAdapter {
  readonly provider = 'autodl-comfyui'

  /**
T2V 文生视频（无参考图）
时长 1-10s，分辨率 480p/768p（不支持 1080p）
输入：仅 prompt
路由：referenceMode=none 且无 first/last frame
场景：完全没参考图、只能靠文字描述画面的分镜
*/
  static readonly WORKFLOW_T2V = 'minimax_h3_lightx2v_no_pic'
  /**
FL2V 首尾帧生视频
时长 1-10s，分辨率 480p/768p（不支持 1080p）
输入：prompt + first_frame URL + last_frame URL
路由：referenceMode=first_last 或同时提供 firstFrameUrl+lastFrameUrl
场景：镜头有明确起止画面、需要平滑过渡
*/
  static readonly WORKFLOW_FL2V = 'minimax_h3_lightx2v'
  /**
Ref2V 多图参考（1-10s）
时长 1-10s，分辨率 480p/768p/1080p（横竖都支持）
输入：prompt + 最多 9 张 ref_image_0..8 URL
路由：referenceMode=multiple/single 且 duration ≤ 10
场景：短镜头（≤10s）需要角色/场景一致性
*/
  static readonly WORKFLOW_REF2V = 'minimax_h3_lightx2v_v5'
  /**
Ref2V 多图参考（1-15s）
时长 1-15s，分辨率 480p/768p/1080p（横竖都支持）
输入：prompt + 最多 9 张参考图
路由：referenceMode=multiple/single 且 11 ≤ duration ≤ 15
场景：长镜头（11-15s）需要多图参考
*/
  static readonly WORKFLOW_REF2V_15S = 'minimax_h3_lightx2v_v5_15s'

  /**
Ref2V 升级画质版（zm_u24）
时长 1-15s，分辨率 480p/768p（不支持 1080p）
输入：prompt + 最多 9 张参考图（支持音频输入）
路由：用户在前端 model 弹窗显式选择
场景：强调成片质量、可接受稍长生成时间
注意：仅 mode=multiple/single 生效；模式不匹配会被 adapter 静默 fallback 到 FL2V/T2V 并写 model-mode-mismatch 日志
*/
  static readonly WORKFLOW_REF2V_QUALITY = 'minimax_h3_zm_u24'
  /**
Ref2V 高速版（zm_u08）
时长 1-15s，分辨率 480p/768p（不支持 1080p）
输入：prompt + 最多 9 张参考图（支持音频输入）
路由：用户显式选择
场景：迭代阶段、需要快速出图验证构图/节奏
注意：同 zm_u24，模式不匹配会被 fallback
*/
  static readonly WORKFLOW_REF2V_SPEED = 'minimax_h3_zm_u08'
  /**
Ref2V 多图+多音频 v2（1-10s）
时长 1-10s，分辨率 480p/768p/1080p（横竖都支持）
输入：prompt + 最多 9 张参考图 + 多段音频（音频驱动画面）
路由：用户显式选择
场景：角色台词/旁白对口型、配乐驱动画面节奏
注意：当前前端未接 audioUrls schema，audio 字段为空（Phase 3b 再加）
*/
  static readonly WORKFLOW_REF2V_AUDIO = 'minimax_h3_image_audio_to_video_v2'
  /**
Ref2V 多图+多音频 v2 15s 版
时长 1-15s，分辨率 仅 480p/768p（不支持 1080p）
输入：prompt + 最多 9 张参考图 + 多段音频
路由：用户显式选择
场景：长镜头（11-15s）需要音频驱动
注意：同 audio v2 的限制
*/
  static readonly WORKFLOW_REF2V_AUDIO_15S = 'minimax_h3_image_audio_to_video_v2_15s'

  /** 所有 Ref2V 变体 — record.model 显式选择时识别 */
  private static readonly REF2V_VARIANTS = [
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S,
  ]

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

    // 用户显式选了具体 workflow (通过 record.model,前端 model 弹窗选了 zm_u24/u08/audio 等) 时,
    // 强制走 Ref2V body 构造。audio 字段暂未接入(后续 Phase 3b 加 audioUrls schema 再说)。
    // 仅当 mode 是 multiple/single 时显式选择才生效 — FL2V/T2V 模式不接 Ref2V 变体
    const explicitModel = record.model
    const isExplicitRef2V =
      !!explicitModel && (AutoDLComfyUIWorkflowAdapter.REF2V_VARIANTS as readonly string[]).includes(explicitModel)

    // 用户显式选了 Ref2V 变体但 mode 不匹配 (first_last / none) 时, 会被下面逻辑强行
    // fallback 到 FL2V/T2V — 这是因为新加的 zm_u24/u08/audio 等 Ref2V 变体都不接
    // first_frame/last_frame 输入, 没图时 Ref2V API 也没法调。
    // 这种 fallback 是故意的 (保持 batch 流不中断), 但要 log 一条 model-mode-mismatch
    // 方便排查「为什么我选了 zm_u24 但实际跑了 FL2V」。
    let modelModeMismatch: 'first_last' | 'no_reference_images' | null = null
    const userPickedRef2V = isExplicitRef2V

    if (userPickedRef2V && (mode === 'multiple' || mode === 'single')) {
      workflowId = explicitModel!
      refs = mode === 'multiple'
        ? this.parseRefImages(record.referenceImageUrls)
        : [record.imageUrl!]
    } else if (mode === 'multiple' && refCount >= 1) {
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
      if (userPickedRef2V) modelModeMismatch = 'first_last'
    } else {
      // 其他: 文生视频
      workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_T2V
      if (userPickedRef2V) modelModeMismatch = 'no_reference_images'
    }

    if (modelModeMismatch) {
      // 用户在 model 弹窗选了 Ref2V 变体 (zm_u24/u08/audio 等), 但 storyboard 没有
      // 相应的参考模式 — adapter 静默 fallback 到 FL2V/T2V。记录原因便于排查。
      logTaskWarn('VideoTask', 'model-mode-mismatch', {
        videoGenId: record.id,
        requestedModel: explicitModel,
        actualWorkflow: workflowId,
        reason: modelModeMismatch,
        referenceMode: mode,
      })
    }

    const supports1080p =
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S ||
      // image_audio_to_video_v2 文档支持 1080p横竖
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO
    const body: any = {
      prompt: record.prompt || '',
    }

    // duration 上限看具体路由:
    //   T2V/FL2V/Ref2V(v5)/image_audio_to_video_v2 = 1-10
    //   Ref2V(v5_15s)/zm_u24/zm_u08/image_audio_to_video_v2_15s = 1-15
    const is15s = (
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S
    )
    const durationCap = is15s ? 15 : 10
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

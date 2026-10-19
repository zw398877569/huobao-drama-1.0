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
注意：Sprint 14 起 audioUrls 由 video-generation.ts 从 storyboards.tts_audio_url 自动注入（无需前端传参）
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

  /**
   * 「H3 多图多音频」工作流子集 — 只有这 4 个接受 ref_audio_0/1/2 输入。
   * 纯 Ref2V (v5 / v5_15s)、T2V、FL2V 不接受音频，传了也会被平台忽略。
   * 依据: autodl-workflow详解.md 各工作流「输入」段（zm_u08/zm_u24/image_audio_to_video_v2[_15s] 均列了 ref_audio_0~2）
   */
  private static readonly REF2V_AUDIO_VARIANTS = [
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S,
  ]

  /** 音频参考最多 3 段 (ref_audio_0/1/2)，平台硬上限 */
  private static readonly REF2V_MAX_AUDIO = 3

  /** Ref2V 1-10s 用 v5; 11-15s 自动切到 v5_15s */
  private static readonly REF2V_MAX_SHORT_S = 10

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const { workflowId, body, fallbackReason } = this.buildBodyForRecord(record)
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
      fallbackReason,
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

  private buildBodyForRecord(record: VideoGenerationRecord): { workflowId: string; body: any; fallbackReason?: string } {
    const mode = record.referenceMode || 'none'
    const refCount = this.countRefImages(record.referenceImageUrls)
    const hasFirstLast = !!(record.firstFrameUrl && record.lastFrameUrl)

    let workflowId: string
    let refs: string[] = []
    let firstFrame: string | undefined
    let lastFrame: string | undefined
    /** Sprint 14: 实际 workflow 跟用户所选模型不一致时置位, 透传给调用方落库 */
    let fallbackReason: string | undefined

    // Sprint 14 (PM msg-20261019-074): 配音音频由后端从 storyboards.tts_audio_url 归一化后注入 (前端不传参),
    //   最多 3 段 — 平台 ref_audio_0/1/2 硬上限。
    const audioUrls = (record.audioUrls || [])
      .filter(Boolean)
      .slice(0, AutoDLComfyUIWorkflowAdapter.REF2V_MAX_AUDIO)

    // 用户显式选了具体 workflow (record.model = 前端视频模型弹窗选的) 时优先听用户的,
    // 但只在真的拿得到参考图 (mode=multiple/single 且图非空) 时才直接生效。
    const explicitModel = record.model
    const isExplicitRef2V =
      !!explicitModel && (AutoDLComfyUIWorkflowAdapter.REF2V_VARIANTS as readonly string[]).includes(explicitModel)
    const explicitRefs = isExplicitRef2V && (mode === 'multiple' || mode === 'single')
      ? (mode === 'multiple' ? this.parseRefImages(record.referenceImageUrls) : (record.imageUrl ? [record.imageUrl] : []))
      : []

    if (explicitRefs.length > 0) {
      workflowId = explicitModel!
      refs = explicitRefs
      // D2 (用户 2026-10-19 拍板): 选了音频工作流但本镜没配音 → 自动退回普通 Ref2V (v5 / v5_15s)。
      //   属正常兜底 (没配音就不用做口型同步), 不提示前端, 只 flow-log 记一笔供事后核对。
      if (audioUrls.length === 0 && this.isAudioWorkflow(workflowId)) {
        fallbackReason = 'no_audio_fallback'
        workflowId = this.pickRef2VWorkflowId(record.duration)
      }
    } else if (mode === 'multiple' && refCount >= 1) {
      // 多图参考: 走 Ref2V 工作流 (按 duration 自动选 v5 / v5_15s)
      workflowId = this.pickRef2VWorkflowId(record.duration)
      refs = this.parseRefImages(record.referenceImageUrls)
    } else if (mode === 'single' && record.imageUrl) {
      // 单图参考: 走 Ref2V 工作流, 仅填 ref_image_0
      // 与 minimax-video 行为对齐 (single → reference_image, 不是 first_frame)
      workflowId = this.pickRef2VWorkflowId(record.duration)
      refs = [record.imageUrl]
    } else if (mode === 'first_last' || hasFirstLast || record.firstFrameUrl || record.lastFrameUrl) {
      // 2026-10-12 sprint 43 FIX-8 (QA msg-20261012-043): 用户生成了 first_frame_image 后,
      //   应该自动用首帧图模式 (FL2V), 不该再走 T2V (no_pic)。前端只传 firstFrameUrl
      //   不传 lastFrameUrl 时也走这里, last_frame 字段在下面 if (lastFrame) 防御性跳过
      const frameRefs = [record.firstFrameUrl, record.lastFrameUrl].filter(Boolean) as string[]

      // D1 (用户 2026-10-19 拍板): 选了 Ref2V 变体但 mode 是 first_last → 不再静默退 FL2V,
      //   改拿首/尾帧当 ref_image_N 跑 Ref2V — 否则「要口型同步」的诉求会被 FL2V 整条吃掉。
      //   一张参考图都没有时 (ref_image_0 是平台必填) 只能退 T2V, 记 mode_mismatch_no_images。
      if (isExplicitRef2V && frameRefs.length > 0) {
        workflowId = explicitModel!
        refs = frameRefs
        fallbackReason = 'mode_mismatch_ref2v'
        // 同 D2: 再判一次没配音的情况, 但保留更重要的 mode_mismatch_ref2v 原因码
        if (audioUrls.length === 0 && this.isAudioWorkflow(workflowId)) {
          workflowId = this.pickRef2VWorkflowId(record.duration)
        }
      } else if (isExplicitRef2V) {
        workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_T2V
        fallbackReason = 'mode_mismatch_no_images'
      } else {
        // 首尾帧: 走 FL2V 工作流
        workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_FL2V
        firstFrame = record.firstFrameUrl || undefined
        lastFrame = record.lastFrameUrl || undefined
      }
    } else {
      // 其他: 文生视频
      workflowId = AutoDLComfyUIWorkflowAdapter.WORKFLOW_T2V
      if (isExplicitRef2V) fallbackReason = 'mode_mismatch_no_images'
    }

    if (fallbackReason) {
      // 降级留痕 — flow-log 里能直接 grep 到「为什么选了 zm_u08 却跑了别的」。
      // fallbackReason 同时回填到 video_generations.fallback_reason 供前端提示。
      logTaskWarn('VideoTask', 'model-fallback', {
        videoGenId: record.id,
        requestedModel: explicitModel,
        actualWorkflow: workflowId,
        reason: fallbackReason,
        referenceMode: mode,
        audioCount: audioUrls.length,
        hint: fallbackReason === 'no_audio_fallback'
          ? '音频工作流缺配音, 已自动退普通 Ref2V; 本镜不做口型同步'
          : '模式与所选 Ref2V 变体不匹配, 已自动换 workflow (首/尾帧当 ref_image_N)',
      })
    }

    if (audioUrls.length > 0 && !this.isAudioWorkflow(workflowId)) {
      // 本镜有配音但所选工作流吃不了音频 → 口型同步不会生效。这条最容易踩, 单独记一笔。
      logTaskWarn('VideoTask', 'audio-unsupported-by-workflow', {
        videoGenId: record.id,
        actualWorkflow: workflowId,
        audioCount: audioUrls.length,
        hint: '需改选 zm_u08 / zm_u24 / image_audio_to_video_v2 才能做口型同步',
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
    } else if ((AutoDLComfyUIWorkflowAdapter.REF2V_VARIANTS as readonly string[]).includes(workflowId)) {
      // Sprint 14 修 bug: 改前只给 v5 / v5_15s 填 ref_image_N, 用户显式选 zm_u24 / zm_u08 /
      //   image_audio_to_video_v2 时 refs 算了却没进 body → 平台收到一个没有参考图的 Ref2V 请求。
      //   现在所有 Ref2V 变体统一填 (平台上限 9 张)。
      refs.slice(0, 9).forEach((url, i) => {
        body[`ref_image_${i}`] = url
      })
      // ref_audio_0/1/2 — H3 多图多音频工作流的口型同步入口 (Sprint 14 核心)
      if (this.isAudioWorkflow(workflowId)) {
        audioUrls.slice(0, AutoDLComfyUIWorkflowAdapter.REF2V_MAX_AUDIO).forEach((url, i) => {
          body[`ref_audio_${i}`] = url
        })
      }
    }

    return { workflowId, body, fallbackReason }
  }

  /** 该 workflow 是否接受 ref_audio_0/1/2 (H3 多图多音频工作流) */
  private isAudioWorkflow(workflowId: string): boolean {
    return (AutoDLComfyUIWorkflowAdapter.REF2V_AUDIO_VARIANTS as readonly string[]).includes(workflowId)
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

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
import { logTaskWarn, logTaskProgress } from '../../utils/task-logger.js'
// ★ Sprint 32 (PM msg-20261103-138): 道具图并进参考图的公共逻辑 (与 136 单同一套槽位规则)
import { mergePropRefsIntoSlots, buildPropRefNotes } from './prop-refs.js'

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
  /**
Ref2V 九图三音 15s 画质增强版 (minimax_h3_803)
时长 1-15s，分辨率 480p/768p/1088p/1440p（横竖都支持）
输入：prompt + 最多 9 张参考图 + 多段音频（ref_audio_0~2）
路由：用户显式选择
场景：性价比 + 清晰度兼顾 —— 默认 1088p 档 ¥0.060/秒 (5s 一镜 ¥0.30),
      比 v5 的 1080p (¥0.100/秒 = 5s ¥0.50) 便宜 40% 且更清晰
注意：★ 分辨率字面量【带分辨率数字】('1088p竖(1088*1920)'), 与其它工作流的裸名 ('1080p竖') 不同
      —— 平台枚举逐字要求, 发错就报参数错。详见 RESOLUTION_PROFILES。
*/
  static readonly WORKFLOW_REF2V_803 = 'minimax_h3_803'
  /**
Ref2V 影视画质版（zm_nono）—— ★ Sprint 42 (PM msg-20261114-181)
时长 1-15s，分辨率 480p/768p/960p（横竖都支持，★ 没有 1:1 方图档）
输入：prompt + 最多 9 张参考图 + 最多 3 段参考音频（ref_audio_0~2）
路由：用户在前端 model 弹窗显式选择
场景：主力档 —— 影视画质（AutoDL 近 7 天调用量第二）
注意：★ 参数表里【没有 seed】（同族其它工作流都有）→ 别无条件给这个工作流传 seed
      ★ ref_audio 只接受 audio/mpeg 与 audio/wav（【不接受 flac】）
价格：768p ¥0.050/秒；960p ¥0.100/秒
*/
  static readonly WORKFLOW_REF2V_CINEMA = 'minimax_h3_zm_nono'
  /**
Ref2V 超清画质版（zm_u30）—— ★ Sprint 42 (PM msg-20261114-181)
时长 1-15s，分辨率 480p/768p/960p（横竖都支持，★ 没有 1:1 方图档）
输入：prompt + 最多 9 张参考图 + 最多 3 段参考音频（ref_audio_0~2）
路由：用户在前端 model 弹窗显式选择
场景：主力档 —— 超清画质（AutoDL 近 7 天调用量第一）
注意：★ 有 seed 参数（nono 没有）；ref_audio 接受 audio/flac、audio/mpeg、audio/wav
价格：768p ¥0.050/秒；960p ¥0.090/秒
*/
  static readonly WORKFLOW_REF2V_ULTRA = 'minimax_h3_zm_u30'

  /** 所有 Ref2V 变体 — record.model 显式选择时识别 */
  private static readonly REF2V_VARIANTS = [
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_803,
    // ★ Sprint 42: zm_nono / zm_u30 (AutoDL 调用量最大的两个档位)
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_CINEMA,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_ULTRA,
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
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_803,
    // ★ Sprint 42: zm_nono / zm_u30 也带 ref_audio_0~2 → 必须进音驱动清单,
    //   否则合成阶段会用 TTS 替换源音轨 → 又出现"声音比嘴型早"的音画不同步 (Sprint 38 T3-D 的坑)
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_CINEMA,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_ULTRA,
  ]

  /**
   * ★ Sprint 38 T3-D (PM msg-20261110-165): 【音驱动工作流】清单 (公开) ——
   *   这些工作流会收 ref_audio_0/1/2 (我们配的 TTS) → 平台按【我们的音色】对口型
   *   → 源音轨里就是【我们的人声】, 而且嘴型跟着它走。
   *   合成阶段据此判断能不能保留源音轨 (见 services/ffmpeg-compose.ts)。
   *   非音驱动 (lightx2v 家族: T2V / FL2V / v5 / v5_15s) 的源音轨里没有人声 → 仍要用 TTS 替换。
   */
  static readonly AUDIO_DRIVEN_WORKFLOWS: readonly string[] = AutoDLComfyUIWorkflowAdapter.REF2V_AUDIO_VARIANTS

  /** 音频参考最多 3 段 (ref_audio_0/1/2)，平台硬上限 */
  private static readonly REF2V_MAX_AUDIO = 3

  /**
   * ★ Sprint 35 (PM msg-20261106-149): 【平台规定 ref_audio 必填】的工作流白名单 ——
   *   只有在这里列出的工作流, 『本镜没配音』才允许降级 workflow。
   *
   * ★ 为什么改 (原 D2 是无条件降级):
   *   平台文档 (Obsidian/ComfyUi/autodl-workflow详解.md + autodl-workflows-auto.md) 实测:
   *     minimax_h3_zm_u24                   → ref_audio_0 选填
   *     minimax_h3_zm_u08                   → ref_audio_0 选填
   *     minimax_h3_image_audio_to_video_v2    → ref_audio_0 选填
   *     minimax_h3_image_audio_to_video_v2_15s → ref_audio_0 选填
   *     minimax_h3_803                       → ref_audio_0~2 全选填
   *     (唯一 ref_audio_0 必填的 minimax_h3_image_audio_to_video 我们【不支持】)
   *   → 『没配音』不构成降级理由。而降级的代价很大:
   *     803 的 1088p ¥0.060/秒 被换成 v5 的 1080p ¥0.100/秒 → 【贵 67% 且画质降一档】,
   *     zm_u24 的『升级画质』也一并丢掉。
   *   → 现在没配音时: 照常跑用户选的那个工作流, 只是【不传】ref_audio_0/1/2 (平台侧选填)。
   *   ★ 若将来某个工作流的平台文档写明 ref_audio 必填, 把它加进这个白名单即可恢复降级。
   */
  private static readonly AUDIO_REQUIRED_WORKFLOWS: readonly string[] = []

  /** Ref2V 1-10s 用 v5; 11-15s 自动切到 v5_15s */
  private static readonly REF2V_MAX_SHORT_S = 10
  /** 平台 ref_image_N 槽位上限 (ref_image_0 ~ ref_image_8) */
  private static readonly REF2V_MAX_IMAGES = 9

  /**
   * ★ Sprint 34 (PM msg-20261103-144): 工作流 → 分辨率档位。
   *
   * ★ 字面量必须与平台枚举【逐字一致】—— 写法随工作流变:
   *   · 已支持的 8 个用裸名 ('768p竖' / '1080p横')
   *   · minimax_h3_803 系列用带分辨率数字 ('1088p竖(1088*1920)')
   *   发错格式平台直接报参数错, 不会静默降级。
   *
   * · levels*: 该工作流合法的档位 (高→低), 供以后做分辨率选择 UI 用
   * · default*: 默认档 (竖/横各一)
   * · fallbackVert: 无 aspectRatio / 不支持的纵横比时用 (老工作流 = '768p竖', 与改动前逐字一致)
   */
  private static readonly RESOLUTION_PROFILES: Record<string, {
    levelsVert: string[]
    levelsHor: string[]
    defaultVert: string
    defaultHor: string
    fallbackVert: string
  }> = {
    // T2V (无参考图)
    'minimax_h3_lightx2v_no_pic': { levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    // FL2V (首尾帧)
    'minimax_h3_lightx2v': { levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    // Ref2V v5 / v5_15s → 支持 1080p
    'minimax_h3_lightx2v_v5': { levelsVert: ['1080p竖', '768p竖'], levelsHor: ['1080p横', '768p横'], defaultVert: '1080p竖', defaultHor: '1080p横', fallbackVert: '768p竖' },
    // ★ v5_15s 【不支持 1080p】—— 官方档案的 resolution 枚举只有 480p/768p (+1:1),
    //   价格表也只有这两档 (用户 2026-11-03 double check 确认)。
    //   改前这里默认档是 1080p (老的 supports1080p 开关含它) → 会发平台不认的 '1080p竖' → 参数错。
    'minimax_h3_lightx2v_v5_15s': { levelsVert: ['768p竖', '480p竖'], levelsHor: ['768p横', '480p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    // zm_u24 / zm_u08 → 不支持 1080p
    'minimax_h3_zm_u24': { levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    'minimax_h3_zm_u08': { levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    // image_audio_to_video_v2 → 支持 1080p; _15s 版 → 不支持
    'minimax_h3_image_audio_to_video_v2': { levelsVert: ['1080p竖', '768p竖'], levelsHor: ['1080p横', '768p横'], defaultVert: '1080p竖', defaultHor: '1080p横', fallbackVert: '768p竖' },
    'minimax_h3_image_audio_to_video_v2_15s': { levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖' },
    // ★ Sprint 34: 九图三音 15s 画质增强版 —— 分辨率字面量【带分辨率数字】
    //   默认 1088p (¥0.060/秒, 比 v5 的 1080p 便宜 40% 且更清晰)
    // ★ Sprint 42 (PM msg-20261114-181): zm_nono / zm_u30 —— 多了 960p 档, 但【没有 1:1 方图】
    //   (平台枚举只有 480p横/480p竖/768p横/768p竖/960p横/960p竖 六个; 同族 u24/u08 有 480p(1:1)/768p(1:1))
    //   → 1:1 的 storyboard 落到 fallbackVert ('768p竖', 合法字面量) → 不会把 1:1 字面量发过去
    //   ★ 默认档 = 768p (nono ¥0.050/秒, u30 ¥0.050/秒, 与现有 u24/u08 同价 → 不涨价);
    //     960p 是可选档位 (nono ¥0.100/秒, u30 ¥0.090/秒 → 贵 80~100%, 让用户自己决定要不要为清晰度付钱)
    'minimax_h3_zm_nono': {
      levelsVert: ['960p竖', '768p竖', '480p竖'],
      levelsHor: ['960p横', '768p横', '480p横'],
      defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖',
    },
    'minimax_h3_zm_u30': {
      levelsVert: ['960p竖', '768p竖', '480p竖'],
      levelsHor: ['960p横', '768p横', '480p横'],
      defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖',
    },
    'minimax_h3_803': {
      levelsVert: ['1088p竖(1088*1920)', '768p竖(768*1376)', '1440p竖(1440*2560)'],
      levelsHor: ['1088p横(1920*1088)', '1440p横(2560*1440)'],
      defaultVert: '1088p竖(1088*1920)',
      defaultHor: '1088p横(1920*1088)',
      fallbackVert: '768p竖(768*1376)',
    },
  }

  /**
   * ★ Sprint 43 (PM msg-20261115-183): 各工作流支持的【分辨率档位】(tier) 列表 + 默认档。
   *   给前端的「分辨率」下拉用 —— 档位是"档"不是"字面量" ('960p' 而不是 '960p竖'):
   *   竖/横由每个分镜的 aspectRatio 决定 → 用户选 960p, 竖屏镜发 '960p竖'、横屏镜发 '960p横'。
   *   ★ 事实来源就是 RESOLUTION_PROFILES → 前端不会跟后端漂移。
   */
  static listResolutionTiers(): Record<string, { tiers: string[]; defaultTier: string }> {
    const out: Record<string, { tiers: string[]; defaultTier: string }> = {}
    for (const [wf, p] of Object.entries(AutoDLComfyUIWorkflowAdapter.RESOLUTION_PROFILES)) {
      const tiers: string[] = []
      for (const literal of [...p.levelsVert, ...p.levelsHor]) {
        const t = AutoDLComfyUIWorkflowAdapter.tierOfLiteral(literal)
        if (!tiers.includes(t)) tiers.push(t)
      }
      out[wf] = { tiers, defaultTier: AutoDLComfyUIWorkflowAdapter.tierOfLiteral(p.defaultVert) }
    }
    return out
  }

  /** 字面量 → 档位: '960p竖' → '960p'; '1088p竖(1088*1920)' → '1088p' */
  private static tierOfLiteral(literal: string): string {
    const m = /^(\d+p)/.exec(String(literal || ''))
    return m ? m[1] : String(literal || '')
  }

  /** 未知工作流时的兜底档位 (与改动前的 '768p竖' 逐字一致) */
  private static readonly DEFAULT_RESOLUTION_PROFILE = {
    levelsVert: ['768p竖'], levelsHor: ['768p横'], defaultVert: '768p竖', defaultHor: '768p横', fallbackVert: '768p竖',
  }

  /**
   * ★ Sprint 34: 已知工作流全集 (8 个老的 + 803) ——
   *   用来识别【用户在前端选了一个我们没接入的模型 id】。
   *   之前这种情况 fallbackReason=undefined → 一条告警都不留 → 完全无法排查。
   */
  private static readonly KNOWN_WORKFLOW_IDS = [
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_T2V,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_FL2V,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_803,
    // ★ Sprint 42: 接入后不再走"未知工作流"兜底告警
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_CINEMA,
    AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_ULTRA,
  ]

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
    /** ★ Sprint 36 (PM msg-20261106-156): D1 (选了 Ref2V 变体 + mode=first_last) —— 工作流【没换】,
     *  只是首/尾帧改以 ref_image_N 形式传给同一个工作流 → 不落 fallback_reason (前端不弹 tag),
     *  只在 flow-log 留一条 'model-mode-adapt' 痕迹。 */
    let modeAdapted = false
    /** ★ Sprint 36 追加 (T2, PM msg-20261107-159): D1 路线里 首/尾帧 是以 ref_image_N 传的
     *  → 模型不知道图1是起点图2是终点 → 会自由发挥 (『镜与镜衔接生硬』的根因之一)。
     *  这里记下两张帧在参考图里的序号 (1-based, 对齐 prompt 里的 Image N), 稍后写进视频 prompt。 */
    let d1FrameSlots: { start: number; end: number } | null = null

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
    // ★ Sprint 34 (PM msg-20261103-144): 用户选了一个【我们没接入】的模型 id →
    //   之前这种不设任何 fallbackReason → flow-log 里一条告警都不留 → 完全无法排查。
    //   这里先识别出来, 最后统一兜底告警 (mode 不匹配的原因码优先, 见下)。
    //   ⚠️ 命名容易绕进去 (QA 2026-11-06 提过): 实际语义是
    //     『显式给了 model, 且这个 id 不在已知工作流全集里』;
    //     『没给 model』→ false → 走自动路由, 不算未接入。
    //     ★ 它与 D1/D2 的 isExplicitRef2V 互斥 (能设上那两者的前提都是 isExplicitRef2V=true),
    //       所以 144 单那个 model_not_supported 兜底不会被 D1/D2 的 reason 抢走。
    const isUnrecognizedModel = !!explicitModel
      && !(AutoDLComfyUIWorkflowAdapter.KNOWN_WORKFLOW_IDS as readonly string[]).includes(explicitModel)
    const explicitRefs = isExplicitRef2V && (mode === 'multiple' || mode === 'single')
      ? (mode === 'multiple' ? this.parseRefImages(record.referenceImageUrls) : (record.imageUrl ? [record.imageUrl] : []))
      : []

    if (explicitRefs.length > 0) {
      workflowId = explicitModel!
      refs = explicitRefs
      // D2 (2026-10-19 拍板 → ★ Sprint 35 修正): 选了音频工作流但本镜没配音时,
      //   以前无条件退普通 Ref2V (v5 / v5_15s)。但平台规格里这些工作流的 ref_audio 是【选填】,
      //   → 『没配音』不构成降级理由, 而且代价很大 (803: 1088p ¥0.060/秒 → 1080p ¥0.100/秒, 贵 67% 且降一档)。
      //   现在: 照常跑用户选的工作流, 只是不传 ref_audio_0/1/2 (平台侧选填)。
      //   ★ 只有【平台规定 ref_audio 必填】的工作流才降级 (见 AUDIO_REQUIRED_WORKFLOWS, 当前为空)。
      if (audioUrls.length === 0 && this.isAudioWorkflow(workflowId)
        && (AutoDLComfyUIWorkflowAdapter.AUDIO_REQUIRED_WORKFLOWS as readonly string[]).includes(workflowId)) {
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
        // ★ Sprint 36 (PM msg-20261106-156): 【这里没有换工作流】—— workflowId 仍然是用户选的那个。
        //   以前这里置 fallbackReason='mode_mismatch_ref2v' → 前端给用户弹橙色 tag
        //   『模式不匹配·已转多图参考』→ 用户以为自己选的模型被系统换掉了 (149 单的起因就是用户困惑过一次)。
        //   实测 flow-log: requestedModel == actualWorkflow, 工作流一个都没换, 实际只是把首/尾帧
        //   以 ref_image_0/1 的形式传给了【同一个】工作流 → 文案与事实不符。
        //   现在: 工作流没换 → 不落 fallback_reason (前端不弹 tag); 只留 flow-log 痕迹。
        //   ★ 剩下会落 fallback_reason 的原因码, 每个都意味着【工作流真的被换了】(见下面 model-fallback 块)。
        // ★ Sprint 35: D2 不再无条件降级 → 这里【只有平台规定 ref_audio 必填】的工作流才换 workflow。
        //   (之前这里会把用户选的 zm_u24/803 换成普通 v5, reason 却记着 mode_mismatch_ref2v
        //    → flow-log 记的码与真正换 workflow 的原因对不上。Sprint 35 已把那层替换去掉。)
        modeAdapted = true
        // ★ Sprint 36 追加 (T2): 记下首/尾帧在参考图里的序号 (1-based) → prompt 里点明语义
        d1FrameSlots = {
          start: refs.indexOf(record.firstFrameUrl!) + 1,
          end: record.lastFrameUrl ? refs.indexOf(record.lastFrameUrl) + 1 : 0,
        }
        if (audioUrls.length === 0 && this.isAudioWorkflow(workflowId)
          && (AutoDLComfyUIWorkflowAdapter.AUDIO_REQUIRED_WORKFLOWS as readonly string[]).includes(workflowId)) {
          workflowId = this.pickRef2VWorkflowId(record.duration)
          fallbackReason = 'no_audio_fallback'   // ★ 这里是真的换了工作流 → 原因码如实记录
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

    // ★ Sprint 36 (PM msg-20261106-156): D1 的痕迹 (工作流没换, 所以没有 fallback_reason 可落库)。
    //   flow-log 里照样能查到「这镜是把首/尾帧当 ref_image_N 跑的」—— 排查用。
    if (modeAdapted && !fallbackReason) {
      logTaskWarn('VideoTask', 'model-mode-adapt', {
        videoGenId: record.id,
        requestedModel: explicitModel,
        actualWorkflow: workflowId,
        reason: 'mode_mismatch_ref2v',
        referenceMode: mode,
        audioCount: audioUrls.length,
        hint: '模式与所选 Ref2V 变体不匹配: 首/尾帧改以 ref_image_N 形式传给【同一个】workflow (工作流未换) → 不提示用户',
      })
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
    } else if (isUnrecognizedModel) {
      // ★ Sprint 34: 模型 id 【不在已知工作流全集】→ 已按 referenceMode 自动路由, 但必须留痕。
      //   ★ 与 'mode 不匹配' 分开: 两种问题的排查方向完全不同 (一个是 id 写错了/没接入, 一个是模式选错了)。
      fallbackReason = 'model_not_supported'
      logTaskWarn('VideoTask', 'model-not-supported', {
        videoGenId: record.id,
        requestedModel: explicitModel,
        actualWorkflow: workflowId,
        reason: fallbackReason,
        referenceMode: mode,
        hint: '该模型 id 未接入 (不在已知工作流全集里) → 已按 referenceMode 自动路由到上面的 workflow; 请检查设置里的模型 id 是否写对',
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

    const body: any = {
      prompt: record.prompt || '',
    }

    // ★ Sprint 36 追加 (T2, PM msg-20261107-159): D1 路线 (用户显式选了 Ref2V 变体 + mode=first_last)
    //   → 首/尾帧是以 ref_image_0/1 的形式传下去的, 平台【不知道】它们是这一镜的起止帧
    //   → 模型把三张图当平级素材自由发挥 (这就是『镜与镜衔接生硬』的技术根因之一)。
    //   这里在 prompt 里点明: 图1=起始帧, 图2=终止帧, 中间必须是这一镜内的连续运动, 且不得引入画面里没有的物体。
    //   ★ 只在 D1 分支加 —— 真正的 FL2V 工作流走 first_frame/last_frame 专用字段, 平台自己知道, 加了反而多余。
    if (d1FrameSlots) {
      const parts = [`Image ${d1FrameSlots.start} is the START frame of this shot`]
      if (d1FrameSlots.end > 0) parts.push(`Image ${d1FrameSlots.end} is the END frame of this shot`)
      parts.push('the motion between them must be one continuous take inside this shot')
      parts.push('do not introduce any object that is not already visible in these frames')
      const sentence = `${parts.join('; ')}.`
      // ★ Sprint 38 T4-G (PM msg-20261110-165): 这段要放在【官方限制项之前】——
      //   H3 官方规范: 限制项必须是整份 prompt 的【最后一段】(结尾用整句限制项)。
      //   Sprint 38 T2 把这段追加在末尾 → 限制项被挤到倒数第二段, 权重下降。
      //   ★ 只在末段确实是官方限制项 (以 "No text" 开头) 时才往前挪;
      //     其它模板 (general) 的 prompt 结构不同 → 维持【追加在末尾】(逐字不变)。
      const paras = String(body.prompt).split('\n\n')
      const lastPara = (paras[paras.length - 1] || '').trim()
      if (paras.length > 1 && /^No text\b/i.test(lastPara)) {
        body.prompt = [...paras.slice(0, -1), sentence, lastPara].join('\n\n')
      } else {
        body.prompt = `${body.prompt}\n${sentence}`
      }
    }

    // duration 上限看具体路由:
    //   T2V/FL2V/Ref2V(v5)/image_audio_to_video_v2 = 1-10
    //   Ref2V(v5_15s)/zm_u24/zm_u08/image_audio_to_video_v2_15s = 1-15
    const is15s = (
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_15S ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_QUALITY ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_SPEED ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_AUDIO_15S ||
      // ★ Sprint 34: 九图三音 15s 画质增强版 (duration 枚举 min=1 max=15)
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_803 ||
      // ★ Sprint 42: zm_nono / zm_u30 的 duration 枚举同样是 min=1 max=15 (与同族 u24/u08 一致)
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_CINEMA ||
      workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_ULTRA
    )
    const durationCap = is15s ? 15 : 10
    if (record.duration) {
      body.duration = Math.max(1, Math.min(durationCap, Math.floor(record.duration)))
    }

    // resolution: 纵横比 + 工作流 → autodl 命名 (★ 字面量按工作流派, 见 RESOLUTION_PROFILES)
    body.resolution = this.mapResolution(workflowId, record.aspectRatio, record.resolution, {
      videoGenId: record.id,
      storyboardId: record.storyboardId,
    })

    // ★ Sprint 42 (PM msg-20261114-181): 【seed 按工作流判定】——
    //   zm_nono 的参数表里【没有 seed】这一项, 传了平台会报参数错 (同族其它工作流都有 seed)。
    //   本项目【一律不传 seed】(平台侧自带默认 seed) → nono 天然安全, 且现有工作流的请求体逐字不变。
    //   ★ 若将来要加 seed (比如做『同 seed 可复现』), 必须【按工作流判定】, 不能无条件给全部工作流传。
    //   参考: u30 有 seed (默认 548628410878779), u24/u08/803 有, nono 没有。

    if (workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_FL2V) {
      if (firstFrame) body.first_frame = firstFrame
      if (lastFrame) body.last_frame = lastFrame
      if ((record.propReferenceImages || []).length) {
        logTaskWarn('VideoTask', 'prop-refs-not-applicable', {
          videoGenId: record.id,
          storyboardId: record.storyboardId,
          workflowId,
          propCount: (record.propReferenceImages || []).length,
          hint: '当前 workflow 是 FL2V (first_frame/last_frame 字段), 没有 ref_image_N 槽位 → 道具图未进参考图',
        })
      }
    } else if ((AutoDLComfyUIWorkflowAdapter.REF2V_VARIANTS as readonly string[]).includes(workflowId)) {
      // Sprint 14 修 bug: 改前只给 v5 / v5_15s 填 ref_image_N, 用户显式选 zm_u24 / zm_u08 /
      //   image_audio_to_video_v2 时 refs 算了却没进 body → 平台收到一个没有参考图的 Ref2V 请求。
      //   现在所有 Ref2V 变体统一填 (平台上限 9 张)。
      //
      // ★ Sprint 31 (PM msg-20261102-136): 本镜【显式关联的道具图】并进 ref_image_N。
      //   槽位规则 (PM 拍板):
      //     · 【首帧必须占 ref_image_0】 → 道具图一律【追加在末尾】, 不插到前面
      //       (插前面会把已有参考图整体后移 → prompt 里 <Picture N> 的编号全错位,
      //        而 H3 的 subject_definitions 段里就有 <Picture N> 引用 → 人物身份漂移)
      //     · 已经在 refs 里的道具图【不重复追加】, 直接用它的现有槽位 (避免同一张图发两遍)
      //     · 9 张上限满了 → 优先丢【普通参考图】给道具图腾位 (道具图是用户显式关联的语义信息)
      //   ★ single (单图参考) 模式【不加道具图】—— 它的语义是『只填 ref_image_0』,
      //     工单也说了本单只针对多图参考 (Ref2V 多图) 路径。
      const propRefs = (mode === 'single')
        ? []
        : (record.propReferenceImages || []).filter(p => p && p.url && p.name)
      let propSlots: { name: string; slot: number }[] = []
      let droppedRefs: string[] = []
      if (propRefs.length) {
        const merged = this.mergePropRefsIntoSlots(refs, propRefs, record)
        refs = merged.refs
        propSlots = merged.propSlots
        droppedRefs = merged.dropped
      }
      refs.slice(0, 9).forEach((url, i) => {
        body[`ref_image_${i}`] = url
      })
      // ★ prompt 里说明每张道具图是干嘛的 —— 跟生图侧同语义 ('Image N is the xxx prop reference ...'),
      //   不说明的话模型不知道这张图是道具参考, 会当成又一个人物/场景。
      //   ★ 编号 = 槽位 + 1 (H3 约定: <Picture N> = ref_image_{N-1}) → 这里跟实际发出的槽位自洽。
      if (propSlots.length) {
        body.prompt = `${body.prompt}\n${buildPropRefNotes(propSlots)}`
      }
      // 参考图清单进 flow-log —— 事后能核对"这次到底发了哪几张、分别是什么、道具图排第几"
      logTaskProgress('VideoTask', 'video-ref-slots', {
        videoGenId: record.id,
        storyboardId: record.storyboardId,
        workflowId,
        total: Math.min(refs.length, 9),
        propCount: propSlots.length,
        slots: refs.slice(0, 9).map((url, i) => ({
          slot: i,
          isProp: propSlots.some(sl => sl.slot === i),
          name: propSlots.find(sl => sl.slot === i)?.name || null,
        })),
        droppedRefs,
        hint: '槽位清单: slot = ref_image_N; 道具图排在末尾, 首帧仍是 ref_image_0',
      })
      // ref_audio_0/1/2 — H3 多图多音频工作流的口型同步入口 (Sprint 14 核心)
      if (this.isAudioWorkflow(workflowId)) {
        let picked = audioUrls.slice(0, AutoDLComfyUIWorkflowAdapter.REF2V_MAX_AUDIO)
        // ★ Sprint 42 (PM msg-20261114-181): zm_nono 的 ref_audio 【只接受 audio/mpeg 与 audio/wav】
        //   (【不接受 flac】) → 送 nono 前先把 flac 过滤掉 (本项目的配音都是 .mp3, 正常不会命中;
        //   万一命中就丢这一段音频而不是让平台报参数错 → 整次生成失败)
        if (workflowId === AutoDLComfyUIWorkflowAdapter.WORKFLOW_REF2V_CINEMA) {
          const kept = picked.filter(u => !/\.flac(\?|#|$)/i.test(String(u)))
          if (kept.length !== picked.length) {
            logTaskWarn('VideoTask', 'audio-format-unsupported-filtered', {
              videoGenId: record.id,
              storyboardId: record.storyboardId,
              workflowId,
              droppedCount: picked.length - kept.length,
              hint: 'zm_nono 的 ref_audio 只接受 audio/mpeg 与 audio/wav (不接受 flac) → 已过滤掉 flac',
            })
          }
          picked = kept
        }
        picked.forEach((url, i) => {
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

  /**
   * ★ Sprint 31 (PM msg-20261102-136): 把本镜【显式关联的道具图】并进参考图槽位。
   *
   * 规则 (PM 拍板 + 平台语义):
   *   · 【首帧必须占 ref_image_0】→ 道具图一律【追加在末尾】, 不插到前面
   *     (插前面会把已有参考图整体后移 → prompt 里 <Picture N> 编号全错位,
   *      而 H3 的 subject_definitions 段里就有 <Picture N> 引用 → 人物身份漂移)
   *   · 已经在 refs 里的道具图【不重复追加】→ 用它现有的槽位 (同一张图不能发两遍)
   *   · 9 张上限满了 → 优先丢【普通参考图】给道具图腾位
   *     (道具图是用户显式关联的语义信息, 比历史参考图值钱)
   */
  /**
   * ★ Sprint 32 (PM msg-20261103-138): 实现搬到公共模块 services/adapters/prop-refs.ts,
   *   让 5 个 provider 共用【同一套】槽位规则 (不各写一份 → 以后不会分叉)。
   *   ★ 算法逐字未变 (末尾追加 / 不重复追加 / index 0 (首帧) 保护 / 超上限优先丢普通参考图),
   *     136 单的 10 组离线用例用这版重跑全过。
   */
  private mergePropRefsIntoSlots(
    refs: string[],
    propRefs: { url: string; name: string }[],
    record?: any,
  ): { refs: string[]; propSlots: { name: string; slot: number }[]; dropped: string[] } {
    // ★ Sprint 36 追加 (PM msg-20261107-159): 传 record → 共享层按【有没有首尾帧】决定带不带道具图
    //   (mode=first_last → 道具在帧里已定型, 再喂独立道具图 = 多画一个实物/穿模)
    return mergePropRefsIntoSlots(refs, propRefs, AutoDLComfyUIWorkflowAdapter.REF2V_MAX_IMAGES, record)
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
  /**
   * ★ Sprint 34 (PM msg-20261103-144): 分辨率按【工作流】取, 不再是全局 4 个值。
   *   ★ 字面量必须与平台枚举逐字一致 —— 803 系列带分辨率数字, 其它工作流是裸名 (见 RESOLUTION_PROFILES)。
   *   ★ 零回归: 老工作流的取值与改动前【逐字一致】
   *     (v5 / v5_15s / image_audio_to_video_v2 = 1080p; zm_u24 / zm_u08 / _15s / no_pic / lightx2v = 768p;
   *      无 aspectRatio 或 1:1 等不支持的纵横比 → 落到 fallbackVert = '768p竖')
   */
  private mapResolution(
    workflowId: string,
    aspectRatio?: string | null,
    /** ★ 用户指定的【档位】(前端分辨率下拉; 空 = 用该工作流的默认档) */
    tier?: string | null,
    ctx?: { videoGenId?: number; storyboardId?: number | null },
  ): string {
    const profile = AutoDLComfyUIWorkflowAdapter.RESOLUTION_PROFILES[workflowId]
      || AutoDLComfyUIWorkflowAdapter.DEFAULT_RESOLUTION_PROFILE
    if (!aspectRatio) return profile.fallbackVert
    const isVert = aspectRatio === '9:16' || aspectRatio === '3:4' || aspectRatio === '2:3' || aspectRatio === '4:5'
    const isHor = aspectRatio === '16:9' || aspectRatio === '4:3' || aspectRatio === '21:9' || aspectRatio === '3:2'
    // ★ 用户指定的档位 → 取该档位在当前纵横比下的字面量 (1:1 按竖屏取)
    if (tier) {
      const pool = isHor ? profile.levelsHor : profile.levelsVert
      const hit = pool.find(l => AutoDLComfyUIWorkflowAdapter.tierOfLiteral(l) === tier)
      if (hit) return hit
      logTaskWarn('VideoTask', 'resolution-tier-invalid', {
        videoGenId: ctx?.videoGenId,
        storyboardId: ctx?.storyboardId,
        workflowId,
        tier,
        aspectRatio,
        allowed: pool.map(l => AutoDLComfyUIWorkflowAdapter.tierOfLiteral(l)),
        hint: '该工作流不支持这个分辨率档位 → 落到默认档 (不报错, 别整次生成失败)',
      })
    }
    if (isVert) return profile.defaultVert
    if (isHor) return profile.defaultHor
    // 1:1 等不支持的纵横比 → fallback (竖屏最低档)
    return profile.fallbackVert
  }
}

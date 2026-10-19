/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, videoId: string, taskId?: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, videoId: string, taskId?: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse | Promise<VideoPollResponse>

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: any
  /**
   * Sprint 14 (PM msg-20261019-074): adapter 把用户选的模型换成别的 workflow 时回填的原因码。
   * undefined = 没换。调用方 (video-generation.ts) 据此落库 video_generations.fallback_reason。
   * 已知值: 'no_audio_fallback' (音频工作流缺音频 → 退普通 Ref2V, 属正常兜底, 前端不提示)
   *        | 'mode_mismatch_ref2v' (模式不匹配 → 改跑 Ref2V, 值得一提)
   *        | 'mode_mismatch_no_images' (模式不匹配且无图可参考 → 只能 T2V)
   */
  fallbackReason?: string
}

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  negativePrompt?: string | null
  seed?: number | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  /**
   * Sprint 14 (PM msg-20261019-074): 配音音频 URL (已归一化成公网 URL 或 data: base64)。
   * 由 video-generation.ts 从 storyboards.tts_audio_url 取, 不接受前端传参 (后端是唯一真源)。
   * H3 多图多音频工作流 (zm_u08 / zm_u24 / image_audio_to_video_v2[_15s]) 用它填 ref_audio_0/1/2 做口型同步。
   */
  audioUrls?: string[] | null
  duration?: number | null
  aspectRatio?: string | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoId?: string   // agnes 推荐用 video_id 查任务状态(/agnesapi?video_id=...)
  videoUrl?: string
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  videoUrl?: string
  error?: string
}

/**
 * TTS 语音合成 Provider Adapter
 */
export interface TTSProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, params: any): ProviderRequest

  parseResponse(result: any): {
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  }
}

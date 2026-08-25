/**
 * AutoDL 平台 ComfyUI Workflow 异步语音合成 Adapter
 * 工作流: indextts2-v1
 *
 * 与 minimax-tts-async 的关键差异:
 * - 鉴权头不带 Bearer (裸 token), 与 autodl video adapter 一致
 * - 创建任务: POST /comfyui/comfyui_workflow/{workflow_id}
 * - 轮询:      GET  /comfyui/comfyui_workflow/result/{task_id}
 * - 完成响应 results[] 元素为 { url, type:'audio', file_type:'wav' },音频是远程 URL
 * - 多了 emo_* 字段 + 参考音频 (prompt_simple = 音色参考, emo_ref_audio = 情感参考)
 *
 * 用法: 与 minimax-tts-async 一致 — buildCreateRequest / parseCreateResponse /
 *       buildQueryRequest / parseQueryResponse
 *       完成后从 results[0].url 直接拿音频 URL,不需要 buildDownloadRequest
 */
import { joinProviderUrl } from './url'

/** indextts2-v1 支持的情感档位 (8 个, 0-1 数值权重) */
export type Emotion =
  | 'happy'
  | 'angry'
  | 'sad'
  | 'afraid'
  | 'surprised'
  | 'calm'
  | 'melancholic'
  | 'disgusted'

export interface AutoDLTTSParams {
  /** 必填: 要合成的文本 */
  promptText: string
  /** 选填: 音色参考音频 URL (必传, 否则声音随机) */
  promptSimple?: string
  /** 情感档位开关 */
  emotion?: Partial<Record<Emotion, number>> & { random?: boolean }
  /** 情感参考音频 URL (与 emotion 同时使用, 启用"使用情感参考音频"模式) */
  emoRefAudio?: string
  /** 情感控制方式: '使用情感参考音频' | '使用情感向量控制' | '不使用情感' */
  emoControlMethod?: '使用情感参考音频' | '使用情感向量控制' | '不使用情感'
}

export interface AutoDLTTSTaskHandle {
  taskId: string
}

export interface AutoDLTTSQueryResult {
  status: 'processing' | 'success' | 'failed'
  /** 完成时返回音频 URL (wav) */
  audioUrl?: string
  error?: string
  raw?: any
}

export class AutoDLComfyUITTSAsyncAdapter {
  readonly provider = 'autodl-comfyui'

  static readonly WORKFLOW = 'indextts2-v1'

  /** 1. 创建任务: POST /comfyui/comfyui_workflow/{WORKFLOW} */
  buildCreateRequest(config: { baseUrl: string; apiKey: string }, params: AutoDLTTSParams) {
    if (!params.promptText) {
      throw new Error('AutoDLComfyUITTS: promptText is required')
    }

    const body: any = {
      prompt_text: params.promptText,
      // 默认情感向量全为 0
      emo_happy: 0,
      emo_angry: 0,
      emo_sad: 0,
      emo_afraid: 0,
      emo_surprised: 0,
      emo_calm: 0,
      emo_melancholic: 0,
      emo_disgusted: 0,
      emo_random: false,
    }

    // 音色参考: 不传则可能随机, 但 minimax 默认都必填, 这里也建议必填
    if (params.promptSimple) {
      body.prompt_simple = params.promptSimple
    }

    // 情感档位
    if (params.emotion) {
      if (typeof params.emotion.happy === 'number') body.emo_happy = params.emotion.happy
      if (typeof params.emotion.angry === 'number') body.emo_angry = params.emotion.angry
      if (typeof params.emotion.sad === 'number') body.emo_sad = params.emotion.sad
      if (typeof params.emotion.afraid === 'number') body.emo_afraid = params.emotion.afraid
      if (typeof params.emotion.surprised === 'number') body.emo_surprised = params.emotion.surprised
      if (typeof params.emotion.calm === 'number') body.emo_calm = params.emotion.calm
      if (typeof params.emotion.melancholic === 'number') body.emo_melancholic = params.emotion.melancholic
      if (typeof params.emotion.disgusted === 'number') body.emo_disgusted = params.emotion.disgusted
      if (typeof params.emotion.random === 'boolean') body.emo_random = params.emotion.random
    }

    // 情感控制方式: 默认"使用情感向量控制"(本地 emotion 字段生效)
    const control = params.emoControlMethod
      || (params.emoRefAudio ? '使用情感参考音频' : '使用情感向量控制')
    body.emo_control_method = control

    if (params.emoRefAudio) {
      body.emo_ref_audio = params.emoRefAudio
    }

    const url = joinProviderUrl(
      config.baseUrl || 'https://autodl.art/api/v1',
      '',
      `/comfyui/comfyui_workflow/${AutoDLComfyUITTSAsyncAdapter.WORKFLOW}`
    )

    return {
      url,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        // 裸 token, 与 autodl video adapter 一致
        'Authorization': config.apiKey,
      },
      body,
    }
  }

  parseCreateResponse(result: any): AutoDLTTSTaskHandle {
    if (result?.code && result.code !== 'Success') {
      throw new Error(
        `AutoDLComfyUITTS: create task failed: ${result?.msg || JSON.stringify(result).slice(0, 300)}`
      )
    }
    const taskId = result?.task_id || result?.data?.task_id
    if (!taskId) {
      throw new Error(
        'AutoDLComfyUITTS: no task_id in response: ' + JSON.stringify(result).slice(0, 300)
      )
    }
    return { taskId }
  }

  /** 2. 轮询: GET /comfyui/comfyui_workflow/result/{task_id} */
  buildQueryRequest(config: { baseUrl: string; apiKey: string }, taskId: string) {
    const url = joinProviderUrl(
      config.baseUrl || 'https://autodl.art/api/v1',
      '',
      `/comfyui/comfyui_workflow/result/${taskId}`
    )
    return {
      url,
      method: 'GET' as const,
      headers: {
        'Authorization': config.apiKey,
      },
    }
  }

  parseQueryResponse(result: any): AutoDLTTSQueryResult {
    // 与 autodl video 共享响应形态: { code: "Success", data: { status, results: [...] } }
    if (result?.code && result.code !== 'Success') {
      return {
        status: 'failed',
        error: result?.msg || `AutoDLComfyUITTS query failed (code=${result?.code})`,
        raw: result,
      }
    }
    const data = result?.data || result || {}
    const rawStatus = String(data?.status || '').toLowerCase()
    const results = Array.isArray(data?.results) ? data.results : []

    if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'succeeded') {
      // 优先 type='audio', 其次取第一个
      const audio = results.find((r: any) => r?.type === 'audio') || results[0]
      return {
        status: 'success',
        audioUrl: audio?.url,
        raw: result,
      }
    }

    if (rawStatus === 'failed' || rawStatus === 'error') {
      return {
        status: 'failed',
        error: data?.error || data?.message || `AutoDLComfyUITTS generation failed (code=${result?.code})`,
        raw: result,
      }
    }

    // pending / running / queued / processing
    return { status: 'processing', raw: result }
  }
}

export const autodlTtsAsync = new AutoDLComfyUITTSAsyncAdapter()

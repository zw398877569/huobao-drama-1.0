/**
 * MiniMax 语音合成（TTS）Adapter
 * API: POST /v1/t2a_v2
 * 响应: { data: { audio: "<hex>", status: 2 }, ... }
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export interface TTSResult {
  audioHex: string
  audioLength: number
  sampleRate: number
  bitrate: number
  format: string
  channel: number
}

export class MiniMaxTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'minimax'

  buildGenerateRequest(config: any, params: TTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/t2a_v2')

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    }

    const body: any = {
      model: params.model || 'speech-2.8-hd',
      text: params.text,
      stream: false,
      voice_setting: {
        voice_id: params.voice,
        speed: params.speed ?? 1,
        vol: 1,
        pitch: 0,
        emotion: params.emotion || 'neutral',
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
      subtitle_enable: false,
    }

    return { url, method: 'POST', headers, body }
  }

  parseResponse(result: any): TTSResult {
    if (result.base_resp?.status_code !== 0) {
      throw new Error(result.base_resp?.status_msg || 'TTS generation failed')
    }

    const data = result.data
    if (!data?.audio) {
      throw new Error('No audio data in response')
    }

    return {
      audioHex: data.audio,
      // 2026-10-13 sprint 43 FIX-6 (QA msg-20261013-050 P0): extra_info 在 result 顶层, 不在 data 下面
      // dev minimax-tts.ts L77 写错 data.extra_info → result.extra_info. 实际路径 result.extra_info.audio_length
      // (bfd9715 临时 log 跑出真实值 3240 验证)
      audioLength: result.extra_info?.audio_length || 0,
      sampleRate: result.extra_info?.audio_sample_rate || 32000,
      bitrate: result.extra_info?.bitrate || 128000,
      format: result.extra_info?.audio_format || 'mp3',
      channel: result.extra_info?.audio_channel || 1,
    }
  }
}

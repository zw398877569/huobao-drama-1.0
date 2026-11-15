/**
 * MiniMax 语音合成（TTS）Adapter
 * API: POST /v1/t2a_v2
 * 响应: { data: { audio: "<hex>", status: 2 }, ... }
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'
// ★ Sprint 47 T3 (PM msg-20261115-188): 平台不认的情绪在请求前挡住 (whisper 对 2.8 不支持 → 会报 2013)
import { isSupportedEmotion } from '../character-voice-params.js'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
  // ★ Sprint 47 T1 (PM msg-20261115-188): 角色级音量/音高 + 声音修饰
  //   vol: (0,10] 默认 1 / pitch: 整数 [-12,12] 默认 0
  //   voiceModify: 顶层 voice_modify {pitch, intensity, timbre, sound_effects} (刻度 [-100,100], 与上面 pitch 不同刻度!)
  vol?: number
  pitch?: number
  voiceModify?: { pitch?: number; intensity?: number; timbre?: number; sound_effects?: string } | null
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
        // ★ Sprint 47 T1: 角色级音量/音高 (不配置时 = 1 / 0 → 与改动前逐字一致)
        vol: params.vol ?? 1,
        pitch: params.pitch ?? 0,
        // ★ Sprint 47 T3: 平台不认的取值降级 neutral (别发出去让平台报 2013)
        emotion: isSupportedEmotion(params.emotion) ? (params.emotion || 'neutral') : 'neutral',
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
      subtitle_enable: false,
    }

    // ★ Sprint 47 T1: 声音修饰 (顶层 voice_modify) —— 同步接口也支持 (官方 speech-t2a-http 顶层字段)
    //   不配置时【不出现】这个 key → 请求体与改动前逐字一致
    if (params.voiceModify && Object.keys(params.voiceModify).length > 0) {
      body.voice_modify = params.voiceModify
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

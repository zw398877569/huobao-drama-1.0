/**
 * ★ 单 msg-20261128-001: 阿里云百炼 Token Plan TTS Adapter (与 minimax 并存)
 *
 * 端点: POST https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 * ★ 注意是 token-plan 专属域名 (不是 dashscope.aliyuncs.com, 用错会 401 或不计套餐额度)
 * 认证: Authorization: Bearer <Token Plan 专用 Key> (普通 sk- 不行; 真实 Key 只从配置/文件读取, 不进代码)
 * 请求: { model, input: { text, voice, format, sample_rate } }
 * 返回: { output: { audio: { url, expires_at } }, usage: { characters } } —— ★ 给的是【音频 URL】不是二进制
 *
 * ★ TTSProviderAdapter.parseResponse 要 audioHex → 这里先下载音频再转 hex;
 *   audioLength 用 ffprobe 实测 (临时文件用完即删)。
 * ★ Key 从 ai_service_configs.api_key 来 (设置页保存); 本文件不出现任何真实 Key。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { TTSProviderAdapter, AIConfig } from './types'
import { probeDuration } from '../../utils/ffprobe-helpers.js'
import { logTaskProgress, logTaskWarn } from '../../utils/task-logger.js'

/** Token Plan TTS 默认端点 (华北2 北京; 目前仅此区域) */
export const BAILIAN_TTS_DEFAULT_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com'
export const BAILIAN_TTS_DEFAULT_MODEL = 'qwen-audio-3.0-tts-plus'
export const BAILIAN_TTS_DEFAULT_VOICE = 'longanhuan_v3.6'
const BAILIAN_TTS_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer'

export class BailianTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'bailian'

  buildGenerateRequest(config: AIConfig, params: any): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const base = String(config.baseUrl || '').trim() || BAILIAN_TTS_DEFAULT_BASE_URL
    const url = base.replace(/\/+$/, '') + BAILIAN_TTS_PATH

    // ★ 音色优先级: 角色显式 voice > 配置里的 settings.voice > 默认 longanhuan_v3.6
    const configVoice = (config as any)?.settings?.voice
    const voice = String(params?.voice || configVoice || BAILIAN_TTS_DEFAULT_VOICE)

    return {
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: params?.model || BAILIAN_TTS_DEFAULT_MODEL,
        input: {
          text: params.text,
          voice,
          format: 'mp3',
          sample_rate: 22050,
        },
      },
    }
  }

  async parseResponse(result: any): Promise<{
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  }> {
    const audioUrl = result?.output?.audio?.url
    const expiresAt = result?.output?.audio?.expires_at
    const characters = result?.usage?.characters

    // ★ 失败要带 HTTP 状态码 + 返回体, 别吞成一句话
    if (!audioUrl) {
      const status = result?.status_code ?? result?.code ?? result?.http_status
      const detail = JSON.stringify(result).slice(0, 1200)
      throw new Error(`Bailian TTS 未返回音频 URL${status != null ? ` (HTTP ${status})` : ''}: ${detail}`)
    }

    logTaskProgress('AudioTask', 'bailian-tts-response', {
      audioUrlHost: (() => { try { return new URL(String(audioUrl)).host } catch { return 'invalid-url' } })(),
      expiresAt: expiresAt ?? null,
      usageCharacters: typeof characters === 'number' ? characters : null,
      hint: '百炼只返回音频 URL (有时效) + usage.characters; 下面下载音频再转 hex',
    })

    const resp = await fetch(String(audioUrl))
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Bailian TTS 音频下载失败 HTTP ${resp.status}: ${String(body).slice(0, 500)}`)
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (!buf.length) {
      throw new Error(`Bailian TTS 下载到的音频为空 (HTTP ${resp.status})`)
    }

    // 实测时长 (临时文件 → ffprobe → 删除)
    let audioLengthMs = 0
    const tmp = path.join(os.tmpdir(), `bailian-tts-${randomUUID()}.mp3`)
    try {
      fs.writeFileSync(tmp, buf)
      const sec = await probeDuration(tmp)
      audioLengthMs = Math.round((Number(sec) || 0) * 1000)
    } catch (err: any) {
      logTaskWarn('AudioTask', 'bailian-tts-probe-failed', { error: err?.message || String(err), bytes: buf.length })
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }

    return {
      audioHex: buf.toString('hex'),
      audioLength: audioLengthMs,
      sampleRate: 22050,
      bitrate: 0,
      format: 'mp3',
      channel: 1,
    }
  }
}

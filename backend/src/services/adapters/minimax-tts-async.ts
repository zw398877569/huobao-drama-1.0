/**
 * MiniMax 异步语音合成 Adapter
 * 文档: https://platform.minimaxi.com/docs/guides/speech-t2a-async
 *
 * 流程: 创建任务 -> 轮询 -> 下载音频
 *   1. POST  {baseUrl}/v1/t2a_async_v2                 (创建任务, 返回 task_id)
 *   2. GET   {baseUrl}/v1/query/t2a_async_query_v2     (轮询, 完成后返回 file_id)
 *   3. GET   {baseUrl}/v1/files/retrieve_content       (下载音频二进制)
 */
import { joinProviderUrl } from './url'

export interface AsyncTTSParams {
  text?: string
  textFileId?: string
  model?: string
  voiceId: string
  speed?: number
  vol?: number
  pitch?: number
  languageBoost?: string
  emotion?: string
  audioSampleRate?: number
  bitrate?: number
  format?: 'mp3' | 'pcm' | 'flac' | 'wav'
  channel?: 1 | 2
  pronunciationDictTone?: string[]            // ["草地/(cao3)(di1)"]
  voiceModify?: {                             // 声音修饰
    pitch?: number
    intensity?: number
    timbre?: number
    soundEffects?: string
  }
}

export interface AsyncTTSTaskHandle {
  taskId: string
}

export interface AsyncTTSQueryResult {
  status: 'processing' | 'success' | 'failed'
  fileId?: string
  error?: string
  raw?: any
}

export class MiniMaxTTSAsyncAdapter {
  readonly provider = 'minimax'

  /** 1. 创建任务: POST {baseUrl}/v1/t2a_async_v2 */
  buildCreateRequest(config: { baseUrl: string; apiKey: string }, params: AsyncTTSParams) {
    if (!params.text && !params.textFileId) {
      throw new Error('MiniMaxTTSAsync: text or textFileId is required')
    }
    if (params.text && params.textFileId) {
      throw new Error('MiniMaxTTSAsync: provide either text or textFileId, not both')
    }

    const body: any = {
      model: params.model || 'speech-2.8-hd',
      voice_setting: {
        voice_id: params.voiceId,
        speed: params.speed ?? 1,
        vol: params.vol ?? 10,
        pitch: params.pitch ?? 1,
      },
      audio_setting: {
        audio_sample_rate: params.audioSampleRate ?? 32000,
        bitrate: params.bitrate ?? 128000,
        format: params.format ?? 'mp3',
        channel: params.channel ?? 1,
      },
    }
    if (params.text) body.text = params.text
    if (params.textFileId) body.text_file_id = params.textFileId
    if (params.languageBoost) body.language_boost = params.languageBoost
    if (params.emotion) body.voice_setting.emotion = params.emotion
    if (params.pronunciationDictTone && params.pronunciationDictTone.length > 0) {
      body.pronunciation_dict = { tone: params.pronunciationDictTone }
    }
    if (params.voiceModify) {
      body.voice_modify = params.voiceModify
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/t2a_async_v2'),
      method: 'POST' as const,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  }

  parseCreateResponse(result: any): AsyncTTSTaskHandle {
    // 文档未给精确响应格式；按 MiniMax 一贯风格
    // 成功: { task_id: "...", base_resp: { status_code: 0, status_msg: "success" } }
    if (result?.base_resp?.status_code !== undefined && result.base_resp.status_code !== 0) {
      throw new Error(result?.base_resp?.status_msg || 'TTS async: create task failed')
    }
    const taskId = result?.task_id
    if (!taskId) {
      throw new Error('TTS async: no task_id in response: ' + JSON.stringify(result).slice(0, 300))
    }
    return { taskId }
  }

  /** 2. 轮询: GET {baseUrl}/v1/query/t2a_async_query_v2?task_id=xxx */
  buildQueryRequest(config: { baseUrl: string; apiKey: string }, taskId: string) {
    const url = new URL(joinProviderUrl(config.baseUrl, '/v1', '/query/t2a_async_query_v2'))
    url.searchParams.set('task_id', taskId)
    return {
      url: url.toString(),
      method: 'GET' as const,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  }

  parseQueryResponse(result: any): AsyncTTSQueryResult {
    // 推测形态: { status: "processing"|"success"|"failed", file_id?, base_resp? }
    // 也可能是 { base_resp: { status_code }, data: { status, file_id } }
    const statusRaw = (result?.status || result?.data?.status || '').toString().toLowerCase()
    let status: AsyncTTSQueryResult['status'] = 'processing'
    if (statusRaw === 'success' || statusRaw === 'completed' || statusRaw === 'done' || statusRaw === 'finished') {
      status = 'success'
    } else if (statusRaw === 'failed' || statusRaw === 'error' || statusRaw === 'fail') {
      status = 'failed'
    } else if (result?.base_resp?.status_code === -1 || result?.base_resp?.status_code === 1) {
      status = 'failed'
    }
    const fileId = result?.file_id || result?.data?.file_id
    const error = result?.error || result?.base_resp?.status_msg || result?.data?.error_msg
    return { status, fileId, error, raw: result }
  }

  /** 3. 下载: GET {baseUrl}/v1/files/retrieve_content?file_id=xxx */
  buildDownloadRequest(config: { baseUrl: string; apiKey: string }, fileId: string) {
    const url = new URL(joinProviderUrl(config.baseUrl, '/v1', '/files/retrieve_content'))
    url.searchParams.set('file_id', fileId)
    return {
      url: url.toString(),
      method: 'GET' as const,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
    }
  }

  /** 3.5) 解 minimax /files/retrieve_content 返回的 tar 归档,只回 mp3 字节
   *  minimax 实际返回的是个 POSIX tar,内含 *.mp3 / *.titles / *.extra 三份文件 */
  parseDownloadResponse(body: Buffer | Uint8Array): { audio: Buffer; entries: Array<{ name: string; bytes: number }> } {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const entries: Array<{ name: string; bytes: number }> = []
    const BLOCK = 512
    let off = 0
    let mp3: Buffer | null = null
    while (off + BLOCK <= buf.length) {
      const header = buf.subarray(off, off + BLOCK)
      // 两个连续的零块表示 tar 结束
      if (header.every((b) => b === 0)) break
      // 文件名 0..99
      let nameEnd = 0
      while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++
      const name = header.subarray(0, nameEnd).toString('utf8').trim() || '(unnamed)'
      // size 在 124..136,八进制 ASCII
      let sizeStr = ''
      for (let i = 0; i < 12; i++) {
        const c = header[124 + i]
        if (c === 0 || c === 0x20) break
        if (i === 0 && c === 0x80) continue   // 跳过二进制标记位
        if (c < 0x30 || c > 0x37) break
        sizeStr += String.fromCharCode(c)
      }
      const size = sizeStr ? parseInt(sizeStr, 8) : 0
      off += BLOCK
      const data = buf.subarray(off, off + size)
      const padded = Math.ceil(size / BLOCK) * BLOCK
      off += padded
      entries.push({ name, bytes: size })
      if (name.toLowerCase().endsWith('.mp3') && !mp3) {
        mp3 = Buffer.from(data)
      }
    }
    if (!mp3) {
      throw new Error(
        `minimax tar contains no .mp3 (entries: ${entries.map((e) => e.name).join(', ') || 'none'})`
      )
    }
    return { audio: mp3, entries }
  }
}

export const minimaxTTSAsync = new MiniMaxTTSAsyncAdapter()

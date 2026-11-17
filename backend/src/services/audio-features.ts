/**
 * ★ Sprint 47 T10 (PM msg-20261115-188): 音频实测特征 (语速 / 音高 / 停顿)
 *
 * 【为什么要这个】
 *   音色分配 agent 只能拿到 base64 音频 → 它【感知不到音高/语速/停顿】这类数值
 *   → 只能靠音色描述文字挑 → 挑不准 (PM 的原话)。
 *   → 这里在生成样本之后【本地实测】这三个特征, 跟音频一起返回给 agent → "看数值 + 听音色"双重判断。
 *
 * 【怎么测】
 *   ffmpeg 解码成 16k 单声道 PCM → 纯 JS 分析:
 *   · 时长/有效发声时长: 按帧 RMS 划分有声/无声
 *   · 停顿次数: 连续无声段 (>150ms) 的个数
 *   · 音高: 有声帧做自相关 (ACF) → 每帧基频 → 取中位数 (中位数比均值抗异常帧)
 *   · 语速: 文本字数 / 有效发声时长 (★ 去掉停顿 → 不同人说话快慢才可比)
 *
 * 【可比性】
 *   · 语速用"有效发声时长"做分母, 不是总时长 → 停顿多的音色不会被算成慢
 *   · 停顿次数另外给"每百字"口径 → 文本长短不同时也可比
 *   · 音高取中位基频 → 与音色本身绑定, 与文本无关
 *   ★ 建议 agent 对比多个候选音色时用【同一条文本 + 同样语速设置】→ 数值才严格可比
 *
 * 【开销】
 *   一次 ffmpeg 解码 (3~5 秒样本) + 纯 JS 计算 → 实测 < 300ms, 不影响试听工具的可用性
 */
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

export interface AudioFeatures {
  /** 音频总时长 (秒) */
  durationSec: number
  /** 有效发声时长 (秒, 去掉停顿) */
  speechSec: number
  /** 文本字数 (用于算语速) */
  chars: number
  /** 语速: 字 / 有效发声秒 (≈ 4~6 字/秒 是中文正常口播) */
  speechRate: number
  /** 中位基频 (Hz), 0 = 没测出来 */
  pitchHz: number
  /** 音高量级 (低 / 中 / 高 / 未知) */
  pitchLevel: '低' | '中' | '高' | '未知'
  /** 停顿次数 (>150ms 的无声段个数) */
  pauseCount: number
  /** 停顿总时长 (秒) */
  pauseSec: number
  /** 每百字停顿次数 (跨文本长度可比) */
  pausesPer100Chars: number
}

/** 分析采样率 */
const SAMPLE_RATE = 16000
/** 分析帧长 (64ms) */
const FRAME_SIZE = 512
/** 帧移 (32ms) */
const FRAME_HOP = 256
/** 停顿判定阈值 (秒) */
const PAUSE_MIN_SEC = 0.15
/** 有声帧的最低 RMS (相对最大 RMS) */
const VOICED_RATIO = 0.06
/** 自相关可信阈值 */
const ACF_CONFIDENCE = 0.3
/**
 * 自相关搜索范围 (在 8kHz 降采样后的采样点数):
 *   LAG_MIN=25 → 最高 320Hz (女声高音必须能测到, 否则会被截断到下一个谐波 → 音高偏低)
 *   LAG_MAX=200 → 最低 40Hz
 */
const LAG_MIN = 25
const LAG_MAX = 200

/** 文本字数 (中文按字算, 去掉空白与标点) */
export function countSpeechChars(text: string): number {
  return String(text || '')
    .replace(/[\s　]/g, '')
    .replace(/[，。！？、；：""''（）《》…—~,.!?;:"'()<>\[\]\-]/g, '')
    .length
}

/** 把 PCM 字节转成 Float32 样本 (-1 ~ 1) */
function pcm16ToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768
  }
  return out
}

/**
 * 用 ffmpeg 解码成 16k 单声道 s16le PCM。
 * @returns Buffer (空 = 解码失败)
 */
export function decodeToPcm(filePath: string, sampleRate: number = SAMPLE_RATE): Promise<Buffer> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-',
    ]
    execFile(
      'ffmpeg',
      args,
      { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' } as any,
      (err: any, stdout: any) => {
        if (err && (!stdout || !stdout.length)) { resolve(Buffer.alloc(0)); return }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || []))
      },
    )
  })
}

/**
 * ★ 自相关基频估计 (单帧)。
 * @param samples 降采样后的帧 (8kHz)
 * @returns 基频 Hz (0 = 没测出来)
 */
export function estimatePitchHz(samples: Float32Array): number {
  const n = samples.length
  if (n < LAG_MIN * 2) return 0
  let energy = 0
  for (let i = 0; i < n; i++) energy += samples[i] * samples[i]
  if (energy / n < 1e-6) return 0

  // 自相关曲线: 找到全局最大峰, 再【往前】找第一个达到它 85% 的 lag
  //   → 避免挑到次谐波 (基频被砍半: 女声测成 130Hz 而不是 220Hz 这种)
  const acf = new Float32Array(LAG_MAX + 1)
  let bestVal = 0
  for (let lag = LAG_MIN; lag <= LAG_MAX && lag < n; lag++) {
    let sum = 0
    let norm = 0
    for (let i = 0; i < n - lag; i++) {
      sum += samples[i] * samples[i + lag]
      norm += samples[i] * samples[i] + samples[i + lag] * samples[i + lag]
    }
    const val = norm > 0 ? (2 * sum) / norm : 0
    acf[lag] = val
    if (val > bestVal) bestVal = val
  }
  if (bestVal < ACF_CONFIDENCE) return 0
  const threshold = bestVal * 0.85
  let bestLag = 0
  for (let lag = LAG_MIN; lag <= LAG_MAX && lag < n; lag++) {
    if (acf[lag] >= threshold) { bestLag = lag; break }
  }
  if (!bestLag) return 0
  const sampleRate = SAMPLE_RATE / 2   // 降采样到 8k
  return sampleRate / bestLag
}

/** 音高量级 (中文播音参考: 男声 ~90-155Hz / 女声 ~165-255Hz) */
export function pitchLevelOf(hz: number): '低' | '中' | '高' | '未知' {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return '未知'
  if (hz < 120) return '低'
  if (hz <= 180) return '中'
  return '高'
}

/** 空结果 (分析失败时用) */
export function emptyAudioFeatures(chars = 0): AudioFeatures {
  return {
    durationSec: 0, speechSec: 0, chars, speechRate: 0,
    pitchHz: 0, pitchLevel: '未知', pauseCount: 0, pauseSec: 0, pausesPer100Chars: 0,
  }
}

/**
 * ★ 主入口: 分析音频文件的实测特征。
 * @param filePath 音频文件绝对路径
 * @param text 对应的文本 (算语速用)
 */
export async function analyzeAudioFeatures(filePath: string, text: string): Promise<AudioFeatures> {
  const chars = countSpeechChars(text)
  let pcm: Buffer
  try {
    if (!fs.existsSync(filePath)) return emptyAudioFeatures(chars)
    pcm = await decodeToPcm(filePath)
  } catch {
    return emptyAudioFeatures(chars)
  }
  if (!pcm.length) return emptyAudioFeatures(chars)

  const samples = pcm16ToFloat(pcm)
  const durationSec = samples.length / SAMPLE_RATE
  if (durationSec <= 0) return emptyAudioFeatures(chars)

  // 逐帧 RMS
  const frames: number[] = []
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += FRAME_HOP) {
    let sum = 0
    for (let i = start; i < start + FRAME_SIZE; i++) sum += samples[i] * samples[i]
    frames.push(Math.sqrt(sum / FRAME_SIZE))
  }
  if (!frames.length) return emptyAudioFeatures(chars)

  const maxRms = Math.max(...frames)
  const voicedThreshold = Math.max(maxRms * VOICED_RATIO, 1e-4)
  // ★ 记账用【帧移】(32ms) 而不是帧长 (64ms) —— 帧是重叠的, 按帧长记账会让"发声时长"超过总时长
  const frameSec = FRAME_HOP / SAMPLE_RATE

  // 有声时长 + 停顿
  let speechSec = 0
  let pauseSec = 0
  let pauseCount = 0
  let inPause = false
  let pauseRun = 0
  for (const rms of frames) {
    const voiced = rms >= voicedThreshold
    if (voiced) {
      speechSec += frameSec
      if (inPause) {
        // 静音段结束 → 够长才算一次停顿
        if (pauseRun >= PAUSE_MIN_SEC) pauseCount++
        inPause = false
        pauseRun = 0
      }
    } else {
      pauseSec += frameSec
      pauseRun += frameSec
      inPause = true
    }
  }
  if (inPause && pauseRun >= PAUSE_MIN_SEC) pauseCount++

  // 音高: 有声帧逐帧自相关 → 取中位数 (降采样到 8k 再算)
  const dec = 2
  const pitches: number[] = []
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += FRAME_HOP) {
    let sum = 0
    for (let i = start; i < start + FRAME_SIZE; i++) sum += samples[i] * samples[i]
    if (Math.sqrt(sum / FRAME_SIZE) < voicedThreshold) continue
    const frame = new Float32Array(Math.floor(FRAME_SIZE / dec))
    for (let i = 0; i < frame.length; i++) frame[i] = samples[start + i * dec]
    const hz = estimatePitchHz(frame)
    if (hz > 0) pitches.push(hz)
  }
  pitches.sort((a, b) => a - b)
  const pitchHz = pitches.length ? Math.round(pitches[Math.floor(pitches.length / 2)] * 10) / 10 : 0

  const effectiveSpeech = speechSec > 0 ? speechSec : durationSec
  return {
    durationSec: Math.round(durationSec * 100) / 100,
    speechSec: Math.round(speechSec * 100) / 100,
    chars,
    speechRate: effectiveSpeech > 0 ? Math.round((chars / effectiveSpeech) * 100) / 100 : 0,
    pitchHz,
    pitchLevel: pitchLevelOf(pitchHz),
    pauseCount,
    pauseSec: Math.round(pauseSec * 100) / 100,
    pausesPer100Chars: chars > 0 ? Math.round((pauseCount / chars) * 100 * 100) / 100 : 0,
  }
}

/** 把特征压成给 LLM 看的一行摘要 */
export function formatAudioFeatures(f: AudioFeatures): string {
  if (!f.durationSec) return '特征不可用 (音频没解出来)'
  return [
    `语速 ${f.speechRate} 字/秒`,
    `音高 ${f.pitchHz || '?'}Hz (${f.pitchLevel})`,
    `停顿 ${f.pauseCount} 次 / 每百字 ${f.pausesPer100Chars}`,
    `时长 ${f.durationSec}s`,
  ].join(' · ')
}

/** 特征缓存 (进程内): 同一个音色多次试听不用重复分析 */
const featureCache = new Map<string, AudioFeatures>()

export function cacheAudioFeatures(voiceId: string, f: AudioFeatures): void {
  if (!voiceId) return
  featureCache.set(voiceId, f)
}

export function getCachedAudioFeatures(voiceId: string): AudioFeatures | null {
  return featureCache.get(voiceId) ?? null
}


/**
 * ★ Sprint 51 T1 (PM msg-20261117-204): 配音【音高体检】用的基频估计 (宽窗口)
 *
 * 【为什么要单独一个, 不能改上面的 estimatePitchHz】
 *   上面的 estimatePitchHz 是【音色分配 agent】用的特征 (8kHz 降采样 + LAG_MIN=25 → 最高 320Hz),
 *   它的语义与用途不能动 (音色试听/音色分配的输出要保持不变)。
 *   而【音高体检】要能测出 385~524Hz 的异常段 —— 窄窗会把它们截断/误报成 ~290Hz
 *   (QA 第一轮就踩了这个坑: 窗口上限不够 → 400Hz+ 的段落被当成 290Hz)。
 *   → 这里单独实现一套: 32kHz 单声道 + 搜索窗 60~800Hz, 与上面的特征完全隔离。
 *
 * 【测法】逐帧 (2048 点 = 64ms, 帧移 1024) 做归一化自相关:
 *   · 在 lag 窗 [32000/800, 32000/60] = [40, 533] 里找【局部峰里自相关值最大的那个】
 *     (只取局部峰 = 不会把谐波当成基频; 取最大值 = 不会挑到次谐波把基频砍半)
 *   · 抛物线插值取亚采样精度 → 每帧一个 F0
 *   · 整段取【中位数】(抗异常帧, 跟上面的实现同一口径)
 */
export const PITCH_HEALTH_MIN_HZ = 60
export const PITCH_HEALTH_MAX_HZ = 800
/** 体检专用采样率 (MiniMax TTS 输出本身就是 32k) */
export const PITCH_HEALTH_SAMPLE_RATE = 32000
/** 帧长 2048 点 (64ms) / 帧移 1024 点 (32ms) */
const HEALTH_FRAME = 2048
const HEALTH_HOP = 1024
/** 自相关可信阈值 (低于这个值说明这帧没有明显的周期) */
const HEALTH_MIN_CONF = 0.6

export interface PitchHealth {
  /** 中位基频 (Hz); 0 = 没测出来 */
  f0Hz: number
  /** 参与统计的帧数 */
  frames: number
  /** 帧间波动 = 最大值/中位数 (越大说明这次渲染越不稳) */
  spread: number
}

/**
 * 测一段音频的基频 (音高体检用)。
 * @param filePath 音频文件绝对路径
 */
export async function measurePitchHealth(filePath: string): Promise<PitchHealth> {
  const empty: PitchHealth = { f0Hz: 0, frames: 0, spread: 0 }
  try {
    if (!fs.existsSync(filePath)) return empty
  } catch {
    return empty
  }
  let pcm: Buffer
  try {
    pcm = await decodeToPcm(filePath, PITCH_HEALTH_SAMPLE_RATE)
  } catch {
    return empty
  }
  if (!pcm.length) return empty
  const samples = pcm16ToFloat(pcm)
  if (samples.length < HEALTH_FRAME) return empty

  const lagMin = Math.max(2, Math.floor(PITCH_HEALTH_SAMPLE_RATE / PITCH_HEALTH_MAX_HZ))
  const lagMax = Math.min(Math.floor(PITCH_HEALTH_SAMPLE_RATE / PITCH_HEALTH_MIN_HZ), Math.floor(samples.length / 2))
  const vals: number[] = []

  for (let start = 0; start + HEALTH_FRAME <= samples.length; start += HEALTH_HOP) {
    const seg = samples.subarray(start, start + HEALTH_FRAME)
    // 去均值 + 能量门限 (静音帧不参与)
    let mean = 0
    for (let i = 0; i < seg.length; i++) mean += seg[i]
    mean /= seg.length
    let energy = 0
    for (let i = 0; i < seg.length; i++) { const v = seg[i] - mean; energy += v * v }
    if (energy / seg.length < 1e-6) continue

    // 归一化自相关 (2*sum / (sum1+sum2))
    const acf = new Float32Array(lagMax + 1)
    let bestVal = 0
    let bestLag = 0
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0
      let norm = 0
      const n = seg.length - lag
      for (let i = 0; i < n; i++) {
        const a = seg[i] - mean
        const b = seg[i + lag] - mean
        sum += a * b
        norm += a * a + b * b
      }
      const val = norm > 0 ? (2 * sum) / norm : 0
      acf[lag] = val
      // ★ 只在【局部峰】里取最大值 (谐波不算基频; 也不会挑到次谐波把基频砍半)
      if (lag > lagMin && lag < lagMax && val > acf[lag - 1] && val >= acf[lag + 1] && val > bestVal) {
        bestVal = val
        bestLag = lag
      }
    }
    if (!bestLag || bestVal < HEALTH_MIN_CONF) continue
    // 抛物线插值 (亚采样精度)
    const y0 = acf[bestLag - 1]
    const y1 = acf[bestLag]
    const y2 = acf[bestLag + 1]
    const denom = y0 - 2 * y1 + y2
    const shift = denom !== 0 ? (y0 - y2) / (2 * denom) : 0
    const f0 = PITCH_HEALTH_SAMPLE_RATE / (bestLag + shift)
    if (f0 >= PITCH_HEALTH_MIN_HZ && f0 <= PITCH_HEALTH_MAX_HZ) vals.push(f0)
  }
  if (!vals.length) return empty
  vals.sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
  return {
    f0Hz: Math.round(median * 10) / 10,
    frames: vals.length,
    spread: median > 0 ? Math.round((vals[vals.length - 1] / median) * 100) / 100 : 0,
  }
}

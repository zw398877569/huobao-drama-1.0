/**
 * ★ 单 245 (PM msg-20261126-245): TTS 音频的【语音段】检测 + 按语音段对齐切文本/切时间轴
 *
 * 【背景】一句话写成一段 → TTS 合成出的 mp3 里其实有 N 段语音 (句间有停顿),
 *   但回写 storyboards.tts_segments 时只写了 1 条 → 合成阶段一条 segment 生成一条字幕
 *   → 26 字一次性挂 5.2s, 而人声是分几次念的 → 字幕节奏与语音节奏错位。
 *
 * 【修法】用 silencedetect 量出音频真实【语音段】, 按它:
 *   - T1 (治本): 回写 tts_segments 时逐句写 (条数 = 语音段数, 每条带自己的真实时长)
 *   - T2 (兜底): 存量数据 (只有 1 条 segment) 在字幕层按语音段拆成多条字幕
 *
 * ★ 参数 (noise / d) 是【固定口径】—— 改参数会改变语音段数, 与验收口径必须一致。
 * ★ 纯函数部分 (解析/切分/时长分配) 零依赖, 可离线断言; 只有 detectSpeechChunks 会调 ffmpeg。
 */
import { spawnSync } from 'child_process'

/** silencedetect 噪声阈值 (dB) —— 固定口径 */
export const SILENCE_NOISE = '-30dB'
/** silencedetect 最短静音时长 (秒) —— 固定口径 */
export const SILENCE_MIN_DURATION = '0.3'

/** 语音段最短时长 (秒) —— 短于此的算残留碎片, 并入前一段 */
export const MIN_CHUNK_SEC = 0.2

export interface SpeechChunk {
  start: number
  end: number
}

export interface SpeechAnalysis {
  /** 音频总时长 (秒) */
  durationSec: number
  /** 语音段 (非静音区间), 按时间升序 */
  chunks: SpeechChunk[]
  /** 静音区间 */
  silences: SpeechChunk[]
}

/**
 * 纯函数: 解析 ffmpeg silencedetect 的输出
 * (行形如 'silence_start: 0' / 'silence_end: 0.373406')
 */
export function parseSilenceEvents(output: string): SpeechChunk[] {
  const silences: SpeechChunk[] = []
  let pendingStart: number | null = null
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim()
    const mStart = line.match(/silence_start:\s*(-?[0-9.]+)/)
    if (mStart) {
      pendingStart = Number(mStart[1])
      continue
    }
    const mEnd = line.match(/silence_end:\s*(-?[0-9.]+)/)
    if (mEnd && pendingStart != null) {
      silences.push({ start: pendingStart, end: Number(mEnd[1]) })
      pendingStart = null
    }
  }
  return silences
}

/**
 * 纯函数: 静音区间 → 语音段 (取补集; 相邻/重叠的静音先合并)
 */
export function chunksFromSilences(silences: SpeechChunk[], durationSec: number): SpeechChunk[] {
  const merged: SpeechChunk[] = []
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ start: s.start, end: s.end })
  }
  const chunks: SpeechChunk[] = []
  let cursor = 0
  for (const s of merged) {
    const start = Math.max(0, Math.min(s.start, durationSec))
    const end = Math.max(0, Math.min(s.end, durationSec))
    if (end <= cursor) continue
    if (start > cursor) chunks.push({ start: cursor, end: start })
    cursor = Math.max(cursor, end)
  }
  if (cursor < durationSec) chunks.push({ start: cursor, end: durationSec })
  // ★ 太短的语音段 (mp3 尾部常见的几十毫秒残留) 并入前一段 → 不算成独立一段语音
  const mergedChunks: SpeechChunk[] = []
  for (const c of chunks) {
    const last = mergedChunks[mergedChunks.length - 1]
    if (last && c.end - c.start < MIN_CHUNK_SEC) {
      last.end = Math.max(last.end, c.end)
      continue
    }
    mergedChunks.push({ ...c })
  }
  return mergedChunks
}

/**
 * 纯函数: 标点候选切分 —— 返回每段文本与它在原串里的结束位置
 * (标点: 句末 。！？… + 可断句处 ，；、)
 */
export function splitByPunctuation(text: string): { piece: string; end: number }[] {
  const clean = String(text || '').trim()
  if (!clean) return []
  const out: { piece: string; end: number }[] = []
  let buf = ''
  let offset = 0   // ★ 累计位置 (end = 该段在【整串】里的结束下标)
  for (const ch of clean) {
    buf += ch
    offset += 1
    if (/[。！？!?,，;；…、]/.test(ch)) {
      out.push({ piece: buf.trim(), end: offset })
      buf = ''
    }
  }
  if (buf.trim()) out.push({ piece: buf.trim(), end: clean.length })
  return out.filter((c) => !!c.piece)
}

/**
 * 纯函数: 按语音段把文本切成 chunks.length 段
 *   - 候选 = 标点切分; 目标位置 = 各语音段的【时长比例】× 总字数
 *   - 在候选里挑最接近目标位置的边界 (单调) → 拆出来的段数 == 语音段数
 *   - ★ 文字内容一个字不丢 (拼起来 == 原文本)
 */
export function splitTextBySpeechChunks(text: string, chunks: SpeechChunk[]): string[] {
  const clean = String(text || '').trim()
  const n = (chunks || []).length
  if (!clean) return []
  if (n <= 1) return [clean]
  const cands = splitByPunctuation(clean)
  if (cands.length <= 1) return [clean]
  const speechTotal = chunks.reduce((s, c) => s + Math.max(0, c.end - c.start), 0) || 1
  // 目标字符位置 (按语音时长累计比例)
  const targets: number[] = []
  let accDur = 0
  for (let i = 0; i < n - 1; i++) {
    accDur += Math.max(0, chunks[i].end - chunks[i].start)
    targets.push((accDur / speechTotal) * clean.length)
  }
  // 单调地挑 N-1 个候选边界 (最接近目标; 最后一个候选不能当中间边界)
  const chosen: number[] = []
  let minIdx = 0
  for (const t of targets) {
    let best = -1
    let bestDiff = Infinity
    for (let i = minIdx; i < cands.length - 1; i++) {
      const diff = Math.abs(cands[i].end - t)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    }
    if (best < 0) break
    chosen.push(best)
    minIdx = best + 1
  }
  const pieces: string[] = []
  let prev = 0
  for (const idx of chosen) {
    const piece = clean.slice(prev, cands[idx].end).trim()
    if (piece) pieces.push(piece)
    prev = cands[idx].end
  }
  const tail = clean.slice(prev).trim()
  if (tail) pieces.push(tail)
  return pieces.length ? pieces : [clean]
}

/**
 * 纯函数: 各语音段对应的字幕时长
 *   - 首段吸收前置静音 (从 0 开始), 末段到音频总长 → ★ 各段之和 == 音频真实总时长
 */
export function chunkDurations(chunks: SpeechChunk[], durationSec: number): number[] {
  const out: number[] = []
  const n = (chunks || []).length
  for (let i = 0; i < n; i++) {
    const start = i === 0 ? 0 : chunks[i].start
    const end = i === n - 1 ? durationSec : chunks[i + 1].start
    out.push(Math.max(0, end - start))
  }
  return out
}

/**
 * 调 ffmpeg silencedetect → 语音段 (失败返回 null, 不许影响主流程)
 */
export function detectSpeechChunks(
  audioAbsPath: string,
  durationSec: number,
): SpeechAnalysis | null {
  if (!audioAbsPath || !(durationSec > 0)) return null
  try {
    const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-nostats',
        '-i', audioAbsPath,
        '-af', `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN_DURATION}`,
        '-f', 'null', '-',
      ],
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    )
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    const silences = parseSilenceEvents(out)
    const chunks = chunksFromSilences(silences, durationSec)
    if (!chunks.length) return null
    return { durationSec, chunks, silences }
  } catch {
    return null
  }
}

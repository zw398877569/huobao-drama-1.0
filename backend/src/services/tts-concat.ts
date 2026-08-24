/**
 * TTS 多角色合成 + 拼接服务
 *
 * 解决:旧 parseDialogueForTTS 把整段多角色对白用一个 voice 合成,导致 TTS 文件
 * 里出现其他角色的声音(用第一个角色音色读)。新流程:
 *   1. 解析 dialogue 为 segments
 *   2. 合并同一 speaker 连续对白为一段(减少 API 调用次数)
 *   3. 每段用对应角色的 voice 单独调 generateTTS
 *   4. ffmpeg concat demuxer 拼接(不 re-encode,毫秒级)
 *   5. 存拼接后的总 audio + segments metadata
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generateTTS } from './tts-generation.js'
import { parseDialogueSegments, type DialogueSegment } from '../utils/dialogue-parser.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const NARRATOR_VOICE_FALLBACK = process.env.NARRATOR_VOICE || 'alloy'

export interface TTSSegmentMeta {
  speaker: string
  text: string
  voice: string
  isNarrator: boolean
  segmentPath: string  // 相对路径,例如 static/audio/seg_xxx.mp3
  durationMs?: number
}

export interface TTSComposeResult {
  audioPath: string     // 拼接后的总 audio 相对路径
  segments: TTSSegmentMeta[]
  ignored: boolean
  reason?: string
}

/**
 * 把 segments 中相邻且 speaker 相同的合并(同一人连着说话通常一起合成更自然)
 */
function coalesceAdjacent(segments: DialogueSegment[]): Array<{ speaker: string; text: string; isNarrator: boolean }> {
  const out: Array<{ speaker: string; text: string; isNarrator: boolean }> = []
  for (const seg of segments) {
    const last = out[out.length - 1]
    if (last && last.speaker === seg.speaker && last.isNarrator === seg.isNarrator) {
      last.text = `${last.text} ${seg.text}`.trim()
    } else {
      out.push({ speaker: seg.speaker, text: seg.text, isNarrator: seg.isNarrator })
    }
  }
  return out
}

function getVoiceForSpeaker(episodeId: number, speaker: string, isNarrator: boolean): string {
  if (isNarrator) return NARRATOR_VOICE_FALLBACK
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return 'alloy'
  const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
  const found = chars.find((c) => c.name === speaker)
  if (found?.voiceStyle) return found.voiceStyle
  return 'alloy'
}

function getEpisodeConfigId(episodeId: number): number | null | undefined {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return ep?.audioConfigId
}

/**
 * 用 ffmpeg concat demuxer 拼接多段 mp3(不 re-encode,速度极快)。
 * 失败时 fallback 到 sequential concat 协议(老协议,兼容更多编解码器)。
 */
function ffmpegConcat(segmentPaths: string[], outputPath: string): void {
  // 所有 segment 在同一目录,使用相对路径最稳
  const listFile = path.join(os.tmpdir(), `tts-concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  try {
    const segDir = path.dirname(segmentPaths[0])
    const listBody = segmentPaths
      .map((p) => `file '${path.relative(segDir, p).replace(/'/g, "'\\''")}'`)
      .join('\n')
    fs.writeFileSync(listFile, listBody, 'utf8')
    logTaskProgress('TTSConcat', 'ffmpeg-concat', { count: segmentPaths.length, listFile })
    execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: any) {
    // 失败时回退到 sequential concat
    logTaskError('TTSConcat', 'ffmpeg-concat-fail', { error: e?.message })
    execFileSync('ffmpeg', ['-y', '-i', 'concat:' + segmentPaths.join('|'), '-c', 'copy', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    try { fs.unlinkSync(listFile) } catch { /* ignore */ }
  }
}

/**
 * 主入口:解析 dialogue → 按 speaker 分组合成 → 拼接
 */
export async function generateTTSForDialogue(
  storyboardId: number,
  episodeId: number,
  dialogue: string | null | undefined,
): Promise<TTSComposeResult> {
  const parsed = parseDialogueSegments(dialogue)
  if (parsed.ignorable) {
    return { audioPath: '', segments: [], ignored: true, reason: parsed.reason }
  }

  const logTask = { storyboardId, episodeId, rawSegments: parsed.segments.length }
  logTaskStart('TTSConcat', 'compose', logTask)

  // 合并相邻同 speaker
  const merged = coalesceAdjacent(parsed.segments)
  const configId = getEpisodeConfigId(episodeId)
  const meta: TTSSegmentMeta[] = []
  const segPaths: string[] = []

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    const voice = getVoiceForSpeaker(episodeId, m.speaker, m.isNarrator)
    logTaskProgress('TTSConcat', 'generate-segment', {
      index: i, speaker: m.speaker, isNarrator: m.isNarrator, voice, textLen: m.text.length,
    })
    const segPath = await generateTTS({
      text: m.text,
      voice,
      configId: configId ?? undefined,
    })
    segPaths.push(segPath)
    meta.push({
      speaker: m.speaker,
      text: m.text,
      voice,
      isNarrator: m.isNarrator,
      segmentPath: segPath,
    })
  }

  if (segPaths.length === 0) {
    logTaskError('TTSConcat', 'no-segments', logTask)
    return { audioPath: '', segments: [], ignored: true, reason: 'no_segments' }
  }

  // 拼接
  const dataDir = process.env.STORAGE_PATH || path.resolve(process.cwd(), 'data/static')
  const outDir = path.join(dataDir, 'audio')
  fs.mkdirSync(outDir, { recursive: true })
  const outName = `tts_${storyboardId}_${Date.now()}.mp3`
  const outAbs = path.join(outDir, outName)

  if (segPaths.length === 1) {
    // 单段直接复制,免去 ffmpeg 调用
    const single = path.isAbsolute(segPaths[0]) ? segPaths[0] : path.join(dataDir, segPaths[0])
    fs.copyFileSync(single, outAbs)
  } else {
    ffmpegConcat(
      segPaths.map((p) => (path.isAbsolute(p) ? p : path.join(dataDir, p))),
      outAbs,
    )
  }

  const relativePath = `static/audio/${outName}`
  logTaskSuccess('TTSConcat', 'compose', {
    ...logTask,
    segmentCount: meta.length,
    outPath: relativePath,
  })

  return { audioPath: relativePath, segments: meta, ignored: false }
}

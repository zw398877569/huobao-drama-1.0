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
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generateTTS } from './tts-generation.js'
import { parseDialogueSegments, type DialogueSegment } from '../utils/dialogue-parser.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const NARRATOR_VOICE_FALLBACK = process.env.NARRATOR_VOICE || 'alloy'


// ============ 2026-09-23 问题 3 — TTS 自然度优化 ============

/** atmosphere 关键词 → MiniMax emotion 枚举 */
type TTSEmotion = 'happy' | 'sad' | 'angry' | 'fearful' | 'neutral'

/**
 * 关键词表 (2026-09-25 PM msg-20260924-004 扩充: 加 sad/tense/angry 词条):
 *   - sad: 加 泪痕|哽咽|颤抖|啜泣|哭泣|泪流|崩溃|挽留|哀求|求你 (高频情绪词)
 *   - tense: 加 搏斗|对峙|剑拔弩张|心跳 (动作冲突)
 *   - angry: 加 吼叫|咆哮|嘶吼|怒骂|滚开 (愤怒口吻)
 */
const KEYWORDS_SAD = /悲伤|告别|哀悼|压抑|沉重|凄凉|lonely|farewell|melancholy|grief|sorrow|泪痕|哽咽|颤抖|啜泣|哭泣|泪流|崩溃|挽留|哀求|求你/
const KEYWORDS_TENSE = /紧张|恐惧|惊|危机|追逐|冲突|战斗|tense|fearful|panic|threat|chase|conflict|搏斗|对峙|剑拔弩张|心跳|快跑|逃跑|逃|躲|害怕|恐惧感|怕|惊吓/
const KEYWORDS_ANGRY = /愤怒|狂躁|吼|怒|angry|fury|rage|吼叫|咆哮|嘶吼|怒骂|滚开/
const KEYWORDS_WARM = /温馨|平静|舒缓|亲密|温柔|peaceful|warm|gentle|intimate|tender/
const KEYWORDS_JOYFUL = /欢乐|喜悦|团聚|开心|joyful|reunion|cheerful|delight/

/**
 * 推断源优先级 (PM msg-20260924-004 D1):
 *   1. dialogue 最高 — 台词是最直接的情感表达
 *   2. personality 次之 — 角色基线情绪
 *   3. intentFunction — 剧情目的映射 (高潮→angry/fearful, 余韵→sad, 铺垫→neutral, 反转→fearful)
 *   4. atmosphere 兜底 — 视觉氛围 (deprecated 不推荐, 但保留兼容老调用方)
 *   5. 全无信号 → neutral, speed=1.0
 *
 * 关键词命中 → emotion + speed
 */
function inferFromText(text: string | null | undefined): { emotion: TTSEmotion; speed: number } | null {
  if (!text) return null
  const lower = text.toLowerCase()
  if (KEYWORDS_SAD.test(lower)) return { emotion: 'sad', speed: 0.88 }
  if (KEYWORDS_TENSE.test(lower)) return { emotion: 'fearful', speed: 1.12 }
  if (KEYWORDS_ANGRY.test(lower)) return { emotion: 'angry', speed: 1.1 }
  if (KEYWORDS_WARM.test(lower)) return { emotion: 'neutral', speed: 0.95 }
  if (KEYWORDS_JOYFUL.test(lower)) return { emotion: 'happy', speed: 1.0 }
  return null
}

function inferFromIntentFunction(intentFunction: string | null | undefined): { emotion: TTSEmotion; speed: number } | null {
  if (!intentFunction) return null
  // 剧情目的 → 默认 emotion 模板
  // 高潮 → angry/fearful (紧张激烈)
  // 余韵 → sad (收尾哀伤)
  // 反转 → fearful (突然转折)
  // 铺垫 → neutral (平静铺垫)
  // 揭露 → tense (默认 fearful)
  // 对峙 → fearful
  // 悬念 → fearful
  // 情感爆发 → angry
  switch (intentFunction) {
    case '高潮':
    case '情感爆发':
      return { emotion: 'angry', speed: 1.1 }
    case '余韵':
      return { emotion: 'sad', speed: 0.9 }
    case '反转':
    case '对峙':
    case '悬念':
    case '揭露':
      return { emotion: 'fearful', speed: 1.08 }
    case '铺垫':
      return { emotion: 'neutral', speed: 1.0 }
    default:
      return null
  }
}

/**
 * 2026-09-25 PM msg-20260924-004 refactor: 不再只读 atmosphere, 改用 dialogue + personality +
 * intentFunction 三字段联合推断, atmosphere 仅作兜底兼容.
 *
 * 返回首个非 null 推断结果. 优先级: dialogue > personality > intentFunction > atmosphere.
 */
function inferTTSParams(opts: {
  dialogue?: string | null
  personality?: string | null
  intentFunction?: string | null
  atmosphere?: string | null
}): { emotion: TTSEmotion; speed: number } {
  // 1. dialogue 最高优先级
  let result = inferFromText(opts.dialogue)
  if (result) return result

  // 2. personality (角色基线情绪)
  result = inferFromText(opts.personality)
  if (result) return result

  // 3. intentFunction 剧情目的模板
  result = inferFromIntentFunction(opts.intentFunction)
  if (result) return result

  // 4. atmosphere 兜底 (deprecated, 保留兼容)
  result = inferFromText(opts.atmosphere)
  if (result) return result

  // 5. 全无信号
  return { emotion: 'neutral', speed: 1.0 }
}

/**
 * 从 storyboardId 查 personality + intentFunction (dialogue + atmosphere 已由 caller 传入).
 * personality: storyboardCharacters → characters.personality, 多角色取第一个.
 * intentFunction: storyboards.sceneIntention (JSON).function 字段.
 *
 * 解耦: 此函数只读 DB, 不调 TTS — 方便后续单独单测.
 */
export function loadStoryboardTTSContext(storyboardId: number): {
  personality?: string
  intentFunction?: string
} {
  // 1. personality: 多角色取第一个
  const sbChars = db.select({ characterId: schema.storyboardCharacters.characterId })
    .from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
  let personality: string | undefined
  if (sbChars.length > 0) {
    const charIds = sbChars.map(sc => sc.characterId)
    const chars = db.select({ personality: schema.characters.personality })
      .from(schema.characters)
      .where(inArray(schema.characters.id, charIds))
      .all()
    personality = chars.find(c => c.personality)?.personality || undefined
  }

  // 2. intentFunction: sceneIntention JSON.function
  let intentFunction: string | undefined
  const [sb] = db.select({ sceneIntention: schema.storyboards.sceneIntention })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
    .all()
  if (sb?.sceneIntention) {
    try {
      const parsed = JSON.parse(sb.sceneIntention)
      intentFunction = parsed?.function || undefined
    } catch {
      // parse 失败, 静默 skip
    }
  }

  return { personality, intentFunction }
}

/**
 * 段内长句切分 — 按中文标点 + 语气词边界切短句, 避免整段一次合成.
 * 默认每段 ≤20 字 (MiniMax TTS 单段推荐 ≤30 字, 20 字更自然).
 * 切点优先级: 句末标点 > 强语气词 > 逗号 (句中读).
 */
const MAX_SEGMENT_CHARS = 20
const SENTENCE_END = /[。！？!?]/
const SOFT_BREAKS = /[,，;；]/

function splitLongText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if ([...trimmed].length <= MAX_SEGMENT_CHARS) return [trimmed]

  const out: string[] = []
  let buf = ''
  for (const ch of trimmed) {
    buf += ch
    const bufLen = [...buf].length
    // 1) 遇到句末标点强制切
    if (SENTENCE_END.test(ch)) {
      out.push(buf.trim())
      buf = ''
      continue
    }
    // 2) 软断点 (逗号/分号) + 已超长 → 切
    if (SOFT_BREAKS.test(ch) && bufLen >= 10) {
      out.push(buf.trim())
      buf = ''
      continue
    }
    // 3) 超长但没有断点 → 强制切
    if (bufLen >= MAX_SEGMENT_CHARS) {
      out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(Boolean)
}

// ============ TTS 自然度优化 end ============

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
  // 重要:concat demuxer 里的相对路径会被解析为相对 list file 所在目录,
  //      不是 segment 所在目录。这里统一用绝对路径,list file 仍放 /tmp。
  const listFile = path.join(os.tmpdir(), `tts-concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  try {
    const listBody = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
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
  atmosphere?: string | null,  // 2026-09-23 问题 3: 用于推断 emotion + speed
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
  // 2026-09-25 PM msg-20260924-004: 改用 dialogue + personality + intentFunction 三字段联合推断, atmosphere 仅作兜底
  //   dialogue 优先 (caller 传入), personality + intentFunction 从 DB 查 (loadStoryboardTTSContext helper)
  const ttsContext = loadStoryboardTTSContext(storyboardId)
  const ttsParams = inferTTSParams({
    dialogue,
    personality: ttsContext.personality,
    intentFunction: ttsContext.intentFunction,
    atmosphere, // deprecated 兜底, 保留兼容
  })
  const meta: TTSSegmentMeta[] = []
  const segPaths: string[] = []

  logTaskStart('TTSConcat', 'infer-tts-params', {
    atmosphere: atmosphere || '(empty)',   // deprecated 兜底源
    dialogue: dialogue || '(empty)',       // 最高优先级
    personality: ttsContext.personality || '(empty)',  // 角色基线情绪
    intentFunction: ttsContext.intentFunction || '(empty)',  // 剧情目的模板
    emotion: ttsParams.emotion,
    speed: ttsParams.speed,
  })

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    const voice = getVoiceForSpeaker(episodeId, m.speaker, m.isNarrator)
    logTaskProgress('TTSConcat', 'generate-segment', {
      index: i, speaker: m.speaker, isNarrator: m.isNarrator, voice,
      textLen: m.text.length,
      emotion: ttsParams.emotion,
      speed: ttsParams.speed,
    })
    // 2026-09-23 问题 3: 段内长句切分 (默认 ≤20 字, 让 TTS 按气口自然合成)
    const sentences = splitLongText(m.text)
    const finalText = sentences.join(' ')  // MiniMax TTS 支持空格分隔多短句
    const segPath = await generateTTS({
      text: finalText,
      voice,
      configId: configId ?? undefined,
      emotion: ttsParams.emotion,
      speed: ttsParams.speed,
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
  // STORAGE_PATH 默认是 '.../data/static', 而 generateTTS 返回的相对路径是 'static/audio/xxx.mp3'
  // (文件存到 ${STORAGE_PATH}/audio/xxx.mp3, URL 前缀 '/static/audio/xxx.mp3')。
  // 这里直接把 segPath ('static/audio/xxx.mp3') 拼到 dataDir ('.../data/static') 前面会出现
  // '.../data/static/static/audio/xxx.mp3' (多了一层 static/)。需要先剥掉 'static/' 前缀再 join。
  const dataDir = process.env.STORAGE_PATH || path.resolve(process.cwd(), 'data/static')
  const outDir = path.join(dataDir, 'audio')
  fs.mkdirSync(outDir, { recursive: true })
  const outName = `tts_${storyboardId}_${Date.now()}.mp3`
  const outAbs = path.join(outDir, outName)

  const resolveSegPath = (p: string): string => {
    if (path.isAbsolute(p)) return p
    const stripped = p.startsWith('static/') ? p.slice('static/'.length) : p
    return path.join(dataDir, stripped)
  }

  if (segPaths.length === 1) {
    // 单段直接复制,免去 ffmpeg 调用
    fs.copyFileSync(resolveSegPath(segPaths[0]), outAbs)
  } else {
    ffmpegConcat(segPaths.map(resolveSegPath), outAbs)
  }

  const relativePath = `static/audio/${outName}`
  logTaskSuccess('TTSConcat', 'compose', {
    ...logTask,
    segmentCount: meta.length,
    outPath: relativePath,
  })

  return { audioPath: relativePath, segments: meta, ignored: false }
}

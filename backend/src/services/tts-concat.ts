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
// ★ Sprint 47 T1 (PM msg-20261115-188): 角色级语音参数 (音量/音高/语速/声音修饰)
import { parseVoiceParams, toVoiceModify, type CharacterVoiceParams } from './character-voice-params.js'
// ★ Sprint 47 T2 (PM msg-20261115-188): 情绪推断 (剧情目的优先) + 语速解耦
import { inferEmotion, inferSpeed, characterSpeedText, isPlatformEmotion, emotionStrengthToParams } from './tts-emotion.js'
import { parseDialogueSegments, type DialogueSegment } from '../utils/dialogue-parser.js'
import { getEpisodeSpeakerWhitelist } from '../utils/speaker-whitelist.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const NARRATOR_VOICE_FALLBACK = process.env.NARRATOR_VOICE  // 2026-10-12 sprint 43 FIX-5: env 可空, fallback 走 aiVoices 查表

// 2026-10-12 sprint 43 FIX-5 (QA msg-20261012-043): getVoiceForSpeaker 旁白/角色 fallback
// 之前 NARRATOR_VOICE_FALLBACK 默认 'alloy' (OpenAI 英文 voice), minimax API 收到不认识 → 0 字节 (audioMs=0)
// 修法: 旁白优先查 character '旁白'.voiceStyle; 都没配查 aiVoices provider=minimax 第一行; 再不行 throw
const NARRATOR_SPEAKER_NAME = '旁白'

/** 查 aiVoices 表 provider='minimax' 的第一行 voiceId, 给旁白/无 voiceStyle 角色兜底 */
function getFirstMinimaxVoiceId(): string | null {
  try {
    const [row] = db.select({ voiceId: schema.aiVoices.voiceId })
      .from(schema.aiVoices)
      .where(eq(schema.aiVoices.provider, 'minimax'))
      .all()
    return row?.voiceId || null
  } catch { return null }
}

/** 校验 voice id 是否在 aiVoices 白名单内 (provider='minimax' 或 'openai'). 不在则 throw */
function validateVoiceOrThrow(voiceId: string, where: string): void {
  const exists = db.select({ id: schema.aiVoices.id })
    .from(schema.aiVoices)
    .where(eq(schema.aiVoices.voiceId, voiceId))
    .all()
  if (exists.length > 0) return
  // 不在白名单, 但如果 NARRATOR_VOICE_FALLBACK env 显式配了就放过 (escape hatch)
  if (where === 'narrator-env' && process.env.NARRATOR_VOICE) return
  logTaskError('TTSConcat', 'voice-not-in-whitelist', { voiceId, where })
  throw new Error(`[tts-concat] voice id '${voiceId}' (${where}) 不在 aiVoices 白名单内, 拒绝合成避免 0 字节音频. 请在音色分配里重新选 voice, 或 seed minimax voice 到 aiVoices 表`)
}


// ============ 2026-09-23 问题 3 — TTS 自然度优化 ============

// ★ Sprint 47 T2 (PM msg-20261115-188): 情绪推断 + 语速解耦已挪到 services/tts-emotion.ts
//   新优先级: 剧情目的 → 角色性格基线 → 台词情绪词 → 视觉氛围 (旧: 台词 → 性格 → 剧情目的 → 氛围)
//   语速不再由情绪决定 (旧: sad→0.88 / fearful→1.12 / angry→1.1 硬绑定) → 角色基线 + 场景密度, 默认 1.0
//   旧函数 inferFromText / inferFromIntentFunction / inferTTSParams 已删除 (口径见新模块)

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

  // 2. intentFunction: ★ dramatic_function 优先 (V4 planner 落库的剧情目的, 单 189 加的列),
  //    scene_intention JSON.function 兜底 (老路径的 LLM 意图分析结果)。
  let intentFunction: string | undefined
  const [sb] = db.select({
    sceneIntention: schema.storyboards.sceneIntention,
    dramaticFunction: schema.storyboards.dramaticFunction,
  })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
    .all()
  if (sb?.dramaticFunction) {
    intentFunction = sb.dramaticFunction
  } else if (sb?.sceneIntention) {
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

/** 取本集所属 drama 的全部角色 (语音分配 + 角色级语音参数都用它) */
function loadDramaCharacters(episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return ep
    ? db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
    : []
}

/**
 * ★ Sprint 47 T2: 找该说话人对应的角色行 (旁白找 name='旁白' 的角色)。
 */
function findSpeakerCharacter(
  episodeId: number,
  speaker: string,
  isNarrator: boolean,
  chars?: ReturnType<typeof loadDramaCharacters>,
) {
  const list = chars ?? loadDramaCharacters(episodeId)
  return isNarrator
    ? list.find((x) => x.name === NARRATOR_SPEAKER_NAME)
    : list.find((x) => x.name === speaker)
}

/**
 * ★ Sprint 47 T1 (PM msg-20261115-188): 取该说话人的角色级语音参数。
 *   没配 → 空对象 → 主链路请求体与改动前逐字一致 (vol=1 / pitch=0 / 无 voice_modify)。
 */
function getSpeakerVoiceParams(
  episodeId: number,
  speaker: string,
  isNarrator: boolean,
  chars?: ReturnType<typeof loadDramaCharacters>,
): CharacterVoiceParams {
  return parseVoiceParams(findSpeakerCharacter(episodeId, speaker, isNarrator, chars)?.voiceParams ?? null)
}

/**
 * ★ Sprint 47 T2: 场景密度 = 同一场景在【本集】里的镜头数 (语速的第二个来源)。
 */
function getSceneShotDensity(storyboardId: number): number | null {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.sceneId) return null
  const rows = db.select().from(schema.storyboards).where(eq(schema.storyboards.sceneId, sb.sceneId)).all()
  const same = rows.filter((r) => r.episodeId === sb.episodeId && !r.deletedAt).length
  return same || null
}

function getVoiceForSpeaker(episodeId: number, speaker: string, isNarrator: boolean): string {
  const chars = loadDramaCharacters(episodeId)
  if (isNarrator) {
    // 2026-10-12 sprint 43 FIX-5: 旁白路径优先查 character '旁白' 的 voiceStyle (voice-assigner 配的)
    const narratorChar = chars.find((c) => c.name === NARRATOR_SPEAKER_NAME)
    if (narratorChar?.voiceStyle) {
      validateVoiceOrThrow(narratorChar.voiceStyle, 'narrator-character')
      return narratorChar.voiceStyle
    }
    if (NARRATOR_VOICE_FALLBACK) {
      validateVoiceOrThrow(NARRATOR_VOICE_FALLBACK, 'narrator-env')
      return NARRATOR_VOICE_FALLBACK
    }
    // 兜底: aiVoices provider=minimax 第一行
    const firstMinimax = getFirstMinimaxVoiceId()
    if (firstMinimax) {
      logTaskWarn('TTSConcat', 'narrator-fallback-first-minimax', { voiceId: firstMinimax })
      return firstMinimax
    }
    throw new Error(`[tts-concat] 旁白没配 voice: drama 内没有 name='${NARRATOR_SPEAKER_NAME}' 的 character (且 NARRATOR_VOICE env 未设, aiVoices 表也没 minimax 行). 请在音色分配里给旁白配 voice, 或 seed minimax voice 到 aiVoices 表`)
  }
  const found = chars.find((c) => c.name === speaker)
  if (found?.voiceStyle) {
    validateVoiceOrThrow(found.voiceStyle, 'character-voiceStyle')
    return found.voiceStyle
  }
  // 角色没配 voiceStyle: 兜底用 aiVoices provider=minimax 第一行, 不再硬写 'alloy'
  const firstMinimax = getFirstMinimaxVoiceId()
  if (firstMinimax) {
    logTaskWarn('TTSConcat', 'character-voice-fallback-first-minimax', { speaker, voiceId: firstMinimax })
    return firstMinimax
  }
  throw new Error(`[tts-concat] 角色 '${speaker}' 没配 voiceStyle 且 aiVoices 表没 minimax 行, 拒绝合成避免 0 字节音频. 请在音色分配里给该角色配 voice, 或 seed minimax voice 到 aiVoices 表`)
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
  // Sprint 18 (QA msg-20261021-078): 传剧本角色白名单 ——
  //   LLM 输出的多角色台词经常没分隔符 ('？\"王秀兰：'), 老的 lookbehind 要求角色名前是空白,
  //   认不出第二个角色 → 整行归给第一个角色 → 两句话用同一个音色念出来 (静默错误)。
  //   白名单从 episodes.script_content 解析 (跟 autoFillSpeakerFromScript 同源), 历史脏数据也能拆对。
  const speakerWhitelist = getEpisodeSpeakerWhitelist(episodeId)
  const parsed = parseDialogueSegments(dialogue, speakerWhitelist)
  if (parsed.ignorable) {
    return { audioPath: '', segments: [], ignored: true, reason: parsed.reason }
  }
  // 兜底告警: 只解析出 1 段, 但文本里还有白名单里的角色名 → 说明没拆开 (静默错误的高危信号)
  if (parsed.segments.length === 1 && speakerWhitelist.size > 0) {
    const only = parsed.segments[0]
    const stillHasSpeaker = [...speakerWhitelist].some(
      (s) => s.length >= 2 && only.text.includes(s),
    )
    if (stillHasSpeaker) {
      logTaskWarn('TTSConcat', 'dialogue-split-fallback', {
        storyboardId,
        episodeId,
        rawSegments: parsed.segments.length,
        usedWhitelist: true,
        speaker: only.speaker,
        hint: '台词里有多个角色但只解析出 1 段 —— 多角色台词没拆开, 后面几句会用第一个角色的音色念 (检查白名单是否覆盖了剧本里的角色名)',
      })
    }
  }

  const logTask = { storyboardId, episodeId, rawSegments: parsed.segments.length }
  logTaskStart('TTSConcat', 'compose', logTask)

  // 合并相邻同 speaker
  const merged = coalesceAdjacent(parsed.segments)
  const configId = getEpisodeConfigId(episodeId)
  // 2026-09-25 PM msg-20260924-004: 改用 dialogue + personality + intentFunction 三字段联合推断, atmosphere 仅作兜底
  //   dialogue 优先 (caller 传入), personality + intentFunction 从 DB 查 (loadStoryboardTTSContext helper)
  const ttsContext = loadStoryboardTTSContext(storyboardId)
  // ★ Sprint 47 T2: 情绪按【每个说话人】单独推断 (原来整镜只算一次, 且台词优先)
  //   新优先级: 剧情目的 → 该角色性格 → 该段台词 → 氛围
  //   语速与情绪解耦: 角色基线(性格/年龄) + 场景密度; 角色级显式配置优先
  const sceneDensity = getSceneShotDensity(storyboardId)
  const meta: TTSSegmentMeta[] = []
  const segPaths: string[] = []

  logTaskStart('TTSConcat', 'infer-tts-params', {
    atmosphere: atmosphere || '(empty)',   // deprecated 兜底源 (最低优先级)
    intentFunction: ttsContext.intentFunction || '(empty)',  // ★ 最高优先级: 剧情目的
    personality: ttsContext.personality || '(empty)',  // 角色性格基线
    sceneDensity: sceneDensity ?? '(unknown)',
    note: 'emotion/speed 逐段推断 (T2: 剧情目的优先 + 语速与情绪解耦)',
  })

  // ★ Sprint 47 T1 (PM msg-20261115-188): 角色列表只查一次 (音色 + 角色级语音参数都用它)
  const dramaCharacters = loadDramaCharacters(episodeId)

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    const voice = getVoiceForSpeaker(episodeId, m.speaker, m.isNarrator)
    // ★ Sprint 47 T1: 角色级语音参数 (vol/pitch/语速/声音修饰) —— 没配就是空对象 = 保持现状
    const speakerParams = getSpeakerVoiceParams(episodeId, m.speaker, m.isNarrator, dramaCharacters)
    const speakerChar = findSpeakerCharacter(episodeId, m.speaker, m.isNarrator, dramaCharacters)
    // ★ Sprint 47 T2: 每段的情绪 = 剧情目的 → 该角色性格 → 该段台词 → 氛围
    const rawEmotion = inferEmotion({
      intentFunction: ttsContext.intentFunction,
      personality: speakerChar?.personality ?? ttsContext.personality,
      dialogue: m.text,
      atmosphere,
    })
    // ★ Sprint 47 T3: 平台不认的取值在【入口】挡住 (不能发出去才报错) → 降级 neutral + 告警
    const segEmotion = isPlatformEmotion(rawEmotion) ? rawEmotion : 'neutral'
    if (!isPlatformEmotion(rawEmotion)) {
      logTaskWarn('TTSConcat', 'emotion-unsupported-fallback', {
        storyboardId, episodeId, speaker: m.speaker, emotion: rawEmotion, fallback: 'neutral',
      })
    }
    // ★ Sprint 47 T3: 情绪强度 (平台无强度参数 → 用刚劲/轻柔 + 音量近似; 角色显式配置优先)
    const strengthParams = emotionStrengthToParams(speakerParams.emotionIntensity, speakerParams)
    const baseModify = toVoiceModify(speakerParams)
    const segVoiceModify = baseModify
      ? { ...baseModify, ...(strengthParams.intensity != null ? { intensity: strengthParams.intensity } : {}) }
      : (strengthParams.intensity != null ? { intensity: strengthParams.intensity } : null)
    const segVol = speakerParams.vol ?? strengthParams.vol
    // ★ Sprint 47 T2: 语速与情绪【解耦】= 角色基线 + 场景密度 (角色级显式配置优先)
    const segSpeed = speakerParams.speed ?? inferSpeed({
      traitText: characterSpeedText(speakerChar) || ttsContext.personality,
      sceneDensity,
    })
    logTaskProgress('TTSConcat', 'generate-segment', {
      index: i, speaker: m.speaker, isNarrator: m.isNarrator, voice,
      textLen: m.text.length,
      emotion: segEmotion,
      speed: segSpeed,
      vol: speakerParams.vol,
      pitch: speakerParams.pitch,
      hasVoiceModify: !!toVoiceModify(speakerParams),
    })
    // 2026-09-23 问题 3: 段内长句切分 (默认 ≤20 字, 让 TTS 按气口自然合成)
    const sentences = splitLongText(m.text)
    const finalText = sentences.join(' ')  // MiniMax TTS 支持空格分隔多短句
    const segPath = await generateTTS({
      text: finalText,
      voice,
      configId: configId ?? undefined,
      emotion: segEmotion,
      speed: segSpeed,
      // ★ Sprint 47 T1: 角色级音量/音高/声音修饰 (undefined → 保持现状)
      // ★ Sprint 47 T3: vol 可被情绪强度推导值补上 (显式配置优先)
      vol: segVol,
      pitch: speakerParams.pitch,
      voiceModify: segVoiceModify,
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

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
// ★ Sprint 47 T6 (PM msg-20261115-188): ffprobe 实测音频时长 → 回写镜长
import { probeDuration } from '../utils/ffprobe-helpers.js'
// ★ Sprint 47 T1 (PM msg-20261115-188): 角色级语音参数 (音量/音高/语速/声音修饰)
import { parseVoiceParams, toVoiceModify, type CharacterVoiceParams } from './character-voice-params.js'
// ★ Sprint 47 T6 (PM msg-20261115-188): 实测音频 → 回写镜长 (口径是纯函数, 便于离线断言)
import { computeWrittenBackDuration, TTS_DURATION_MARGIN_SEC } from '../constants/shot-type-baseline.js'
// ★ Sprint 47 T2 (PM msg-20261115-188): 情绪推断 (剧情目的优先) + 语速解耦
import { inferEmotion, inferSpeed, characterSpeedText, isPlatformEmotion, emotionStrengthToParams } from './tts-emotion.js'
import { parseDialogueSegments, type DialogueSegment } from '../utils/dialogue-parser.js'
// ★ Sprint 51 T2 (PM msg-20261117-204): 配音【音高体检】(生成后实测基频 → 异常则降参重试)
import { measurePitchHealth } from './audio-features.js'
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
  // ★ Sprint 51 T2 (PM msg-20261117-204): 音高体检结果 + 最终采用的参数
  /** 实测中位基频 (Hz); 0/未测到 = 没测出来 */
  f0Hz?: number
  /** 判定为音高异常 (刺耳/尖叫) —— 重试用尽后仍异常 */
  pitchAnomaly?: boolean
  /** 重试次数 (0 = 一次就过) */
  pitchRetries?: number
  /** 最终采用的音高 (半音) */
  pitchUsed?: number
  /** 最终采用的 voice_modify.intensity */
  intensityUsed?: number
  // ★ 单 208 A2: 降参【前】的角色配置原值 (用于判断用户有没有手动改过角色配置)
  pitchBase?: number
  intensityBase?: number
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

/**
 * ★ Sprint 51 T2 (PM msg-20261117-204): 音高体检的判定与重试参数
 *   · 绝对下限 365Hz (★ 单 208 A3: 340 → 365):
 *       340 是【只统计了祝英台】定的 → 漏看了梁母的 angry 命令句能到 340.3Hz (我方测法) / 329.9Hz (QA 测法)
 *       → 刚好越过 340 → 梁母镜#17 被误判 → 无谓降参 (用户听到"这一镜怎么比别的低")
 *       365 的依据 (11-17 全量实测, 我方测法): 梁母镜#17 = 340.3Hz (留 25Hz 余量) / 祝英台异常 3 镜 = 388.1 / 407.8 / 409.8Hz
 *       (留 23Hz 余量, 仍全部检出)
 *   · 相对基线 ×1.3: 【天生偏高】的角色不会被误判 (相对口径比绝对口径稳)
 *   · 最多 3 次: 原样 → 原样 → 降参 (与 175 单批量重试口径一致)
 */
const PITCH_ANOMALY_ABS_HZ = 365
const PITCH_ANOMALY_RATIO = 1.3
const PITCH_HEALTH_MAX_ATTEMPTS = 3

/**
 * ★ Sprint 53 (PM msg-20261117-210): 降参的【收敛规则】—— 防止越降越低
 *
 * 【问题】实测: 镜#9 祝英台的 pitchUsed 一路 +1 → -1 → -3 → -4 (比同角色其它镜低 5 个半音),
 *   用户实听「9，16 祝英台的声音都有点变了」。两个原因:
 *   ① 降参【没有下限】(每判一次异常就 -1);
 *   ② 降参结果会被【存下来当下次的起点】(单 208 A2 的复用) → 每重新生成一次就可能再低一档 → 棘轮效应。
 *
 * 【D1 下限】降参后的 pitchUsed 不得低于 (角色 pitchBase - 1) / intensity 不得低于 (intensityBase - 10)。
 *   ★ 降 1 档的听感变化很轻 (频率差 6%); 再往下用户直接听出「声音变了」→ 到了下限就收手。
 * 【D2 阈值边缘】超出阈值不足 PITCH_ANOMALY_OVERSHOOT_TOLERANCE 时不降参 (但仍标记异常)。
 *   ★ 取值依据: MiniMax 同参数同台词的基频极差可达 230Hz (工单 204 证据4) → 1~10Hz 的超出是【随机波动】
 *     不是"真刺耳"。实测镜#9 第二轮: 375.1 (超 10.1Hz) → 降; 366.2 (超 1.2Hz) → 又降 → 白降 2 个半音。
 *   ★ 这个口径是【固定的绝对 Hz】, 不随角色/情绪/基线变化 (工单要求)。
 * 【D3 收敛】到达下限后稳定复用同一个值 —— 复用时也要把【库里已经过度降参的老值】夹回下限。
 * ★ 检测口径一律不动 (阈值 365 / 相对基线 ×1.3 / 基线来源)。
 */
const PITCH_ANOMALY_OVERSHOOT_TOLERANCE = 20
const PITCH_DECREMENT_FLOOR_OFFSET = 1
const INTENSITY_DECREMENT_FLOOR_OFFSET = 10

/** 把音高/刚劲夹到降参下限 (角色基线 - 1 半音 / - 10) */
function clampToDecrementFloor(
  pitch: number | undefined,
  intensity: number | undefined,
  basePitch: number | undefined,
  baseIntensity: number | undefined,
): { pitch: number | undefined; intensity: number | undefined } {
  let p = pitch
  let i = intensity
  if (p != null && basePitch != null) p = Math.max(p, basePitch - PITCH_DECREMENT_FLOOR_OFFSET)
  if (i != null && baseIntensity != null) i = Math.max(i, baseIntensity - INTENSITY_DECREMENT_FLOOR_OFFSET)
  return { pitch: p, intensity: i }
}

export interface PitchDecrementDecision {
  /** ok=没超阈值 / stop-small-overshoot=小幅超出收手 / stop-floor=到下限收手 / decrement=降一档 */
  action: 'ok' | 'stop-small-overshoot' | 'stop-floor' | 'decrement'
  nextPitch?: number
  nextIntensity?: number | null
  /** 超出阈值多少 Hz */
  overshootHz: number
  reason: string
}

/**
 * ★ Sprint 53: 降参决策 (纯函数 → 可离线断言)
 */
export function decidePitchDecrement(input: {
  f0Hz: number
  thresholdHz: number
  usedPitch?: number
  usedIntensity?: number | null
  basePitch?: number
  baseIntensity?: number | null
}): PitchDecrementDecision {
  const overshootHz = Math.round((input.f0Hz - input.thresholdHz) * 10) / 10
  if (input.f0Hz <= input.thresholdHz) {
    return { action: 'ok', overshootHz, reason: '未超阈值' }
  }
  // ★ D2: 阈值边缘的小幅超出 → 不降参 (仍标记异常, 由上层提示用户)
  if (overshootHz < PITCH_ANOMALY_OVERSHOOT_TOLERANCE) {
    return {
      action: 'stop-small-overshoot', overshootHz,
      reason: `只超出阈值 ${overshootHz}Hz (< ${PITCH_ANOMALY_OVERSHOOT_TOLERANCE}Hz → 随机波动) → 不降参, 保留当前参数并标记异常`,
    }
  }
  // ★ D1: 降一档, 但不许越过下限
  const curPitch = input.usedPitch
  const curIntensity = input.usedIntensity ?? undefined
  const nextPitch = curPitch != null
    ? Math.max(curPitch - 1, input.basePitch != null ? input.basePitch - PITCH_DECREMENT_FLOOR_OFFSET : -Infinity)
    : undefined
  const nextIntensity = curIntensity != null
    ? Math.max(curIntensity - 10, input.baseIntensity != null ? input.baseIntensity - INTENSITY_DECREMENT_FLOOR_OFFSET : -Infinity)
    : undefined
  const pitchStuck = curPitch != null && nextPitch === curPitch
  const intensityStuck = curIntensity != null && nextIntensity === curIntensity
  if ((curPitch == null || pitchStuck) && (curIntensity == null || intensityStuck)) {
    return {
      action: 'stop-floor', overshootHz,
      reason: `已到降参下限 (pitchBase-${PITCH_DECREMENT_FLOOR_OFFSET} / intensityBase-${INTENSITY_DECREMENT_FLOOR_OFFSET}) → 不再继续降, 保留该值并提示用户`,
    }
  }
  return {
    action: 'decrement', nextPitch, nextIntensity: nextIntensity ?? null, overshootHz,
    reason: `降一档 → pitch ${nextPitch ?? '(不变)'} / intensity ${nextIntensity ?? '(不变)'}`,
  }
}

/**
 * ★ 单 208 A2: 取本镜上次生成的【最终采用参数】(降参结果) → 重新生成时直接沿用
 *   ★ 用户手动改过角色的音高/音量时以用户的新值为准 (比对落库时记下的 base 值)
 *   ★ 查不到 / 坏 JSON → 返回空 (按角色配置原值走, 行为与改动前一致)
 */
function loadPreviousAdoptedPitchParams(
  storyboardId: number,
  speaker: string,
): { pitchUsed?: number; intensityUsed?: number; pitchBase?: number; intensityBase?: number } {
  try {
    const [sb] = db.select({ segs: schema.storyboards.ttsSegments })
      .from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    if (!sb?.segs) return {}
    let arr: any[] = []
    try { arr = JSON.parse(sb.segs) } catch { return {} }
    const hit = (arr || []).find((g: any) => g?.speaker === speaker
      && (g?.pitchUsed != null || g?.intensityUsed != null))
    if (!hit) return {}
    return {
      pitchUsed: hit.pitchUsed ?? undefined,
      intensityUsed: hit.intensityUsed ?? undefined,
      pitchBase: hit.pitchBase ?? undefined,
      intensityBase: hit.intensityBase ?? undefined,
    }
  } catch {
    return {}
  }
}

/** 音频文件的绝对路径 (generateTTS 返回的是 'static/audio/xxx.mp3' 相对路径) */
function resolveAudioAbsPath(rel: string): string {
  if (path.isAbsolute(rel)) return rel
  const dataDir = process.env.STORAGE_PATH || path.resolve(process.cwd(), 'data/static')
  const stripped = rel.startsWith('static/') ? rel.slice('static/'.length) : rel
  return path.join(dataDir, stripped)
}

/**
 * ★ Sprint 51 T2: 取该角色【本集其它镜】的实测基频中位数 (相对基线口径用)
 *   数据源: storyboards.tts_segments 里每段落的 f0Hz (体检时写进去的)
 *   没有历史数据 → 返回 0 (只用绝对阈值 340Hz)
 */
function loadSpeakerPitchBaseline(episodeId: number, speaker: string, excludeStoryboardId?: number): number {
  try {
    const rows = db.select({ id: schema.storyboards.id, segs: schema.storyboards.ttsSegments })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
      .all()
    const vals: number[] = []
    for (const r of rows) {
      if (excludeStoryboardId && r.id === excludeStoryboardId) continue
      if (!r.segs) continue
      let arr: any[] = []
      try { arr = JSON.parse(r.segs) } catch { continue }
      for (const g of arr) {
        if (g?.speaker !== speaker) continue
        const f = Number(g?.f0Hz)
        if (Number.isFinite(f) && f > 0) vals.push(f)
      }
    }
    if (!vals.length) return 0
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  } catch {
    return 0
  }
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
      // ★ Sprint 50 T2 (PM msg-20261117-202): 角色立场也参与情绪判定 ——
      //   反派/威严角色的命令句不该被配成"惊讶"(工单 scope 只列了 tts-emotion.ts,
      //   这里只是把已有的角色行里的 role/description 传进去, 不改任何其它逻辑)。
      characterRole: speakerChar?.role ?? null,
      characterDescription: speakerChar?.description ?? null,
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
    // ★ Sprint 51 T2 (PM msg-20261117-204): 生成后【音高体检】+ 异常时【降参重试】
    //   · 判定: 实测基频 > max(340Hz, 该角色本集基线 × 1.3) → 音高异常 (刺耳/尖叫)
    //   · 重试: 第 1 次重试 = 原样 (有的段只是随机抽到高值), 第 2 次起 = 降参 (pitch -1 / intensity -10)
    //   · 最多 3 次; 3 次仍异常 → 保留最后一次 + flow-log warning + 用户可见提示 (不静默吞掉)
    const baselineHz = loadSpeakerPitchBaseline(episodeId, m.speaker, storyboardId)
    const anomalyThresholdHz = Math.max(
      PITCH_ANOMALY_ABS_HZ,
      baselineHz > 0 ? baselineHz * PITCH_ANOMALY_RATIO : 0,
    )
    // ★ 单 208 A2: 沿用【上次降参后】的参数 → 重新生成不用再走一遍"先生成高的、再检测、再降参"
    //   ★ 用户手动改过角色的音高/音量时以用户的新值为准 (比对落库时记下的 base 值)
    const prevAdopted = loadPreviousAdoptedPitchParams(storyboardId, m.speaker)
    let usedPitch = speakerParams.pitch
    let usedIntensity = segVoiceModify?.intensity
    const basePitch = speakerParams.pitch ?? undefined
    const baseIntensity = segVoiceModify?.intensity ?? undefined
    if (prevAdopted.pitchUsed != null
      && (prevAdopted.pitchBase == null || prevAdopted.pitchBase === basePitch)) {
      usedPitch = prevAdopted.pitchUsed
    }
    if (prevAdopted.intensityUsed != null
      && (prevAdopted.intensityBase == null || prevAdopted.intensityBase === baseIntensity)) {
      usedIntensity = prevAdopted.intensityUsed
    }
    // ★ 单 210 D1/D3: 复用的值也要夹回降参下限 ——
    //   库里可能已经存着【过度降参】的老值 (实测镜#9 = -4, 下限是 0) → 不夹的话每次重新生成都从这个老值起步。
    const clamped = clampToDecrementFloor(usedPitch, usedIntensity, basePitch, baseIntensity)
    if (clamped.pitch !== usedPitch || clamped.intensity !== usedIntensity) {
      logTaskProgress('TTSConcat', 'pitch-params-clamped-to-floor', {
        storyboardId, episodeId, speaker: m.speaker,
        before: { pitch: usedPitch, intensity: usedIntensity },
        after: clamped,
        floor: {
          pitch: basePitch != null ? basePitch - PITCH_DECREMENT_FLOOR_OFFSET : null,
          intensity: baseIntensity != null ? baseIntensity - INTENSITY_DECREMENT_FLOOR_OFFSET : null,
        },
        hint: '上次落库的降参值低于下限 → 夹回下限 (Sprint 53 D1)',
      })
      usedPitch = clamped.pitch
      usedIntensity = clamped.intensity
    }
    if (usedPitch !== basePitch || usedIntensity !== baseIntensity) {
      logTaskProgress('TTSConcat', 'pitch-params-reused', {
        storyboardId, episodeId, speaker: m.speaker,
        pitch: usedPitch, intensity: usedIntensity,
        basePitch, baseIntensity,
        hint: '沿用上次降参后的参数 (角色配置未改动 → 直接用, 不用重新降一遍)',
      })
    }
    let segPath = ''
    let health = { f0Hz: 0, frames: 0, spread: 0 }
    let attempts = 0
    let pitchAnomaly = false

    for (let attempt = 1; attempt <= PITCH_HEALTH_MAX_ATTEMPTS; attempt++) {
      attempts = attempt
      segPath = await generateTTS({
        text: finalText,
        voice,
        configId: configId ?? undefined,
        emotion: segEmotion,
        speed: segSpeed,
        // ★ Sprint 47 T1: 角色级音量/音高/声音修饰 (undefined → 保持现状)
        // ★ Sprint 47 T3: vol 可被情绪强度推导值补上 (显式配置优先)
        vol: segVol,
        pitch: usedPitch,
        voiceModify: usedIntensity != null
          ? { ...(segVoiceModify || {}), intensity: usedIntensity }
          : segVoiceModify,
      })
      health = await measurePitchHealth(resolveAudioAbsPath(segPath))
      pitchAnomaly = health.f0Hz > 0 && health.f0Hz > anomalyThresholdHz
      if (!pitchAnomaly) break
      // ★ 单 210: 降参决策 (下限 + 阈值边缘收手) —— 纯函数 decidePitchDecrement
      const decision = decidePitchDecrement({
        f0Hz: health.f0Hz,
        thresholdHz: anomalyThresholdHz,
        usedPitch, usedIntensity, basePitch, baseIntensity,
      })
      logTaskWarn('TTSConcat', 'pitch-anomaly-detected', {
        storyboardId, episodeId, speaker: m.speaker, attempt,
        f0Hz: health.f0Hz, thresholdHz: Math.round(anomalyThresholdHz), baselineHz: Math.round(baselineHz),
        overshootHz: decision.overshootHz,
        pitch: usedPitch, intensity: usedIntensity,
        action: decision.action,
        // ★ hint 准确描述【下一次会怎么做】(单 208 A1) + 为什么收手 (单 210)
        hint: decision.action === 'decrement' ? `下一次重试: ${decision.reason}` : decision.reason,
      })
      if (decision.action !== 'decrement') {
        // ★ D1/D2: 收手 (保留当前参数, 仍标记异常 → 前端会显示「音高异常」tag)
        if (decision.action === 'stop-floor') {
          logTaskWarn('TTSConcat', 'pitch-anomaly-floor-reached', {
            storyboardId, episodeId, speaker: m.speaker, attempt,
            f0Hz: health.f0Hz, thresholdHz: Math.round(anomalyThresholdHz),
            pitch: usedPitch, intensity: usedIntensity,
            hint: '已到降参下限 → 不再继续降 (避免用户听到「声音变了」); 仍标记为音高异常, 由用户决定要不要手动调',
          })
        } else {
          logTaskWarn('TTSConcat', 'pitch-anomaly-no-decrement', {
            storyboardId, episodeId, speaker: m.speaker, attempt,
            f0Hz: health.f0Hz, thresholdHz: Math.round(anomalyThresholdHz),
            overshootHz: decision.overshootHz,
            pitch: usedPitch, intensity: usedIntensity,
            hint: '只比阈值高一点点 (随机波动) → 不降参; 仍标记为音高异常',
          })
        }
        break
      }
      usedPitch = decision.nextPitch
      usedIntensity = decision.nextIntensity ?? undefined
    }
    if (pitchAnomaly) {
      // ★ 3 次仍异常 → 明确记录 (前端会据此提示用户试听/手动重试), 不静默吞掉
      logTaskWarn('TTSConcat', 'pitch-anomaly-persisted', {
        storyboardId, episodeId, speaker: m.speaker, f0Hz: health.f0Hz,
        thresholdHz: Math.round(anomalyThresholdHz), attempts,
        pitch: usedPitch, intensity: usedIntensity,
        hint: '音高异常没兜住 → 保留最后一次, 用户需要试听/手动重试',
      })
    }
    segPaths.push(segPath)
    meta.push({
      speaker: m.speaker,
      text: m.text,
      voice,
      isNarrator: m.isNarrator,
      segmentPath: segPath,
      f0Hz: health.f0Hz || undefined,
      pitchAnomaly: pitchAnomaly || undefined,
      pitchRetries: attempts > 1 ? attempts - 1 : undefined,
      pitchUsed: usedPitch,
      intensityUsed: usedIntensity,
      // ★ 单 208 A2: 落库时记下【降参前】的角色配置原值 → 下次重新生成时能判断
      //   "用户有没有手动改过角色的音高/音量" (改了就用用户的新值, 没改才沿用降参结果)
      pitchBase: basePitch,
      intensityBase: baseIntensity,
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

  // ★ Sprint 47 T6 (PM msg-20261115-188): 用【实测音频时长】回写该镜的镜长 (第二道保险)
  //   第一道是 T5 的台词 floor (按字数估); 这里用真实合成出来的音频长度 → 精确
  //   ★ 只涨不跌 + 幂等: max(当前镜长, 实测音频 + 余量) → 重跑配音不会让镜长来回跳
  //   ★ 留白 0.5s: 盖住语速微调 (T1/T2 改了语速后音频时长会变) 与视频实际时长的小偏差
  await writeBackShotDurationByAudio(storyboardId, outAbs)

  return { audioPath: relativePath, segments: meta, ignored: false }
}

/** ★ Sprint 47 T6: 配音音频实测时长 → 回写镜长的留白量 (秒) —— 口径在 constants 里 (纯函数可断言) */
export { TTS_DURATION_MARGIN_SEC }

/**
 * ★ Sprint 47 T6 (PM msg-20261115-188): 用实测音频时长回写该镜的镜长。
 *
 * 【为什么】
 *   台词 floor (T5) 是按字数【估】的 → 实际合成出来可能更长 (语速/停顿/语气词)。
 *   镜长没跟上 → 合成阶段音频被裁到画面时长 → 【台词念到一半没了】, 字幕时间轴也超出音轨。
 *   这里用 ffprobe 实测的音频长度回写镜长 → 视频生成会按更长的镜长来, 台词装得下。
 *
 * 【口径】只涨不跌 + 幂等: newDuration = max(当前镜长, ceil(实测音频 + 留白))
 */
export async function writeBackShotDurationByAudio(
  storyboardId: number,
  audioAbsPath: string,
): Promise<{ before: number; after: number; audioSec: number; written: boolean } | null> {
  try {
    if (!audioAbsPath || !fs.existsSync(audioAbsPath)) return null
    const audioSec = await probeDuration(audioAbsPath)
    if (!(audioSec > 0)) return null
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    const before = Number(sb?.duration ?? 0)
    const after = computeWrittenBackDuration(before, audioSec, TTS_DURATION_MARGIN_SEC)
    const written = after > before
    if (written) {
      db.update(schema.storyboards)
        .set({ duration: after, updatedAt: new Date().toISOString() })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
    }
    logTaskProgress('TTSConcat', 'shot-duration-written-back', {
      storyboardId,
      before,
      after,
      audioSec: Number(audioSec.toFixed(3)),
      margin: TTS_DURATION_MARGIN_SEC,
      written,
      hint: '★ 台词音频实测时长 → 镜长 (只涨不跌) → 视频按更长的镜长来, 台词不会被硬裁',
    })
    return { before, after, audioSec, written }
  } catch (err: any) {
    logTaskWarn('TTSConcat', 'shot-duration-writeback-fail', {
      storyboardId, error: err?.message || String(err),
    })
    return null
  }
}

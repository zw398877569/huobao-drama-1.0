/**
 * ★ Sprint 47 T2 (PM msg-20261115-188): 情绪推断重构 + 语速解耦 (纯函数 → 可离线断言)
 *
 * 【为什么要改 (PM 的原话对应的问题)】
 *   旧: 情绪从【台词文本】猜 (台词里出现"悲伤/愤怒/紧张"这些词才算), 而且台词排在【角色性格】前面
 *       → 角色说"你为什么要这样对我"被判成中性 (而不是愤怒) —— 台词写的是【说了什么】不是【这场戏该怎么演】
 *       → 阴郁角色整集同一种情绪 (台词里不写情绪词就永远中性) → 情绪没有起伏
 *   新 (PM 指定的优先级): 【剧情目的】→【角色性格基线】→【台词情绪词】→【视觉氛围】(兜底兼容)
 *
 * 【语速解耦】
 *   旧: 语速跟情绪硬绑定 (sad→0.88 / fearful→1.12 / angry→1.1) → 同一个角色同类情绪下语速一模一样
 *   新: 语速只由【角色基线】(性格/年龄) + 【场景密度】决定, 情绪不再影响语速
 *       默认 1.0 (不变现有没有角色基线的镜); 角色级覆盖优先 (characters.voice_params.speed)
 *
 * ★ 平台 emotion 取值以 MiniMax 官方文档 + 实测为准 (2026-11-15 实测 speech-2.8-hd):
 *   happy / sad / angry / fearful / disgusted / surprised / calm / fluent 全部支持;
 *   ★ whisper 报 2013 "speech 2.8 don't support whisper" → 入口挡住, 绝不下发;
 *   neutral (官方枚举里没有, 但实测能过) → 保留当默认值, 不改现有正常镜表现。
 */
import { collectCharacterTraitText, isSupportedEmotion } from './character-voice-params.js'

export type TTSEmotion =
  | 'happy' | 'sad' | 'angry' | 'fearful'
  | 'disgusted' | 'surprised' | 'calm' | 'fluent'
  | 'neutral'

/** 情绪关键词表 (台词兜底 + 性格基线共用) */
const KEYWORDS_SAD = /悲伤|告别|哀悼|压抑|沉重|凄凉|lonely|farewell|melancholy|grief|sorrow|泪痕|哽咽|颤抖|啜泣|哭泣|泪流|崩溃|挽留|哀求|求你/
const KEYWORDS_TENSE = /紧张|恐惧|惊|危机|追逐|冲突|战斗|tense|fearful|panic|threat|chase|conflict|搏斗|对峙|剑拔弩张|心跳|快跑|逃跑|逃|躲|害怕|恐惧感|怕|惊吓/
const KEYWORDS_ANGRY = /愤怒|狂躁|吼|怒|angry|fury|rage|吼叫|咆哮|嘶吼|怒骂|滚开/
const KEYWORDS_WARM = /温馨|平静|舒缓|亲密|温柔|peaceful|warm|gentle|intimate|tender/
const KEYWORDS_JOYFUL = /欢乐|喜悦|团聚|开心|joyful|reunion|cheerful|delight/
/**
 * ★ Sprint 47 T3: 扩枚举 —— 惊讶 / 厌恶 / 生动 (surprised / disgusted / fluent)
 *   ★ 这三个都是 MiniMax 官方枚举里有的 (2026-11-15 实测 speech-2.8-hd 能合成), 不是自造值
 *   ★ 顺序有讲究: 惊讶/厌恶比"恐惧/愤怒"更具体 → 放在 sad/tense/angry 之前判
 */
const KEYWORDS_SURPRISED = /惊讶|诧异|竟然|没想到|出乎意料|意外|震惊|惊愕|surprised|shock/
const KEYWORDS_DISGUSTED = /厌恶|嫌弃|反感|恶心|鄙夷|不屑|disgust|disgusted/
const KEYWORDS_FLUENT = /生动|轻快|俏皮|诙谐|幽默|fluent|lively/

/**
 * 剧情目的 → 情绪模板 (★ 最高优先级)。
 *
 * ★ Sprint 47 单 189 (PM msg-20261115-189): 按真实数据细化 —— ep21 的剧情目的分布是
 *   铺垫1/悬念6/揭露4/反转3/情感爆发3/高潮4; 老表把 悬念+揭露+反转 全映射成 fearful
 *   → 21 镜里 13 镜一个情绪 (等于"情绪没起伏"), 也过不了工单验收
 *   「剧情目的不同的镜 → emotion 应不同」。现在 8 个戏型映射到 6 个情绪:
 *   铺垫=neutral · 悬念=fearful · 揭露=calm(冷静揭示) · 反转=surprised(意外)
 *   · 对峙/高潮/情感爆发=angry · 余韵=sad
 *   ★ 对峙/高潮/情感爆发 同为 angry 是有意的 (三者都是情绪爆发的语义)
 */
const INTENT_EMOTION: Record<string, TTSEmotion> = {
  铺垫: 'neutral',
  悬念: 'fearful',
  揭露: 'calm',
  反转: 'surprised',
  对峙: 'angry',
  高潮: 'angry',
  情感爆发: 'angry',
  余韵: 'sad',
}

/** 关键词 → 情绪 (台词兜底 / 性格基线共用) */
export function emotionFromKeywords(text: string | null | undefined): TTSEmotion | null {
  if (!text) return null
  const lower = text.toLowerCase()
  // ★ T3: 更具体的情绪先判 (惊讶/厌恶/生动)
  if (KEYWORDS_SURPRISED.test(lower)) return 'surprised'
  if (KEYWORDS_DISGUSTED.test(lower)) return 'disgusted'
  if (KEYWORDS_FLUENT.test(lower)) return 'fluent'
  if (KEYWORDS_SAD.test(lower)) return 'sad'
  if (KEYWORDS_TENSE.test(lower)) return 'fearful'
  if (KEYWORDS_ANGRY.test(lower)) return 'angry'
  if (KEYWORDS_JOYFUL.test(lower)) return 'happy'
  if (KEYWORDS_WARM.test(lower)) return 'calm'
  return null
}

export interface EmotionContext {
  /** 剧情目的 (storyboards.scene_intention.function) —— 最高优先级 */
  intentFunction?: string | null
  /** 角色性格基线 —— 次之 */
  personality?: string | null
  /** 台词情绪词 —— 兜底 */
  dialogue?: string | null
  /** 视觉氛围 —— 最后 (deprecated, 保留兼容老调用方) */
  atmosphere?: string | null
}

/**
 * ★ 情绪推断 (新的四级优先级)。
 * @returns 情绪; 全无信号 → 'neutral'
 */
export function inferEmotion(ctx: EmotionContext): TTSEmotion {
  // 1. 剧情目的 (最高): 这场戏在整集里干什么
  const intent = ctx.intentFunction ? String(ctx.intentFunction).trim() : ''
  if (intent) {
    const mapped = INTENT_EMOTION[intent]
    if (mapped) return mapped
  }
  // 2. 角色性格基线 (次之): 性格决定演出的底色
  const byPersonality = emotionFromKeywords(ctx.personality)
  if (byPersonality) return byPersonality
  // 3. 台词情绪词 (兜底): 台词写的是"说了什么", 不是"该怎么演"
  const byDialogue = emotionFromKeywords(ctx.dialogue)
  if (byDialogue) return byDialogue
  // 4. 视觉氛围 (最后, 兼容保留)
  const byAtmosphere = emotionFromKeywords(ctx.atmosphere)
  if (byAtmosphere) return byAtmosphere
  // 5. 全无信号
  return 'neutral'
}

/** 语速上下限 (官方 speed [0.5, 2]) */
export const SPEED_RANGE = { min: 0.5, max: 2, def: 1 } as const

export interface SpeedContext {
  /** 角色基线文本 (姓名/角色/描述/性格/外貌/结构化 traits 拼起来的) */
  traitText?: string | null
  /** 场景密度 = 同一场景在本集里的镜头数 (null = 未知) */
  sceneDensity?: number | null
  /** 角色级显式覆盖 (characters.voice_params.speed) —— 优先级最高 */
  override?: number | null
}

/**
 * ★ 语速推断 (与情绪解耦)。
 *   角色基线: 活泼/少年 → +0.05; 沉稳/老年 → -0.05
 *   场景密度: 镜头多 (>=5) → +0.03; 镜头少 (<=2) → -0.03
 *   默认 1.0 (★ 不改变现有正常镜的表现)
 */
export function inferSpeed(ctx: SpeedContext): number {
  if (ctx.override != null && Number.isFinite(Number(ctx.override))) {
    return clampSpeed(Number(ctx.override))
  }
  let speed = SPEED_RANGE.def
  const text = ctx.traitText || ''
  if (text) {
    if (/活泼|开朗|热情|外向|急躁|张扬|跳脱|冒失|少年|少女|儿童|孩童/.test(text)) {
      speed += 0.05
    } else if (/沉稳|内敛|严肃|冷静|老成|不动声色|老年|老人|大爷|奶奶|年迈|老者/.test(text)) {
      speed -= 0.05
    }
  }
  const density = ctx.sceneDensity
  if (typeof density === 'number' && Number.isFinite(density)) {
    if (density >= 5) speed += 0.03
    else if (density <= 2) speed -= 0.03
  }
  return clampSpeed(speed)
}

/** 夹到官方 speed 区间 */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return SPEED_RANGE.def
  if (speed < SPEED_RANGE.min) return SPEED_RANGE.min
  if (speed > SPEED_RANGE.max) return SPEED_RANGE.max
  return Math.round(speed * 100) / 100
}

/**
 * ★ 平台是否认这个情绪 (whisper 对 speech-2.8-hd 不支持 → 入口挡住)。
 *   判据统一放在 character-voice-params.ts (SUPPORTED_EMOTIONS), 这里是薄封装。
 */
export function isPlatformEmotion(emotion: string | null | undefined): boolean {
  return isSupportedEmotion(emotion)
}

/**
 * ★ Sprint 47 T3 (PM msg-20261115-188): 情绪强度 → 平台能表达的最接近杠杆。
 *
 * 【为什么是模拟】
 *   MiniMax 官方枚举里【没有情绪强度参数】(voice_setting 只有 speed/vol/pitch/emotion;
 *   voice_modify 的 intensity 是"刚劲↔轻柔"的力度, 不是情绪强度) →
 *   所以用"刚劲/轻柔 + 音量微调"来近似表达情绪的强弱。
 *
 * @param strength 0~100 (0/未配 = 不启用 → 不改任何参数)
 * @param base     角色已有的显式参数 (显式的优先, 不被推导值覆盖)
 * @returns 需要叠加到请求上的参数 (没启用 → 空对象)
 */
export function emotionStrengthToParams(
  strength: number | null | undefined,
  base?: { vol?: number; intensity?: number } | null,
): { vol?: number; intensity?: number } {
  const s = Number(strength)
  if (!Number.isFinite(s) || s <= 0) return {}
  const k = (s - 50) / 50   // [-1, 1]
  const out: { vol?: number; intensity?: number } = {}
  // 强度高 → 更刚劲 (intensity 负) + 音量略高; 强度低 → 更轻柔 (正值) + 音量略低
  if (base?.intensity == null) out.intensity = Math.round(-k * 40)
  if (base?.vol == null) out.vol = Math.round((1 + k * 0.3) * 100) / 100
  return out
}

/** 角色特征文本 (从 characters 行拼) —— 供 inferSpeed 用 */
export function characterSpeedText(char: {
  name?: string | null
  role?: string | null
  description?: string | null
  personality?: string | null
  appearancePermanent?: string | null
  permanentTraits?: string | null
} | null | undefined): string {
  if (!char) return ''
  return collectCharacterTraitText({
    name: char.name,
    role: char.role,
    description: char.description,
    personality: char.personality,
    appearancePermanent: char.appearancePermanent,
    permanentTraits: char.permanentTraits,
  })
}

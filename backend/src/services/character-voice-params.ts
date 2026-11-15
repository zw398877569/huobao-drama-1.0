/**
 * ★ Sprint 47 T1 (PM msg-20261115-188): 角色级语音参数 (音量/音高/语速/声音修饰)
 *
 * 【为什么单独一个模块】
 *   1. 取值范围【必须以 MiniMax 官方文档为准】→ 集中在这里, 别散落在各处硬写:
 *      · 同步 TTS `/v1/t2a_v2` 的 voice_setting:
 *          speed [0.5, 2] (默认 1) / vol (0, 10] (默认 1) / pitch 整数 [-12, 12] (默认 0)
 *          emotion ∈ {happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper}
 *            ★ whisper 不支持 speech-2.8-hd (我们线上用的模型); fluent 官方说明仅 2.6 系列生效 → 两个都要实测
 *      · 顶层 voice_modify (同步/异步接口【都】支持, 刻度跟 voice_setting.pitch 完全不同!):
 *          pitch [-100, 100] (低沉↔明亮) / intensity [-100, 100] (刚劲↔轻柔)
 *          timbre [-100, 100] (浑厚↔清脆) / sound_effects 单选
 *      ★ 两套 pitch 刻度差 8 倍多 (12 vs 100) → 千万别混用 (官方文档 speech-t2a-http / speech-t2a-async-create)
 *   2. 校验/夹取/推导都是纯函数 → 可离线断言 (不用起服务、不调平台)
 *
 * 【★ 不配置 = 逐字保持现状】
 *   characters.voice_params 为空 → 不产出任何参数 → 主链路的请求体与改动前【逐字一致】
 *   (vol 仍是 1 / pitch 仍是 0 / 请求里没有 voice_modify 字段)。
 *   自动推导出来的值【落库】成显式参数后才生效 → 现有角色的音色表现不会被悄悄改掉。
 */
import path from 'path'

/** 角色级语音参数 (落库成 characters.voice_params 的 JSON) */
export interface CharacterVoiceParams {
  /** 音量 voice_setting.vol —— (0, 10], 默认 1 */
  vol?: number
  /** 音高 voice_setting.pitch —— 整数 [-12, 12], 默认 0 (半音刻度) */
  pitch?: number
  /** 语速 voice_setting.speed —— [0.5, 2], 默认 1 */
  speed?: number
  /** ★ 声音修饰的音高 voice_modify.pitch —— [-100, 100] (低沉↔明亮) */
  /**   ★ 与上面的 pitch 是【两套刻度】: pitch 是 voice_setting 的半音 [-12,12], 这里是修饰器刻度 [-100,100] */
  modifyPitch?: number
  /** 力量感 voice_modify.intensity —— [-100, 100] (负=刚劲, 正=轻柔) */
  intensity?: number
  /** 音质 voice_modify.timbre —— [-100, 100] (负=浑厚, 正=清脆) */
  timbre?: number
  /** 声音修饰音 voice_modify.sound_effects —— 单选 */
  soundEffects?: SoundEffect
  /**
   * ★ Sprint 47 T3 (PM msg-20261115-188): 情绪强度 0~100 (0 = 不启用)
   *   ★ 平台【没有】情绪强度参数 → 这里用平台能表达的最接近的杠杆模拟:
   *     强情绪 → voice_modify.intensity 更刚劲 (负值) + 音量略高; 弱情绪 → 更轻柔 (正值) + 音量略低
   *   ★ 默认不启用 (undefined) → 请求体与改动前逐字一致
   */
  emotionIntensity?: number
}

export type SoundEffect = 'spacious_echo' | 'auditorium_echo' | 'lofi_telephone' | 'robotic'

/** 官方 sound_effects 可选值 (单选) */
export const SOUND_EFFECT_OPTIONS: SoundEffect[] = ['spacious_echo', 'auditorium_echo', 'lofi_telephone', 'robotic']

/** 各参数的合法区间 (官方文档) —— 前端做输入框提示 + 后端做夹取都读这一份 */
export const VOICE_PARAM_RANGES = {
  vol: { min: 0.1, max: 10, step: 0.1, def: 1 },
  pitch: { min: -12, max: 12, step: 1, def: 0 },
  speed: { min: 0.5, max: 2, step: 0.05, def: 1 },
  intensity: { min: -100, max: 100, step: 5, def: 0 },
  timbre: { min: -100, max: 100, step: 5, def: 0 },
  modifyPitch: { min: -100, max: 100, step: 5, def: 0 },
  emotionIntensity: { min: 0, max: 100, step: 5, def: 0 },
} as const

/** 平台支持的 emotion 取值 (speech-2.8-hd: whisper 不支持, fluent 官方只说 2.6 生效 → 两者实测过再用) */
export const SUPPORTED_EMOTIONS = [
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'neutral',
] as const
export type SupportedEmotion = (typeof SUPPORTED_EMOTIONS)[number]

/** speech-2.8-hd 实测不支持的 emotion (发出去会报参数错 → 入口就要挡住) */
export const UNSUPPORTED_EMOTIONS_FOR_2_8 = ['whisper'] as const

function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 把任意输入夹到合法区间 (非法值丢掉, 不抛错)。
 * ★ pitch 必须是整数 (官方: type integer)。
 */
export function clampVoiceParams(input: any): CharacterVoiceParams {
  const out: CharacterVoiceParams = {}
  if (!input || typeof input !== 'object') return out
  if (input.vol != null) {
    const v = clampNum(input.vol, VOICE_PARAM_RANGES.vol.min, VOICE_PARAM_RANGES.vol.max)
    // ★ 保留 2 位小数 (0.85 - 0.05 这种推导会出现 0.7999999999999999 这种浮点尾巴)
    if (v != null) out.vol = Math.round(v * 100) / 100
  }
  if (input.pitch != null) {
    const v = clampNum(input.pitch, VOICE_PARAM_RANGES.pitch.min, VOICE_PARAM_RANGES.pitch.max)
    if (v != null) out.pitch = Math.round(v)
  }
  if (input.speed != null) {
    const v = clampNum(input.speed, VOICE_PARAM_RANGES.speed.min, VOICE_PARAM_RANGES.speed.max)
    if (v != null) out.speed = v
  }
  if (input.modifyPitch != null) {
    const v = clampNum(input.modifyPitch, VOICE_PARAM_RANGES.modifyPitch.min, VOICE_PARAM_RANGES.modifyPitch.max)
    if (v != null) out.modifyPitch = Math.round(v)
  }
  if (input.intensity != null) {
    const v = clampNum(input.intensity, VOICE_PARAM_RANGES.intensity.min, VOICE_PARAM_RANGES.intensity.max)
    if (v != null) out.intensity = Math.round(v)
  }
  if (input.timbre != null) {
    const v = clampNum(input.timbre, VOICE_PARAM_RANGES.timbre.min, VOICE_PARAM_RANGES.timbre.max)
    if (v != null) out.timbre = Math.round(v)
  }
  if (input.soundEffects) {
    const se = String(input.soundEffects)
    if ((SOUND_EFFECT_OPTIONS as string[]).includes(se)) out.soundEffects = se as SoundEffect
  }
  if (input.emotionIntensity != null) {
    const v = clampNum(input.emotionIntensity, 0, 100)
    // 0 = 不启用 (跟"没配"一个意思 → 请求体不出现这些字段)
    if (v != null && v > 0) out.emotionIntensity = Math.round(v)
  }
  return out
}

/** 解析 DB 里的 voice_params JSON (脏数据/老数据/手改坏 → 当空, 不抛错) */
export function parseVoiceParams(raw: string | null | undefined): CharacterVoiceParams {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return clampVoiceParams(parsed)
  } catch {
    return {}
  }
}

/** 序列化成 DB 字符串 (空对象 → null, 便于前端判断"没配置") */
export function serializeVoiceParams(params: CharacterVoiceParams | null | undefined): string | null {
  const clamped = clampVoiceParams(params)
  const keys = Object.keys(clamped)
  if (!keys.length) return null
  return JSON.stringify(clamped)
}

/**
 * 角色级参数 → 平台的 voice_modify (顶层字段)。
 * ★ 刻度是 [-100,100] 那套, 跟 voice_setting.pitch 的 [-12,12] 完全不同。
 * @returns null = 没有任何声音修饰参数 → 请求体里【不出现】voice_modify 字段 (保持现状)
 */
export function toVoiceModify(params: CharacterVoiceParams | null | undefined): {
  pitch?: number
  intensity?: number
  timbre?: number
  sound_effects?: SoundEffect
} | null {
  const p = clampVoiceParams(params)
  const out: { pitch?: number; intensity?: number; timbre?: number; sound_effects?: SoundEffect } = {}
  if (p.intensity != null) out.intensity = p.intensity
  if (p.timbre != null) out.timbre = p.timbre
  if (p.soundEffects) out.sound_effects = p.soundEffects
  // ★ voice_modify.pitch 用的是【修饰刻度】modifyPitch, 不是 voice_setting 的半音 pitch (两套刻度不能混)
  if (p.modifyPitch != null) out.pitch = p.modifyPitch
  return Object.keys(out).length ? out : null
}

/** 角色特征文本来源 (用于自动推导) */
export interface CharacterTraitSource {
  name?: string | null
  role?: string | null
  description?: string | null
  personality?: string | null
  appearancePermanent?: string | null
  /** permanent_traits: [{category:'age'|'face'|'hair'|'body'|'outfit', value}] */
  permanentTraits?: string | null
}

/**
 * 把角色各种字段拼成一段文本 (自动推导的输入)。
 * permanent_traits 是结构化 JSON (category/value) → age/body 两个维度优先取它。
 */
export function collectCharacterTraitText(src: CharacterTraitSource): string {
  const parts: string[] = []
  const push = (s?: string | null) => { if (s) parts.push(s) }

  if (src.permanentTraits) {
    try {
      const parsed = JSON.parse(src.permanentTraits)
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          const cat = String(t?.category || '')
          // age / body 是音高音量推导最需要的两个维度; face/hair/outfit 对声音没意义
          if (cat === 'age' || cat === 'body') push(String(t?.value || ''))
        }
      }
    } catch { /* 不是合法 JSON → 忽略, 走自由文本兜底 */ }
  }
  push(src.appearancePermanent)
  push(src.description)
  push(src.personality)
  push(src.role)
  return parts.join(' ')
}

/**
 * ★ 自动推导角色的默认语音参数 (纯函数 → 可离线断言)。
 *
 * 规则 (DEV 定, 满足工单要求: 少年/青年音高偏高, 老年音高偏低且音量偏小, 中年居中):
 *   · 年龄: 少年/少女 +3 / 青年 +1 / 中年 0 / 老年 -3 且音量 ×0.85
 *   · 体型: 魁梧/高大 音量 +0.2 且 intensity -20(刚劲) / 瘦小/纤细 音量 -0.05 且 intensity +10(轻柔)
 *   · 性格: 沉稳/冷酷 → intensity -15(刚劲) 且音高 -1 / 活泼/急躁 → intensity +15(轻柔) 且音高 +1 / 温柔 → intensity +10
 *
 * ★ 推导结果只是【建议值】: 调用方落库后才生效 (不配置 = 保持现状)。
 */
export function deriveCharacterVoiceParams(src: CharacterTraitSource): CharacterVoiceParams {
  const text = collectCharacterTraitText(src)
  const p: CharacterVoiceParams = {}

  // ── 年龄 ──
  if (/少年|少女|儿童|孩童|孩子|童声|少年老成|初中|高中/.test(text)) {
    p.pitch = 3
  } else if (/青年|年轻|青年人/.test(text)) {
    p.pitch = 1
  } else if (/中年|壮年/.test(text)) {
    p.pitch = 0
  } else if (/老年|老人|老妪|大爷|奶奶|年迈|老者|古稀|花甲|老爷爷|老奶奶/.test(text)) {
    p.pitch = -3
    p.vol = 0.85
  }

  // ── 体型 ──
  if (/魁梧|高大|壮硕|壮实|威猛|虎背|魁|膀大腰圆/.test(text)) {
    p.vol = (p.vol ?? 1) + 0.2
    p.intensity = -20
  } else if (/瘦小|瘦弱|纤细|娇小|瘦削|单薄|瘦/.test(text)) {
    p.vol = (p.vol ?? 1) - 0.05
    p.intensity = 10
  }

  // ── 性格 ──
  if (/沉稳|内敛|严肃|冷酷|刚毅|不苟言笑|阴郁|威严|冷峻/.test(text)) {
    p.intensity = (p.intensity ?? 0) - 15
    p.pitch = (p.pitch ?? 0) - 1
  } else if (/活泼|开朗|热情|外向|急躁|张扬|跳脱|冒失/.test(text)) {
    p.intensity = (p.intensity ?? 0) + 15
    p.pitch = (p.pitch ?? 0) + 1
  } else if (/温柔|慈祥|和蔼|体贴|亲和/.test(text)) {
    p.intensity = (p.intensity ?? 0) + 10
  }

  return clampVoiceParams(p)
}

/** 角色级参数是否为空 (空 = 不配置 = 保持现状) */
export function isVoiceParamsEmpty(p: CharacterVoiceParams | null | undefined): boolean {
  return Object.keys(clampVoiceParams(p)).length === 0
}

/** ★ 平台 emotion 合法性 (发出去之前就要挡住, 不能等平台报错) */
export function isSupportedEmotion(emotion: string | null | undefined): boolean {
  if (!emotion) return true
  const e = String(emotion).toLowerCase()
  if ((UNSUPPORTED_EMOTIONS_FOR_2_8 as readonly string[]).includes(e)) return false
  return (SUPPORTED_EMOTIONS as readonly string[]).includes(e)
}

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

/**
 * ★ Sprint 48 T4 (PM msg-20261116-194): 角色级音高/音量的【整数档表】(唯一口径)
 *
 * 【为什么改成整数档】
 *   旧推导是"年龄档 + 性别 ±0.5 再取整" → 17 岁少女算成 pitch=4 (频率 +26%), 用户实听"特别尖锐, 像变了一个人";
 *   而且性别 ±0.5 取整后【男女撞值】(17 岁女与 19 岁男都是 1) → 音高层面不再区分性别。
 *   → 现在整张表就是【整数档】, 不做小数再取整 (表本身可维护, 也省掉精度丢失)。
 *
 * 【锚点】17 岁女 = +1 (用户 2026-11-16 实机试听认可的值)
 * 【约束】同年龄档男女不许撞值 · 相邻年龄档同性别差 ≥ 1
 *
 * ★ Sprint 50 T1 (PM msg-20261117-201): 年龄档【重新标定】—— 45 岁女听起来像男声
 *
 * 【现象 (工单实测)】drama21/ep22 的梁母 (45 岁女 / 反派) 12 段配音里 4 段情绪/音高听起来像男声:
 *   她落到了 '年长/老年' 档 (45 > 44) → pitch -3 → 实测基频 F0 中位 173 Hz
 *   → 正好压在本项目男声组的实际上限 (111-170 Hz) 上 → 威严的母亲听起来像"被吓到 / 像男的"。
 *
 * 【根因 (不是模型不稳, 是档表本身错)】
 *   ① 年龄档只有 4 档, 45 岁与 60+ 落进同一档 (工单要求: 45 岁不能与老年同档);
 *   ② ★ 更关键: 【年长侧女档音高是负的】, 但项目里年长女性用的音色
 *      (阅历姐姐 Wise_Women / 慈祥奶奶 Kind-hearted_Elder) 天然基频本来就在 180-230 Hz,
 *      已经在男/女分界上 —— 再往下压 (pitch -3) 就直接掉进男声区。
 *      → 女声的音高下限必须是【不低于该音色的自然基频】, 而不是"年龄越大越低"。
 *
 * 【重新标定的依据 (实测, 不是拍脑袋)】
 *   · 梁母 (Wise_Women) 现状 pitch=-3 → 实测 F0 中位 173 Hz (工单用同一套 ffmpeg+自相关脚本测的)
 *   · 祝英台 (Mature_Woman) 现状 pitch=0  → 实测 F0 中位 258 Hz (标准女声区)
 *   · 本项目女声组 195-321 Hz · 男声组 111-170 Hz
 *   · 音高是半音量纲: F0(p) = F0(0) × 2^(p/12) → 梁母从 -3 改到 +1 = ×1.26 → 约 218 Hz
 *     (落在女声区内、明显高于男声上限、又比 18 岁女低 ~40 Hz → 两个女性角色仍能听出区别)
 *   · 祝英台 18 岁 → 少女/少女档 +1 → 约 273 Hz (与 17 岁的 +1 一致, 离"特别尖锐"的 +4 很远)
 *
 * 【新表的形状 (女性侧不再随年龄单调下降 —— 这是刻意的)】
 *   年龄感交给【音色 + 音量 + 刚劲度】, 音高只负责一件事: 别让女声掉进男声区。
 *   45-59 档给 +1 是因为这一档的角色基本都用"阅历姐姐" (天然基频最低的那个音色)。
 */
export interface VoiceTierRow {
  /** 档位名 */
  label: string
  /** 该档的最大年龄 (含); 999 = 不限 */
  maxAgeYears: number
  /** 女档音高偏移 (整数半音) */
  pitchFemale: number
  /** 男档音高偏移 (整数半音) */
  pitchMale: number
  /** 音量系数 */
  volScale: number
}

export const VOICE_TIER_TABLE: VoiceTierRow[] = [
  // ★ 少年/少女: 上限 17 → 18 (工单 201: 18 岁女也要落在 +1~2, 与 17 岁同档 → 两集祝英台一致)
  { label: '少年/少女', maxAgeYears: 18, pitchFemale: 1, pitchMale: 0, volScale: 1.00 },
  { label: '青年', maxAgeYears: 29, pitchFemale: 0, pitchMale: -1, volScale: 1.00 },
  { label: '中年', maxAgeYears: 44, pitchFemale: -1, pitchMale: -2, volScale: 0.95 },
  // ★ 中年偏上 (45-59): 【新增档】—— 45 岁以前与 60+ 分开 (工单 201 要求)
  //   女 +1: 这一档的角色基本都用"阅历姐姐"(天然基频 180-210Hz, 已在男女分界上) → 往上抬回女声区
  { label: '中年偏上', maxAgeYears: 59, pitchFemale: 1, pitchMale: -3, volScale: 0.90 },
  // ★ 年长/老年 (60+): 女 -3 → 0 (同样把基频抬回女声区; 60+ 与 45-59 音高/音量都不同)
  { label: '年长/老年', maxAgeYears: 999, pitchFemale: 0, pitchMale: -4, volScale: 0.85 },
]

/** ★ 年龄/性别都读不出来时的档位: 【不做任何猜测】(不抬不降) */
export const VOICE_TIER_UNKNOWN: VoiceTierRow = {
  label: '未知', maxAgeYears: -1, pitchFemale: 0, pitchMale: 0, volScale: 1,
}

/** 按年龄取档 (年龄未知 → 不猜, 走 UNKNOWN 档) */
export function pickVoiceTier(ageYears: number | null): VoiceTierRow {
  if (ageYears == null) return VOICE_TIER_UNKNOWN
  for (const row of VOICE_TIER_TABLE) {
    if (ageYears <= row.maxAgeYears) return row
  }
  return VOICE_TIER_TABLE[VOICE_TIER_TABLE.length - 1]
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
 * ★ Sprint 47 单 189 (PM msg-20261115-189): 推导规则按【项目里数据的真实形态】重写。
 *
 * 【现象 A/B 的根因】
 *   角色年龄在项目里是【结构化字段】permanent_traits 的 category='age' → 值形如 "17岁" / "45岁" / "30岁左右";
 *   ★ 不是自然语言 → 老规则在自由文本里找"少年/青年/中年/老年"永远找不到 → 年龄维度对所有角色都不生效。
 *   ★ 体型规则吃的是【拼接后的自由文本】→ 祝英台 face 里的"清瘦鹅蛋脸"命中了"瘦" → 被当瘦小体型
 *     → 17 岁的祝英台和 19 岁的梁山伯推出来一模一样。
 *
 * 【新口径】
 *   · 年龄: 只从结构化 age trait 解析 (数值优先, "30岁左右" 取前面的数字; 非数值才按词兜底)
 *   · 体型: ★ 只从结构化 body trait 判断 (自由文本里的脸型/外貌词不会再误触发)
 *   · 性别: 结构化 gender trait (女 +0.5 / 男 -0.5 → 同龄不同性别也能区分)
 *   · 性格: 自由文本 personality → 只影响【刚劲/轻柔】(intensity), 音高以年龄为主来源
 */
export interface ParsedCharacterTraits {
  /** 结构化 gender trait 的值 ('女' / '男' / '') */
  gender: '男' | '女' | ''
  /** 从 age trait 解析出的年龄 (null = 没解析出来) */
  ageYears: number | null
  /** age trait 的原始文本 */
  ageText: string
  /** 结构化 body trait 拼起来的文本 (★ 只有 body 类别) */
  bodyText: string
}

/** 从 permanent_traits (结构化 JSON) 里取 age / gender / body */
export function parseCharacterTraits(src: CharacterTraitSource): ParsedCharacterTraits {
  const out: ParsedCharacterTraits = { gender: '', ageYears: null, ageText: '', bodyText: '' }
  if (src.permanentTraits) {
    try {
      const parsed = JSON.parse(src.permanentTraits)
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          const cat = String(t?.category || '')
          const val = String(t?.value || '')
          if (!val) continue
          if (cat === 'age') {
            if (!out.ageText) out.ageText = val
          } else if (cat === 'gender') {
            if (!out.gender) out.gender = /女/.test(val) ? '女' : /男/.test(val) ? '男' : ''
          } else if (cat === 'body') {
            // ★ body 类别可能有多条 (身形 + 手部) → 全拼起来
            out.bodyText += ' ' + val
          }
        }
      }
    } catch { /* 不是合法 JSON → 当没有结构化特征 */ }
  }
  const m = out.ageText.match(/(\d{1,3})\s*岁/)
  if (m) out.ageYears = Number(m[1])
  return out
}

/**
 * ★ 解析年龄 (结构化优先, 老数据兜底走自由文本)。
 *   · 结构化 age trait: "17岁" / "45岁" / "30岁左右" → 取数字 (★ 这是项目里年龄的真实形态)
 *   · 老数据 (没有结构化 age) → 自由文本兜底 ("45岁" / 七旬 / 花甲 / 少年 / 中年 ...)
 *     ★ 年龄词不会出现在脸型描述里, 所以自由文本兜底是安全的 (体型不行, 见上)
 */
export function resolveCharacterAge(
  src: CharacterTraitSource,
  traits?: ParsedCharacterTraits,
): { years: number | null; text: string } {
  const t = traits ?? parseCharacterTraits(src)
  if (t.ageYears != null || t.ageText) return { years: t.ageYears, text: t.ageText }
  const free = `${src.appearancePermanent || ''} ${src.description || ''}`
  const m = free.match(/(\d{1,3})\s*岁/)
  if (m) return { years: Number(m[1]), text: m[0] }
  if (/七旬|古稀|耄耋/.test(free)) return { years: 70, text: '七旬' }
  if (/花甲|六旬/.test(free)) return { years: 60, text: '花甲' }
  if (/不惑|五旬/.test(free)) return { years: 50, text: '不惑' }
  if (/而立/.test(free)) return { years: 30, text: '而立' }
  if (/弱冠/.test(free)) return { years: 20, text: '弱冠' }
  if (/总角|童年|幼时/.test(free)) return { years: 10, text: '总角' }
  const words = [
    '少年老成', '少年', '少女', '儿童', '孩童', '童声', '初中', '高中',
    '青年', '年轻', '中年', '壮年', '老年', '老人', '大爷', '奶奶', '年迈', '老者',
  ]
  for (const w of words) {
    if (free.includes(w)) return { years: null, text: w }
  }
  return { years: null, text: '' }
}

/** 年龄分档 (DEV 定, 满足工单要求: 少年/青年音高偏高, 老年音高偏低且音量偏小, 中年居中) */
/**
 * ★ 体型关键词 (★ 只在【结构化 body trait】里匹配, 不碰自由文本)
 *   注意: "结实" / "粗壮" 不算魁梧 —— 家丁的体型是"中等身材结实, 手臂粗壮" (中等身材, 不是魁梧)
 */
const BODY_BULKY = /魁梧|高大|壮硕|壮实|威猛|虎背|膀大腰圆/
const BODY_SLIM = /瘦小|瘦弱|纤细|娇小|瘦削|单薄|清瘦/

/** 性格关键词 → 只影响刚劲/轻柔 (intensity), 不再改音高 (音高以年龄为主来源) */
const PERSONALITY_STIFF = /沉稳|威严|严肃|冷酷|刚毅|不苟言笑|阴郁|冷峻|老成/
const PERSONALITY_LIVELY = /活泼|开朗|热情|外向|急躁|张扬|跳脱|冒失/
const PERSONALITY_GENTLE = /温柔|慈祥|和蔼|体贴|亲和/

/**
 * 把角色各种字段拼成一段文本 (自动推导的输入)。
 * permanent_traits 是结构化 JSON (category/value) → age/body 两个维度优先取它。
 */
export function collectCharacterTraitText(src: CharacterTraitSource): string {
  const parts: string[] = []
  const push = (s?: string | null) => { if (s) parts.push(s) }
  const traits = parseCharacterTraits(src)
  if (traits.ageText) push(traits.ageText)
  if (traits.bodyText) push(traits.bodyText)
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
 *   · 年龄 (结构化 age): 少年/少女(<18) +3 · 青年(18-29) +1 · 中年(30-44) 0 · 年长/老年(>=45) -3 且音量 ×0.85
 *   · 性别 (结构化 gender): 女 +0.5 / 男 -0.5 (半音) → 同龄不同性别也能区分
 *   · 体型 (★ 只看结构化 body): 魁梧 → 音量 +0.2 且刚劲(intensity -20); 瘦小 → 音量 -0.05 且轻柔(intensity +10)
 *   · 性格 (personality 自由文本): 沉稳/威严 → intensity -15; 活泼/急躁 → +15; 温柔/慈祥 → +10
 *
 * ★ 推导结果只是【建议值】: 调用方落库后才生效 (不配置 = 保持现状)。
 */
export function deriveCharacterVoiceParams(src: CharacterTraitSource): CharacterVoiceParams {
  const traits = parseCharacterTraits(src)
  const resolvedAge = resolveCharacterAge(src, traits)
  // ★ Sprint 48 T4: 音高/音量走【整数档表】(不再"档位 + 性别 ±0.5 再取整")
  const tier = pickVoiceTier(resolvedAge.years)
  const p: CharacterVoiceParams = {}

  // 音高: 整数档 (性别读不出来 → 不猜, 不抬不降)
  const pitch = traits.gender === '女' ? tier.pitchFemale
    : traits.gender === '男' ? tier.pitchMale
      : 0
  if (pitch !== 0) p.pitch = pitch

  // 音量: 年龄 (年长偏小)
  if (tier.volScale !== 1) p.vol = tier.volScale

  // 体型: ★ 只看结构化 body trait
  if (BODY_BULKY.test(traits.bodyText)) {
    p.vol = (p.vol ?? 1) + 0.2
    p.intensity = -20
  } else if (BODY_SLIM.test(traits.bodyText)) {
    p.vol = (p.vol ?? 1) - 0.05
    p.intensity = 10
  }

  // 性格: 只影响刚劲/轻柔
  const personality = src.personality || ''
  if (PERSONALITY_STIFF.test(personality)) p.intensity = (p.intensity ?? 0) - 15
  else if (PERSONALITY_LIVELY.test(personality)) p.intensity = (p.intensity ?? 0) + 15
  else if (PERSONALITY_GENTLE.test(personality)) p.intensity = (p.intensity ?? 0) + 10

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

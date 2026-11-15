/**
 * ★ Sprint 47 T4 (PM msg-20261115-188): 音色库清单 + 动态示例 (消除音色示例锚定)
 *
 * 【为什么不能写死示例】
 *   音色分配 agent 的 prompt 里原来举的例子用的是【别的平台的 6 个音色】
 *   (echo / onyx / fable / nova / shimmer / alloy) —— 而项目实际可用的是 28 个 MiniMax 中式角色音色
 *   (沉稳高管 / 傲娇御姐 / 憨憨萌兽 / 花甲奶奶 ...)。
 *   → LLM 被示例锚定, 挑出来的音色在库里根本不存在
 *   → prompt 里也没教它怎么理解"傲娇御姐""嘴硬竹马"这类中式角色描述
 *   → 音色库会变 (改名/下线/新增) → 写死的示例迟早过期
 *
 * 【做法】
 *   示例在【运行时】从 ai_voices 表生成 (跟着库走), 而不是写进 prompt 文本;
 *   同时把 prompt 里遗留的别平台音色名清掉 (它们在当前 provider 下【不存在】, 留着只会带偏 LLM)。
 *
 * ★ 另外补一个盲点说明: LLM 拿到的是 base64 音频, 它【感知不到音高/语速/停顿】——
 *   只能靠试听工具返回的【实测数值特征】判断 (见 T10)。
 */
export interface VoiceLibraryEntry {
  /** voice_id (发给平台的 id) */
  id: string
  /** 中文名 (沉稳高管 / 傲娇御姐 ...) */
  name: string
  gender: '男声' | '女声' | '中性'
  /** 特征摘要 */
  traits: string
  /** 完整描述 */
  description: string
  language: string
  provider: string
}

/** 别的平台的音色名 (在当前 provider 下不存在 → prompt 里出现就是错) */
const FOREIGN_VOICE_NAMES = ['echo', 'onyx', 'fable', 'nova', 'shimmer', 'alloy']

/** ★ prompt 里的占位符 (运行时用真实音色清单替换) */
export const VOICE_GUIDE_PLACEHOLDER = '{{VOICE_GUIDE}}'

/**
 * 从名字+描述猜性别。
 * ★ Sprint 47 T4: 修老实现的 bug —— 老正则写成了【字符类】`/[男|青年|大爷|...]/`
 *   → "青年女性"里的"青"就命中 → 傲娇御姐 / 甜美女声 / 专业女主持 全被判成【男声】
 *   → agent 的维1 硬约束(性别必须一致)直接被带偏。
 *   → 现在: 女声标记先判, 再男声, 最后中性。
 */
export function inferVoiceGender(name: string, desc: unknown): '男声' | '女声' | '中性' {
  const description = Array.isArray(desc) ? desc.join(' ') : String(desc || '')
  const text = `${name} ${description}`
  if (/女|少女|姑娘|阿姨|大婶|婶|奶奶|学姐|闺蜜|姐|妹|御姐|女孩|女人|主持女/.test(text)) return '女声'
  if (/男|大爷|小哥|弟弟|哥哥|先生|爷|小子|男人|男生|哥/.test(text)) return '男声'
  if (/主持|中性|通用|旁白|播音/.test(text)) return '中性'
  return '中性'
}

/** ai_voices 表的一行 (只取需要的字段) */
export interface VoiceRow {
  voiceId: string
  voiceName: string
  description: string | null
  language: string | null
  provider: string
}

/**
 * ★ 把 ai_voices 的行转成清单条目 (纯函数 → 可离线断言, 不碰 DB)。
 *   DB 读取在 services/voice-library-db.ts (那边才有 DB 依赖)。
 */
export function parseVoiceRows(rows: VoiceRow[], provider: string): VoiceLibraryEntry[] {
  return rows.map((v) => {
    let desc: string[] = []
    try {
      const parsed = v.description ? JSON.parse(v.description) : []
      if (Array.isArray(parsed)) desc = parsed.map((x) => String(x))
    } catch { /* 不是 JSON → 当空 */ }
    const full = desc.join(' ')
    return {
      id: v.voiceId,
      name: v.voiceName || v.voiceId,
      gender: inferVoiceGender(v.voiceName, desc),
      traits: desc.slice(0, 2).join('、') || `${v.language || '多语言'}音色`,
      description: full,
      language: v.language || '',
      provider,
    }
  })
}

/**
 * 按"角色原型"从清单里挑音色 (关键词匹配 → 挑第一个命中的)。
 * ★ 挑不到就跳过 (不硬塞) —— 清单变了也不怕 (不会举出一个库里没有的音色)。
 */
type ArchetypeKey =
  | 'steady_male' | 'lively_male' | 'cold_male' | 'neutral_male'
  | 'gentle_female' | 'lively_female' | 'elder_male' | 'elder_female'

const ARCHETYPE_MATCHERS: Record<ArchetypeKey, RegExp> = {
  steady_male: /沉稳|厚重|醇厚|高管|可靠|大叔/,
  lively_male: /活泼|阳光|少年|弟弟|不羁|年轻|率真|冲劲|清澈/,
  cold_male: /威严|沙哑|压迫|冷峻|冷酷|深沉/,
  neutral_male: /中性|通用|旁白|播音|主持|温润/,
  gentle_female: /温柔|甜美|知性|御姐|闺蜜|姐|软软|善良|体贴|阅历/,
  lively_female: /少女|活泼|青春|可爱/,
  elder_male: /大爷|老年男性|老爷爷|搞笑/,
  elder_female: /奶奶|老年女性|慈祥|花甲/,
}

/** 每个原型大概是什么性别 (关键词挑不到时按性别兜底) */
const ARCHETYPE_GENDER: Record<ArchetypeKey, '男声' | '女声' | '中性'> = {
  steady_male: '男声',
  lively_male: '男声',
  cold_male: '男声',
  neutral_male: '男声',
  gentle_female: '女声',
  lively_female: '女声',
  elder_male: '男声',
  elder_female: '女声',
}

export function pickByArchetype(
  voices: VoiceLibraryEntry[],
  key: ArchetypeKey,
  used: Set<string> = new Set(),
): VoiceLibraryEntry | null {
  const re = ARCHETYPE_MATCHERS[key]
  for (const v of voices) {
    if (used.has(v.id)) continue
    if (re.test(`${v.name} ${v.description}`)) return v
  }
  // 兜底: 关键词没命中就按性别随便挑一个没被占用的
  //   (不然几个原型会抢同一个音色 → 后面的示例整段消失)
  const g = ARCHETYPE_GENDER[key]
  for (const v of voices) {
    if (used.has(v.id)) continue
    if (v.gender === g) return v
  }
  return null
}

/**
 * ★ 生成 prompt 里的【动态音色章节】(真实清单 + 真实组合示例 + 盲点说明)。
 */
export function buildVoiceGuide(voices: VoiceLibraryEntry[]): string {
  const lines: string[] = []
  lines.push('')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('三·补、★ 当前可用音色清单 (选音色的【唯一】有效来源)')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('')
  if (!voices.length) {
    lines.push('  ★ 当前 provider 的音色库是空的 → 不要选任何音色, 提示用户去设置里同步音色库后重试。')
    lines.push('  ★ 绝对不要凭记忆挑名字 (别的平台的音色名在当前库里一律不存在)。')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('  ★ 只能从下面这份清单里选; 清单外的 voice_id 一律【不存在】(别的平台的音色名在当前库里也【不存在】)。')
  lines.push('  ★ 挑的时候看中文名 + 特征描述 (例如"傲娇御姐""憨憨萌兽""花甲奶奶"都是库里真实存在的音色)。')
  lines.push('  ★ 上文示例里出现的 〈音色〉 占位符 = 用下面清单里的真实音色替换。')
  lines.push('')
  for (const v of voices) {
    lines.push(`  · ${v.name} (${v.id}) — ${v.gender} · ${v.traits || v.description}`)
  }

  // 组合示例: 用清单里真实挑出来的音色
  const used = new Set<string>()
  const pick = (k: ArchetypeKey) => {
    const v = pickByArchetype(voices, k, used)
    if (v) used.add(v.id)
    return v
  }
  const steady = pick('steady_male')
  const lively = pick('lively_male')
  const cold = pick('cold_male')
  const neutral = pick('neutral_male')
  const gentleF = pick('gentle_female')
  const livelyF = pick('lively_female')

  lines.push('')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('四·补、典型场景的音色组合示例 (全部用上面清单里的真实音色)')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('')
  if (steady && lively) {
    lines.push('  双男主戏 (一厚一薄, 一听能分):')
    lines.push(`    - 男主 A(沉稳内敛) → ${steady.name} (${steady.traits})`)
    lines.push(`    - 男主 B(活泼冲动) → ${lively.name} (${lively.traits})`)
  }
  if (cold && steady) {
    lines.push('  反派 + 主角 (一冷一暖, 反派要有距离感):')
    lines.push(`    - 反派 → ${cold.name} (${cold.traits})`)
    lines.push(`    - 主角 → ${steady.name} (常规, 不被反派音色抢戏)`)
  }
  if (steady && lively && neutral && gentleF && livelyF) {
    lines.push('  群像 (>5 角色, 五个角色五个音色, 互相不能撞):')
    lines.push(`    - 男角 1 → ${steady.name} (中年厚实)`)
    lines.push(`    - 男角 2 → ${lively.name} (年轻活力)`)
    lines.push(`    - 男角 3 → ${neutral.name} (中性, 避免和男角 1/2 撞)`)
    lines.push(`    - 女角 1 → ${gentleF.name} (温柔)`)
    lines.push(`    - 女角 2 → ${livelyF.name} (活泼)`)
  }
  if (steady && neutral) {
    lines.push('  主角 + 挚友 (容易踩坑: "亲近但可辨", 不是"听起来像两个人"):')
    lines.push(`    - 主角 → ${steady.name} (沉稳)`)
    lines.push(`    - 挚友 → ${neutral.name} (与主角不同质地的中性音色)`)
  }
  lines.push('  ★ 组合示例只是【示意】; 具体挑哪几个, 按角色特征 + 清单里的描述来判。')

  lines.push('')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('★ 声音特征你【听不出来】(重要盲点, 别装懂)')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('  - 试听工具给你的是 base64 音频, 你【感知不到音高/语速/停顿】→ 不要假装"听"出了这些。')
  lines.push('  - 要判断音高/语速, 只能靠 preview_voice_tts 返回的【实测数值特征】(语速 / 音高 / 停顿次数)。')
  lines.push('  - 拿不到数值特征时, 只能靠音色描述文字 + 角色特征推断 → reason 里要写清依据。')
  lines.push('  - 你的 reason 字段里出现的音色名必须【逐字等于】清单里的中文名或 voice_id。')
  lines.push('')
  return lines.join('\n')
}

/**
 * ★ 音色是否在库里 (assign_voice 的白名单校验, 抽成纯函数 → 可离线断言)。
 */
export function isVoiceInLibrary(voiceId: string, voices: VoiceLibraryEntry[]): boolean {
  return voices.some((v) => v.id === voiceId)
}

/**
 * ★ 不在库里就抛错 (反向验证: 故意塞一个不存在的音色名 → 这里直接拦住, 不会写进 characters.voice_style)。
 */
export function assertVoiceInLibrary(voiceId: string, voices: VoiceLibraryEntry[]): void {
  if (isVoiceInLibrary(voiceId, voices)) return
  const sample = voices.slice(0, 8).map((v) => v.name).join(' / ')
  throw new Error(
    `音色 ${voiceId} 不在当前 provider 的音色库里 → 拒绝分配 (库里可选: ${sample}${voices.length > 8 ? ' ...' : ''})`,
  )
}

/**
 * ★ 清掉 prompt 里遗留的【别平台音色名】。
 *   它们在当前 provider 下不存在, 留着只会把 LLM 带偏 (还会被写进 characters.voice_style)。
 */
export function sanitizeForeignVoiceNames(prompt: string): string {
  let out = prompt
  for (const name of FOREIGN_VOICE_NAMES) {
    const re = new RegExp(`\\b${name}\\b`, 'gi')
    out = out.replace(re, '〈音色〉')
  }
  return out
}

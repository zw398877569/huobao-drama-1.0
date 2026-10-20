/**
 * Sprint 17 Task E (PM msg-20261021-076) —— video_prompt 代码层清洗。
 *
 * 老路径 agents/index.ts:646-649 的三条硬性约束, V4 重构后没有任何代码兜底:
 *   ✗ 禁止用 cinematic / dramatic / beautiful / epic / masterpiece / stunning / breathtaking
 *     等抽象形容词, 用具体光线/色调/构图/动作描写代替
 *   ✗ 禁止 video_prompt 出现"切黑/转场/下一镜"等后期拼接指令 (转场由拼接阶段负责)
 *   ✗ 禁止 image_prompt / video_prompt 包含 IP / 真名 / 品牌 / 真人
 *
 * 做法: 在【最终 prompt 组装完成、发给模型之前】扫一遍。
 *   - 抽象形容词 → 直接删 (PM 倾向, 它们对 H3 没有信息量)
 *   - 后期拼接指令 → 直接删 + warn
 *   - IP / 品牌 → 【只 warn 不删】(词表永远不全, 乱删会误伤正常内容)
 *
 * ⚠️ 台词保护: 开口:'...' 里是【要念出来的台词原文】, 里面出现 "切黑"/"dramatic" 是台词内容,
 *   不是拼接指令 —— 清洗时必须跳过, 否则会改坏用户写的台词。
 */

const ABSTRACT_WORDS_EN = [
  'cinematic', 'dramatic', 'beautiful', 'epic', 'masterpiece', 'stunning', 'breathtaking',
]

/** 中文抽象形容词 —— 只收【几乎不可能是正常描述】的, 避免误伤 */
const ABSTRACT_WORDS_CN = ['电影感', '史诗感', '绝美', '惊艳', '震撼人心']

/** 后期拼接指令 (老路径明令禁止) */
const TRANSITION_WORDS_CN = ['切黑', '转场', '下一镜', '上一镜', '镜头转场']
//   ⚠️ 本单自己注入的连续性块标签是「承接前一镜」(不是「上一镜」) —— 词表带"上一镜"才不会误伤自己注入的内容
const TRANSITION_WORDS_EN = [
  'fade to black', 'fade out to black', 'cut to black',
  'next shot', 'next scene', 'transition to the next',
]

/**
 * IP / 品牌 / 真人 词表 —— 只做 warn, 不删。
 * 只收【专有名词形态】的, 避免"苹果/小米"这种普通词误报。
 */
const IP_BRAND_PATTERNS: RegExp[] = [
  /迪士尼|Disney/i, /漫威|Marvel/i, /哈利波特|Harry\s*Potter/i, /指环王|Lord of the Rings/i,
  /宝可梦|Pok[eé]mon/i, /皮卡丘|Pikachu/i, /变形金刚|Optimus\s*Prime/i, /狮子王|Lion King/i,
  /蜘蛛侠|Spider-?Man/i, /钢铁侠|Iron Man/i, /复仇者联盟|Avengers/i, /奥特曼|Ultraman/i,
  /iPhone|iPad|MacBook/i, /三星手机|Samsung/i, /华为手机|Huawei/i, /小米手机|Xiaomi/i,
  /特斯拉|Tesla/i, /星巴克|Starbucks/i, /可口可乐|Coca-?Cola/i, /肯德基|KFC/i,
  /麦当劳|McDonald'?s/i, /茅台|Moutai/i, /耐克|Nike/i, /阿迪达斯|Adidas/i, /乐高|LEGO/i,
]

export interface PromptCleanupResult {
  text: string
  /** 删掉的抽象形容词 */
  removedAbstract: string[]
  /** 删掉的后期拼接指令 */
  removedTransition: string[]
  /** 命中的 IP / 品牌 (只报不删) */
  ipHits: string[]
}

/**
 * 把 prompt 切成「台词保护区」和「普通区」, 只清洗普通区。
 *
 * 保护区 = 开口:'...' 的内容 (含单引号变体 ')。台词是用户写的内容, 一个字都不能动。
 */
function splitProtectedSegments(prompt: string): Array<{ text: string; protectedSeg: boolean }> {
  const re = /开口:'[^']*'|开口:"[^"]*"|开口:“[^”]*”/g
  const segments: Array<{ text: string; protectedSeg: boolean }> = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) {
    if (m.index > cursor) segments.push({ text: prompt.slice(cursor, m.index), protectedSeg: false })
    segments.push({ text: m[0], protectedSeg: true })
    cursor = m.index + m[0].length
  }
  if (cursor < prompt.length) segments.push({ text: prompt.slice(cursor), protectedSeg: false })
  return segments
}

function removeWord(text: string, word: string, removed: string[]): string {
  // 英文词: 连同后面紧跟的逗号/空格一起去掉, 避免留下 "a , portrait" 这种脏标点
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[,，]?\\s*`, 'gi')
  if (!re.test(text)) return text
  removed.push(word)
  return text.replace(re, '')
}

function removeChinesePhrase(text: string, phrase: string, removed: string[]): string {
  // 中文抽象词常带 "的", 一起删干净 ("电影感的画面" → "画面")
  const re = new RegExp(`${phrase}的?`, 'g')
  if (!re.test(text)) return text
  removed.push(phrase)
  return text.replace(re, '')
}

/**
 * 清洗 video_prompt。
 *
 * @param prompt 已经组装 + 翻译完成的最终 prompt
 */
export function cleanupVideoPrompt(prompt: string): PromptCleanupResult {
  const src = String(prompt || '')
  if (!src) return { text: src, removedAbstract: [], removedTransition: [], ipHits: [] }

  const removedAbstract: string[] = []
  const removedTransition: string[] = []
  const ipHits: string[] = []

  const segments = splitProtectedSegments(src)
  const cleaned = segments.map((seg) => {
    if (seg.protectedSeg) return seg.text
    let t = seg.text
    for (const w of ABSTRACT_WORDS_EN) t = removeWord(t, w, removedAbstract)
    for (const w of ABSTRACT_WORDS_CN) t = removeChinesePhrase(t, w, removedAbstract)
    for (const w of TRANSITION_WORDS_EN) t = removeWord(t, w, removedTransition)
    for (const w of TRANSITION_WORDS_CN) t = removeChinesePhrase(t, w, removedTransition)
    return t
  }).join('')

  for (const re of IP_BRAND_PATTERNS) {
    const m = re.exec(src)
    if (m) ipHits.push(m[0])
  }

  // 删完可能留下多余空行 / 悬空逗号, 收拾一下 (别把 H3 三段式结构弄坏)
  let text = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]*[,，、][ \t]*/gm, '')
    .replace(/[ \t]*\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim()

  // 三段式 header 之间的空行被上面的空白收敛误伤 → 补回来
  text = text.replace(/(\n(?:Overall[\s_-]+soundscape|Non[\s_-]+diegetic[\s_-]+music)[\s_-]*:)/gi, '\n$1')

  return { text, removedAbstract, removedTransition, ipHits }
}

/**
 * 第一镜全景校验 —— 老路径「场景切换的开头第一镜必须是全景(交代地点)」。
 *
 * ⚠️ 先只 warn 不强制改 (PM Task E 明确要求): 强制改会跟 LLM 的整体设计冲突。
 *
 * @param isFirstInScene  本镜是不是所属场景的第一镜
 * @param shotType       本镜景别
 */
export function checkSceneOpensWithWideShot(
  isFirstInScene: boolean,
  shotType: string | null | undefined,
): { shouldWarn: boolean; shotType: string } {
  const st = (shotType || '').trim()
  if (!isFirstInScene) return { shouldWarn: false, shotType: st }
  // 景别枚举: 全景 / 远景 / WS / wide / establishing
  const isWide = /全景|远景|大全景|^ws$|wide|establishing/i.test(st)
  return { shouldWarn: !isWide, shotType: st }
}

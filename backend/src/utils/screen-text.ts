/**
 * ★ Sprint 31 追加 (PM msg-20261102-137): 画面内文字 (屏幕 / 牌面上的字) 的保护机制。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 * 分镜 image_prompt 里用引号包起来的内容, 是【画面里要显示的文字】
 *   (例: 订单备注清晰显示:"501，王阿姨。到了按门铃就行，别敲门，她耳朵不好。")。
 * 生图链路有两道 LLM 工序会把它翻成英文:
 *   ① PromptSanitizer 的 rule F ('F. Output IN ENGLISH, comma-separated short phrases...')
 *   ② PromptTranslation 的 system prompt ('Do NOT preserve any Chinese in the output; ...')
 * → 手机屏上的中文变成英文 → 剧情关键线索读不出来 / 道具图上写的是模型编的内容。
 *
 * ── 机制 ────────────────────────────────────────────────────────────────
 * 用 <screen_text>…</screen_text> 包住【画面文字】, 让两道工序都绕开它:
 *   · 翻译前: 换成 ASCII 占位符 [[SCREENTEXT0]] (翻译器不会改 ASCII 标记)
 *   · 翻译后: 还原成 <screen_text>中文</screen_text>
 *   · 发给图片 API 前: 去掉标签, 只留中文原文 (模型看到的是干净的文字)
 *   (与项目已有的 maskDialogueBlocks 同一套路, 见 utils/dialogue-mask.ts)
 *
 * ★ 只有【真的要在画面上显示的字】才用这个机制:
 *   · 分镜首尾帧: prompt 里【引号包的内容】(工单要求整段保护)
 *   · 道具图: 只保护【判定为道具表面文字】的引号内容 (见 extractPropScreenText)
 *     —— 人名 / 台词引用那类引号内容【不能】保护, 否则会被印到道具表面上。
 *   · 角色图 / 场景图: 完全不碰 (零回归)。
 */

const OPEN_TAG = '<screen_text>'
const CLOSE_TAG = '</screen_text>'
const BLOCK_RE = /<screen_text>([\s\S]*?)<\/screen_text>/gi
const PLACEHOLDER_RE = /\[\[\s*SCREENTEXT\s*(\d+)\s*\]\]/gi

/**
 * prompt 里有没有【画面文字】标记 —— 两种形态都算:
 *   · <screen_text>…</screen_text>  (库里存的形态)
 *   · [[SCREENTEXT0]]                (过 LLM 改写/翻译时的占位符形态)
 * ⚠️ 两道 LLM 工序收到的都是占位符形态 —— 只认标签会让"原样保留"规则漏加。
 */
export function hasScreenText(prompt: string): boolean {
  const p = String(prompt || '')
  return p.includes(OPEN_TAG) || /\[\[\s*SCREENTEXT\s*\d+\s*\]\]/i.test(p)
}

/** 一段画面文字 → <screen_text>…</screen_text> */
export function wrapScreenText(text: string): string {
  const t = String(text || '').trim()
  if (!t) return ''
  return `${OPEN_TAG}${t}${CLOSE_TAG}`
}

/**
 * <screen_text>块 → ASCII 占位符 (翻译 / 改写前用)。
 * 返回 items[i] = 第 i 个块的中文原文 (还原时用)。
 */
export function maskScreenText(prompt: string): { text: string; items: string[] } {
  const items: string[] = []
  const out = String(prompt || '').replace(BLOCK_RE, (_m, inner) => {
    items.push(String(inner || ''))
    return `[[SCREENTEXT${items.length - 1}]]`
  })
  return { text: out, items }
}

/**
 * 占位符 → <screen_text>中文</screen_text> (翻译后还原)。
 * 还原不回来的块按顺序兜底补到末尾 (最坏情况 = 那段画面文字没保住, 不影响其它)。
 */
export function restoreScreenText(prompt: string, items: string[]): string {
  let out = String(prompt || '')
  const used = new Set<number>()
  out = out.replace(PLACEHOLDER_RE, (m, n) => {
    const i = Number(n)
    const item = items[i]
    if (item === undefined) return m
    used.add(i)
    return `${OPEN_TAG}${item}${CLOSE_TAG}`
  })
  if (items.length) {
    const missing = items.filter((_, i) => !used.has(i))
    if (missing.length) {
      out = `${out}\n${missing.map(t => `${OPEN_TAG}${t}${CLOSE_TAG}`).join('\n')}`
    }
  }
  return out
}

/** 去掉 <screen_text> 标签, 只留中文原文 (发给图片 API 前) */
export function stripScreenTextTags(prompt: string): string {
  return String(prompt || '').replace(BLOCK_RE, '$1')
}

// ─── 引号内容 ────────────────────────────────────────────────────────────

/** 成对的引号 (中文优先, 最后是英文直引号) */
const QUOTE_PATTERNS: RegExp[] = [
  /“([^”]{1,400})”/g,
  /「([^「」]{1,400})」/g,
  /『([^『』]{1,400})』/g,
  /"([^"]{1,400})"/g,
]

/** 引号内容里是否含中日韩文字 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
}

/**
 * ★ 台词信号: 引号内容是【人物说的话】(画面上并没有这些字)。
 *   要求动词后【紧跟中文标点】才算 —— 否则 '知道/味道/道路' 这类词会误伤。
 */
//   ⚠️ 不能用单字 '道' —— '楼道。' '知道：' '味道。' 会误伤 (实测 id=804 '乱楼道。。手机订单备注完整清晰：'
//      被 '道。' 误判成台词 → 订单备注没被保护)。改用具体的词组。
const SPEECH_SIGNAL_RE = /(说|问|答|喊|叫|回应|自我介绍|说道|问道|答道|确认道|低声道)[：:，,。！？]/
/** 引号内容里含中文或数字 → 可能是画面上的字 (门牌号 '501' 这种纯数字也算) */
const SCREEN_CANDIDATE_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|\d/
/**
 * ★ 叙述信号: 引号内容是【叙述者的说明】(例如 '林达' 实为 '小满' 身份线)。
 */
const NARRATIVE_SIGNAL_RE = /实为|揭示|意味着|暗示|身份线|听到/

/**
 * 这段引号内容是不是【画面里要显示的文字】。
 *
 * @param before 引号前面的上下文 (取引号前 ~16 个字)
 * @param inner  引号里的内容
 *
 * 判定:
 *   · 前文是台词信号 ('…说：' / '…问：') → 不是画面文字 (那是台词, 印到画面上就脏了)
 *   · 前文是叙述信号 ('…实为…' / '…揭示…') → 不是画面文字
 *   · 其余 → 是画面文字 (订单备注 / 门牌号 这类)
 */
export function isOnScreenText(before: string, inner: string): boolean {
  const b = String(before || '')
  if (SPEECH_SIGNAL_RE.test(b)) return false
  if (NARRATIVE_SIGNAL_RE.test(b)) return false
  return true
}

/**
 * 把 prompt 里【引号包住的画面文字】包成 <screen_text>…</screen_text>。
 *
 * 只处理含中文的引号内容 (英文引号内容本来就是英文, 保护没意义, 少动少错)。
 * 台词 / 叙述类引号内容【不包】—— 它们不是画面上的字, 保护了会被印到画面里。
 * 已经是 <screen_text> 的不重复包。
 */
export function wrapQuotedAsScreenText(prompt: string): string {
  let out = String(prompt || '')
  for (const re of QUOTE_PATTERNS) {
    out = out.replace(re, (m, inner, offset: number) => {
      const text = String(inner || '').trim()
      // ★ 含中文【或数字】都要看 —— 门牌号 '501' 是纯数字, 也是画面上的字
      if (!text || !SCREEN_CANDIDATE_RE.test(text)) return m
      if (text.includes(OPEN_TAG)) return m
      const before = out.slice(Math.max(0, offset - 16), offset)
      if (!isOnScreenText(before, text)) return m
      return `${OPEN_TAG}${text}${CLOSE_TAG}`
    })
  }
  return out
}

// ─── 道具 description 里的 A / B 类判定 ────────────────────────────────────

/**
 * 【道具表面文字】的强信号词 —— 引号内容前面的描述里出现这些词, 才说明这段字
 * 是【印在道具表面/屏幕上的】, 而不是台词引用或人名。
 *
 * 覆盖当前全库带引号的道具 (A 类 7 个 / B 类 6 个, 见 handoff 的分类表)。
 */
const SURFACE_TEXT_SIGNALS = [
  '写着', '写有', '写下', '上写', '显示', '标着', '标有', '印着', '印有',
  '刻着', '刻有', '贴着', '张贴', '显示着',
]

/**
 * 从道具 description 里提取【属于道具表面文字】的引号内容 (A 类)。
 *
 * 判定规则 (两条任一命中):
 *   ① 引号内容里【含数字】 → 门牌号 / 订单号 / 价格 这类画面文字 (501)
 *   ② 引号内容【前面 12 个字】里有"写着/显示/标着/印着/写下"这类表面文字信号词
 *
 * 排除 (B 类):
 *   · 人名 ('小满')          → 无数字、无信号词 → 排除 ✓
 *   · 台词引用 ('你从小就不爱吃饭') → 同上 → 排除 ✓
 *   · 氛围/结构描述 ('雨夜') → 同上 → 排除 ✓
 *
 * ⚠️ 误判成本不对称: 漏判 = 该印的字没印 (剧情线索丢); 误判 = 不该印的字印上去
 *   (画面脏)。所以只认上面两条高置信信号, 拿不准一律【不保护】。
 */
export function extractPropScreenText(description: string): string[] {
  const text = String(description || '')
  if (!text) return []
  const out: string[] = []
  for (const re of QUOTE_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const inner = String(m[1] || '').trim()
      if (!inner) continue
      const before = text.slice(Math.max(0, m.index - 16), m.index)
      // 先排除台词 / 叙述 (那类引号内容不是印在道具上的字)
      if (!isOnScreenText(before, inner)) continue
      const isSurface = /\d/.test(inner) || SURFACE_TEXT_SIGNALS.some(sig => before.includes(sig))
      if (!isSurface) continue
      if (out.includes(inner)) continue
      out.push(inner)
    }
  }
  return out
}

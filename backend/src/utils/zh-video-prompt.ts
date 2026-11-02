/**
 * Sprint 29 Task B (PM msg-20261028-129) —— 中文版视频提示词的翻译辅助。
 *
 * 背景: 用户要能在『生成提示』面板里用中文微调视频提示词 (PM 的用户需求:
 *   『加一个区域展示没翻译之前的中文内容, 这样我可以对提示词进行微调』)。
 * 数据方向 (PM 决策 D3): 中文版 = 【源】, 英文版 = 翻译产物。
 *
 * ★ 为什么需要保护台词:
 *   翻译器的 system prompt 只保护两种形式的对白 (开口:'…' / <d>…</d>) —— 用户手写的自由中文
 *   里的「林达：送单的。」不在其中 → 会被翻成英文 → 成片里角色说英文, 而配音是中文 TTS
 *   → 口型对不上 (跟现有视频生成链路的"台词保持原语言"要求冲突)。
 *   → 翻译前把台词行包成 <d>[Chinese]…</d> (翻译器明确保护 <d> 块), 翻译后还原。
 *
 * ★ 判定「这是台词」靠【角色名白名单】而不是字符特征:
 *   「林达：送单的。」和「镜头：缓慢推进」在字符层面完全一样 (都是短前缀 + 冒号),
 *   纯规则会误把标签行也包起来 → 那些词不翻译 → 英文版夹杂中文标签。
 *   角色名可以从 storyboard 的 character_ids → characters.name 查到 (准)。
 */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { maskDialogueBlocks } from './dialogue-mask.js'
import { translateVideoPromptToEnglish, type VideoTranslateContract } from '../services/ai.js'

/** 行内「短前缀：正文」 */
const DIALOGUE_LINE_RE = /^(\s*)([^：:\n]{1,12}?)\s*[：:]\s*(\S.*)$/

/** 该分镜的角色名 (用来判断哪一行是「角色名：台词」) */
export function getStoryboardSpeakerNames(storyboardId: number): string[] {
  try {
    const links = db.select({ characterId: schema.storyboardCharacters.characterId })
      .from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    const ids = links.map(l => l.characterId).filter(Boolean) as number[]
    if (!ids.length) return []
    const chars = db.select({ id: schema.characters.id, name: schema.characters.name })
      .from(schema.characters).where(inArray(schema.characters.id, ids)).all()
    return chars.map(c => String(c.name || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 把自由中文文本里的【台词行】(角色名：台词) 整行包成 <d>[Chinese]…</d>。
 * 只包【说话人在角色白名单里】的行 —— 避免把「镜头：缓慢推进」这种标签也包了。
 */
export function wrapBareDialogue(text: string, speakerNames: string[]): string {
  const names = new Set((speakerNames || []).map(n => String(n || '').trim()).filter(Boolean))
  if (!names.size) return String(text || '')
  return String(text || '').split('\n').map(line => {
    const m = DIALOGUE_LINE_RE.exec(line)
    if (!m) return line
    const [, indent, speaker, body] = m
    if (!names.has(speaker.trim())) return line
    return `${indent}${speaker}：<d>[Chinese]${body}</d>`
  }).join('\n')
}

/**
 * 中文 → 英文 (台词保持中文原样)。
 *
 * @param text         中文版视频提示词
 * @param contract     该剧集 prompt 模板的翻译契约 (H3 是官方四段, general 是三段式) —— 不传就用默认
 * @param speakerNames 该分镜的角色名 (判断哪些行是台词)
 */
export async function translateZhVideoPrompt(
  text: string,
  contract?: VideoTranslateContract,
  speakerNames: string[] = [],
): Promise<string> {
  const wrapped = wrapBareDialogue(text, speakerNames)
  const mask = maskDialogueBlocks(wrapped)
  const translated = await translateVideoPromptToEnglish(mask.text, { contract })
  const restored = mask.restore(translated)
  // 用户的自由文本不是 H3 格式 → 去掉 <d>[Chinese] 标记, 还原成「角色名：台词」
  return restored.replace(/<d>\[Chinese\]([\s\S]*?)<\/d>/gi, '$1').trim()
}

// ─── Sprint 29 follow-up Task B (PM msg-20261102-133): H3 四段结构保真翻译 ──────────

/** H3 官方四段 (兜底用, 正常从模板的 videoTranslate 契约里拿) */
const H3_DEFAULT_HEADERS = ['subject_definitions:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']

/**
 * ★★ 工单设计与两条 ★ 验收项互斥, 这里按【验收项】实现 (并在 handoff 里写明偏差):
 *
 *   工单原设计: 把【现有英文的 subject_definitions 段】+【用户的中文三段】拼成完整四段一起送翻译。
 *   ★ 验收项:   「保存后 video_prompt 的 subject_definitions 段与改动前【逐字一致】」。
 *
 *   这两条不能同时成立 —— 走一遍 LLM 翻译, subject_definitions 必然被改写措辞
 *   (实测 LLM 会把 "<Subject 1> is a man in his 30s" 改成 "<Subject 1> is a male in his 30s"),
 *   而工单自己的 fact3 也说了: FL2V 模式的 subject_definitions 必须写 the opening frame /
 *   the closing frame —— 再让 LLM 翻一遍, 这些措辞会被翻掉 → 模型分不清哪张是首帧 → 人物身份漂移。
 *
 *   → 实际实现: 【只把中文三段送翻译】, 英文的 subject_definitions 段【原样拼回】。
 *     · 结果仍是完整四段 (段标题齐全) → injectH3 照样定位得到 (不会 h3-section-not-found)
 *     · subject_definitions 逐字一致 ✓ (根本没进 LLM)
 *     · 输入 token 更少 (这单的目标之一就是省 token)
 */

/**
 * 按段标题把文本拆成 { prefix, 各段正文 }。
 * 段标题必须【整行独占】(如 "detailed_description:"), 正文是标题行之后、下一个标题行之前的全部内容。
 */
export function splitPromptSections(
  text: string,
  headers: string[],
): { prefix: string; sections: Record<string, string> } {
  const norm = (s: string) => s.trim().toLowerCase()
  const headerMap = new Map<string, string>()
  for (const h of headers) headerMap.set(norm(h), h)
  const buf: Record<string, string[]> = {}
  for (const h of headers) buf[h] = []
  const prefix: string[] = []
  let current: string | null = null
  for (const line of String(text || '').split('\n')) {
    const hit = headerMap.get(norm(line))
    if (hit) {
      current = hit
      continue
    }
    if (current) buf[current]!.push(line)
    else prefix.push(line)
  }
  const sections: Record<string, string> = {}
  for (const h of headers) sections[h] = (buf[h] || []).join('\n').trim()
  return { prefix: prefix.join('\n').trim(), sections }
}

/**
 * H3 模板: 中文三段 → 英文三段, 并把【原样的英文 subject_definitions 段】拼回去 → 完整四段。
 *
 * @param zhText        用户保存的中文版 (Sprint 29 follow-up Task A 产出的三段格式, 或用户手写的自由文本)
 * @param contract      该剧集模板的翻译契约 (H3 = 官方四段)
 * @param speakerNames  该分镜的角色名 (判断哪些行是台词)
 * @param currentEnglish 当前库里的英文 video_prompt (subject_definitions 段从这里取原文)
 */
export async function translateH3ZhVideoPrompt(
  zhText: string,
  contract: VideoTranslateContract | undefined,
  speakerNames: string[] = [],
  currentEnglish = '',
): Promise<string> {
  const headers = contract?.sectionHeaders?.length ? contract.sectionHeaders : H3_DEFAULT_HEADERS
  const subjectHeader = headers.find(h => /subject_definitions/i.test(h)) || 'subject_definitions:'
  const zhHeaders = headers.filter(h => h !== subjectHeader)

  const enSections = splitPromptSections(currentEnglish, headers)
  const originalSubject = enSections.sections[subjectHeader] || ''

  const zhSections = splitPromptSections(zhText, headers)
  // 用户写的是带段标题的三段 (Task A 产出的格式) 还是自由文本?
  const withHeaders = zhHeaders.filter(h => zhSections.sections[h])
  const usedHeaders = withHeaders.length ? withHeaders : [zhHeaders[0]]
  const bodies: Record<string, string> = {}
  for (const h of usedHeaders) {
    bodies[h] = zhSections.sections[h] || (usedHeaders.length === 1 && h === zhHeaders[0] ? zhText.trim() : '')
  }
  // 自由文本 → 整段当作 detailed_description (画面+运动), 另外两段保留原英文
  const translateInput = usedHeaders
    .filter(h => bodies[h])
    .map(h => `${h}\n${bodies[h]}`)
    .join('\n\n')
  if (!translateInput.trim()) throw new Error('中文内容为空, 没有可翻译的段落')

  // 翻译契约: 只保留【实际送进去的段】—— 别让翻译器去补一个没给的 subject_definitions
  const h3Contract: VideoTranslateContract = {
    sectionHeaders: usedHeaders,
    preserveTags: contract?.preserveTags ?? ['<Subject N>', '<Picture N>'],
    alignSpeakingSchedule: false,
  }

  const wrapped = wrapBareDialogue(translateInput, speakerNames)
  const mask = maskDialogueBlocks(wrapped)
  const translatedRaw = await translateVideoPromptToEnglish(mask.text, { contract: h3Contract })
  const restored = mask.restore(translatedRaw).replace(/<d>\[Chinese\]([\s\S]*?)<\/d>/gi, '$1').trim()

  const outSections = splitPromptSections(restored, headers)
  const translatedOk = usedHeaders.filter(h => outSections.sections[h])
  // 翻译器把段标题弄丢了 (例如加了 '### ' 前缀) → 宁可失败也别把结构写坏
  //   (调用方会把英文保持原值不动 + 提示用户, 中文照样保存)
  if (!translatedOk.length) {
    throw new Error('翻译结果里找不到 H3 段标题, 已放弃写回英文 (中文已保存)')
  }

  const parts: string[] = []
  if (originalSubject) parts.push(`${subjectHeader}\n${originalSubject}`)
  for (const h of headers) {
    if (h === subjectHeader) continue
    // 用户没给中文的那段 → 保留原英文 (别把段删掉, H3 要求四段齐全)
    const body = outSections.sections[h] || enSections.sections[h] || ''
    if (body) parts.push(`${h}\n${body}`)
  }
  if (!parts.length) throw new Error('翻译结果为空, 已放弃写回英文 (中文已保存)')
  return parts.join('\n\n')
}

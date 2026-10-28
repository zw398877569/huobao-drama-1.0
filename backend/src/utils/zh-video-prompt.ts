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

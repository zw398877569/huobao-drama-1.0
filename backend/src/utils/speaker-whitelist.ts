/**
 * Sprint 18 (QA msg-20261021-078) —— 台词角色白名单。
 *
 * 背景: 现实 LLM 输出的多角色台词经常【没有分隔符】:
 *   王秀兰：“吃吧，凉了。”林达：“我……我不饿。”
 * 老 parser 的 splitMultiSpeakerLine 要求角色名前必须是空白/行首 (lookbehind),
 * 第二个角色前面紧挨着引号 → 认不出来 → 整行归给第一个角色 →
 * 配音用第一个角色的音色把两句一起读出来, 时间轴/口型同步也跟着错
 * (Sprint 14 传 ref_audio + Sprint 15 对白时间轴都因此打折)。
 *
 * 单纯放宽 lookbehind 有误拆风险 —— 台词内部的 "好吗：是的" 会被当成角色名。
 * 所以用【剧本原文解析出的真实说话人名单】约束候选: 白名单里的名字才算角色分界。
 *
 * 白名单来源: episodes.script_content (剧本原文, 跟 autoFillSpeakerFromScript 同一个来源)。
 *   PM 拍板 D2: 不用 characters 表 —— characters 可能被改名/合并, script_content 才是剧本原文。
 *   实测 drama 14 ep14 的剧本解析出 3 个候选: 王秀兰 / 林达 / **特写
 *   —— 后者来自 "**特写**：手机屏幕" 这类分镜描述, 属于噪声;
 *   但候选正则不含 "*", 匹配不到它, 不会造成误拆。
 */

/** 抽掉状态括号, 只比较纯文本 */
export function stripParenNoise(s: string): string {
  return s.replace(/[（(].+?[)）]/g, '').trim()
}

export interface ScriptSpeakerLine {
  speaker: string
  text: string
}

/**
 * 从剧本原文解析出 [{ speaker, text }] 索引。
 *
 * ⚠️ 这是 autoFillSpeakerFromScript 原来内联的那段逻辑 (dialogue-parser.ts 的 scriptLines),
 *   抽出来给两边共用 —— 行为不变, 只是不再有两份。
 */
export function extractSpeakersFromScript(scriptContent: string | null | undefined): ScriptSpeakerLine[] {
  if (!scriptContent) return []
  return scriptContent
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = l.match(/^([^:：]{1,40}?)\s*[：:]\s*(.+)$/)
      if (!m) return null
      return { speaker: stripParenNoise(m[1]), text: stripParenNoise(m[2]) }
    })
    .filter((x): x is ScriptSpeakerLine => !!x && !!x.speaker)
}

/**
 * 真实说话人白名单。
 *
 * @param scriptContent episodes.script_content (或 episodes.content)
 * @returns 说话人名字集合 (已去重 + 去空白 + 去状态括号)
 */
export function resolveSpeakerWhitelist(scriptContent: string | null | undefined): Set<string> {
  const set = new Set<string>()
  for (const line of extractSpeakersFromScript(scriptContent)) {
    if (line.speaker) set.add(line.speaker)
  }
  return set
}

// ─── 按 episode 取白名单 (DB) ────────────────────────────────────────────────

import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/**
 * episodeId → 白名单 缓存。
 * 批量生成配音时同一个 episode 的每个镜头都要查一次剧本 —— 缓存一下, 别把 DB 查爆。
 * 剧本被改写后 script 字符串会变, 缓存自然失效 (比较的是 script 原文, 不是 id)。
 */
const whitelistCache = new Map<number, { script: string; speakers: Set<string> }>()
const WHITELIST_CACHE_MAX = 64

/**
 * 取某个 episode 的真实说话人白名单 (从 episodes.script_content 解析)。
 *
 * 拿不到剧本 / episodeId 为空 → 返回空集合 (调用方要按"没有白名单"处理, 别硬拆)。
 */
export function getEpisodeSpeakerWhitelist(episodeId: number | null | undefined): Set<string> {
  if (!episodeId) return new Set()
  const [ep] = db.select({
    scriptContent: schema.episodes.scriptContent,
    content: schema.episodes.content,
  })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .all()
  const script = ep?.scriptContent || ep?.content || ''
  const cached = whitelistCache.get(episodeId)
  if (cached && cached.script === script) return cached.speakers
  const speakers = resolveSpeakerWhitelist(script)
  if (whitelistCache.size >= WHITELIST_CACHE_MAX) {
    const oldest = whitelistCache.keys().next().value
    if (oldest !== undefined) whitelistCache.delete(oldest)
  }
  whitelistCache.set(episodeId, { script, speakers })
  return speakers
}

/**
 * 角色相关纯函数 (auto-imported via Nuxt 3 utils/)
 *
 * 之前 useEpisodePipeline.ts:272 和 useImageGeneration.ts:262 都有同款
 * "旁白"判定, 抽到这里避免后续再加新旁白词时漏改一处
 */

/** 判定一个角色是"旁白"角色 — 通过 name / role 字段匹配关键词 */
const NARRATOR_KEYWORDS = ['旁白', 'narrator', '画外音']

export function isNarratorCharacter(char: any): boolean {
  if (!char) return false
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  // text 已经是 lowercase, keywords 也是小写, 直接 includes
  return NARRATOR_KEYWORDS.some(kw => text.includes(kw))
}

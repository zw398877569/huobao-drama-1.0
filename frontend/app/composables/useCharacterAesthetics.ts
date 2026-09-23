/**
 * 角色美学枚举 — 与后端 src/constants/character-aesthetics.ts 对齐
 *
 * 2026-09-23 PM msg-20260923-002 fix #2: drama.character_aesthetic 独立维度,
 * 让 drama.style (剧集整体美术风格) 与角色美学分离.
 */

export type CharacterAesthetic = 'east-asian' | 'western' | 'neutral'

export interface CharacterAestheticOption {
  slug: CharacterAesthetic
  label: string
  hint?: string
}

export const CHARACTER_AESTHETICS: CharacterAestheticOption[] = [
  {
    slug: 'east-asian',
    label: '东亚脸',
    hint: '国内短剧 / 都市言情 / 东亚审美',
  },
  {
    slug: 'western',
    label: '欧美脸',
    hint: '欧美剧 / 西部片 / 异域题材',
  },
  {
    slug: 'neutral',
    label: '中性',
    hint: '不强制美学, 让模型自由发挥',
  },
]

export const CHARACTER_AESTHETIC_LABEL: Record<string, string> = Object.fromEntries(
  CHARACTER_AESTHETICS.map(a => [a.slug, a.label])
)

export const CHARACTER_AESTHETIC_HINT: Record<string, string | undefined> = Object.fromEntries(
  CHARACTER_AESTHETICS.map(a => [a.slug, a.hint])
)

export const CHARACTER_AESTHETIC_OPTIONS = CHARACTER_AESTHETICS.map(a => ({
  label: a.hint ? `${a.label} — ${a.hint}` : a.label,
  value: a.slug,
}))

/**
 * slug → label (用于 chip 显示), 不识别 slug 返 raw 值.
 */
export function characterAestheticLabel(slug?: string | null): string {
  if (!slug) return ''
  return CHARACTER_AESTHETIC_LABEL[slug] || slug
}

/**
 * 角色美学维度 — 与 drama.style (剧集整体美术风格) 独立
 *
 * 设计动机 (2026-09-23 PM msg-20260923-002 fix #2):
 *   drama.style      控制"画风/镜头语言" (写实/动漫/电影感/水墨)
 *   characterAesthetic 控制"角色美学" (东亚脸/欧美脸/中性)
 *   之前 commit 93e3e81 把东亚锚硬绑进 realistic preset 是 dirty hack,
 *   现在独立维度让两者解耦, 用户能选"写实+东亚脸"或"写实+欧美脸"等组合
 *
 * 注入位置:
 *   - src/routes/characters.ts 角色立绘模板 (imagePrompt)
 *   - src/agents/tools/storyboard-tools.ts 分镜 imagePrompt + videoPrompt charRoles
 *   注入方式: 在 stylePreset.positiveCharacterTokens 之后拼接此 token
 *
 * 兼容性:
 *   - character_aesthetic nullable, 默认 NULL → fallback 'neutral'
 *   - neutral = 空 token, 不注入任何额外提示, 模型自由发挥 → 等价于 93e3e81 之前的现状
 */

export type CharacterAesthetic = 'east-asian' | 'western' | 'neutral'

export interface CharacterAestheticOption {
  slug: CharacterAesthetic
  label: string
  /** 正向提示词 token, 注入 imagePrompt (不注入时为空串) */
  tokens: string
  hint?: string
}

export const CHARACTER_AESTHETICS: CharacterAestheticOption[] = [
  {
    slug: 'east-asian',
    label: '东亚脸',
    hint: '国内短剧/都市言情/东亚审美',
    tokens: 'East Asian facial features, soft jawline, smooth skin texture, almond-shaped eyes, black or dark brown hair',
  },
  {
    slug: 'western',
    label: '欧美脸',
    hint: '欧美剧/西部片/异域题材',
    tokens: 'Western European facial features, defined jawline, light skin tone, varied eye colors, varied hair colors',
  },
  {
    slug: 'neutral',
    label: '中性',
    hint: '不强制美学, 让模型自由发挥',
    tokens: '',
  },
]

/** slug → option 索引, 用于前端 dropdown */
export const CHARACTER_AESTHETIC_MAP: Record<CharacterAesthetic, CharacterAestheticOption> =
  Object.fromEntries(CHARACTER_AESTHETICS.map(a => [a.slug, a])) as any

/**
 * 根据 drama.characterAesthetic 拿到对应正向 token.
 * null / undefined / 未识别 slug 都 fallback 'neutral' (空 token).
 */
export function getCharacterAestheticTokens(aesthetic?: string | null): string {
  if (!aesthetic) return ''
  const opt = CHARACTER_AESTHETIC_MAP[aesthetic as CharacterAesthetic]
  return opt?.tokens ?? ''
}

/**
 * 返回 slug (用于后端存盘前规范化).
 * 不合法值 fallback 'neutral'.
 */
export function normalizeCharacterAesthetic(aesthetic?: string | null): CharacterAesthetic {
  if (aesthetic && aesthetic in CHARACTER_AESTHETIC_MAP) {
    return aesthetic as CharacterAesthetic
  }
  return 'neutral'
}

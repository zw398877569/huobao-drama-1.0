/**
 * 反向提示词预设库
 *
 * 用途：storyboard 自动生成时，根据所属 drama 的 style 字段匹配最佳预设，
 *       自动填到 storyboard.negative_prompt 字段。前端 UI 也提供 chip 按钮让用户一键套用。
 *
 * 触发逻辑：关键词匹配（包含关系，case-insensitive）
 * fallback：通用预设（适用于任何场景）
 */

export interface NegativePromptPreset {
  /** 预设 ID（前端 chip 按钮的 key） */
  id: string
  /** 中文标签（前端 chip 显示） */
  label: string
  /** 触发关键词数组（任一命中即匹配） */
  keywords: string[]
  /** 反向提示词内容 */
  prompt: string
}

/**
 * 风格预设 — 统一管理正向提示词 token
 *
 * slug / label 对应前端 6 个选项。
 * positiveCharacterTokens 替换角色图 "anime-style illustration"。
 * positiveShotTokens 替换分镜图 "电影级画面，写实风格"。
 * keywords 用于 style 字符串匹配（含 bug 修复：cinematic 加入自己的关键词）。
 *
 * ⚠️ token 选取约束：不能含 SLOP_RULES 里的词（cinematic / dramatic lighting /
 *    beautiful / high quality 等）—— 故事板 prompt 在入库前会过
 *    applyQualityChecklist(image),会把这些词剥成空串。character prompt 目前
 *    不过 quality checklist,但为了未来加 whitelist 也不被剥,统一遵循此约束。
 *
 * 注意: negative prompt 仍由 getPresetByStyle(NEGATIVE_PROMPT_PRESETS) 算,
 * 不通过本表查 —— 本表只管 positive side,避免与 negative preset 维护两份 keywords。
 */
export interface StylePreset {
  slug: string
  label: string
  /** 前端 dropdown 的副标题 — 适合哪些类型的剧 (e.g. "都市写实 / 职场情感 / 家庭伦理") */
  hint?: string
  positiveCharacterTokens: string
  positiveShotTokens: string
  keywords: string[]
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    slug: 'realistic',
    label: '写实',
    hint: '都市写实 / 职场情感 / 家庭伦理',
    positiveCharacterTokens: 'photorealistic character portrait, natural skin texture, candid photography, realistic proportions',
    positiveShotTokens: 'photorealistic cinematography, natural lighting, realistic film still',
    keywords: ['realistic', '写实', '真人', 'photorealistic'],
  },
  {
    slug: 'cinematic',
    label: '电影感',
    hint: '电影感 / 悬疑 / 犯罪 / 谍战',
    // 不用 'cinematic' / 'dramatic lighting' —— 会被 applyQualityChecklist 剥成空串
    positiveCharacterTokens: 'film still character portrait, anamorphic look, atmospheric practical lighting, shallow depth of field',
    positiveShotTokens: 'film still aesthetic, anamorphic lens, shallow DOF, film grain, teal-orange color grade',
    keywords: ['cinematic', '电影感', 'film', 'cinematography'],
  },
  {
    slug: 'anime',
    label: '动漫',
    hint: '日系热血 / 校园 / 奇幻 / 轻改',
    positiveCharacterTokens: 'anime key visual, cel shading, vibrant color, official anime art style',
    positiveShotTokens: 'anime scene illustration, cel-shaded, vibrant color palette, anime key visual style',
    keywords: ['anime', '动漫', '二次元', '漫画', 'manga', 'cartoon'],
  },
  {
    slug: 'ink',
    label: '水墨',
    hint: '国风 / 仙侠 / 江湖 / 古装',
    positiveCharacterTokens: 'traditional Chinese ink painting, brush stroke aesthetic, monochrome with selective color wash, xieyi freehand style',
    positiveShotTokens: 'ink wash background, traditional Chinese painting composition, soft brush stroke texture, generous negative space',
    keywords: ['ink', '水墨', '国画', '写意', 'xieyi', 'chinese painting'],
  },
  {
    slug: 'ghibli',
    label: '吉卜力',
    hint: '吉卜力 / 治愈 / 童话 / 自然',
    positiveCharacterTokens: 'Studio Ghibli style, watercolor texture, soft pastel colors, Hayao Miyazaki art style',
    positiveShotTokens: 'Studio Ghibli background art, watercolor texture, soft pastel, dreamy atmosphere',
    keywords: ['ghibli', '吉卜力', '宫崎骏', 'studio ghibli'],
  },
  {
    slug: 'comic',
    label: '美式漫画',
    hint: '欧美图像小说 / 超级英雄 / 暗黑',
    positiveCharacterTokens: 'American comic book art, ink linework, halftone shading, superhero comic aesthetic',
    positiveShotTokens: 'comic book panel, bold ink lines, halftone shading, dynamic comic composition',
    keywords: ['comic', '漫画', '美式', 'superhero', 'comic book'],
  },
  {
    slug: 'watercolor',
    label: '水彩',
    hint: '水彩插画 / 文艺 / 民国 / 江南',
    positiveCharacterTokens: 'watercolor illustration, soft washes, paper texture, hand-painted watercolor style',
    positiveShotTokens: 'watercolor painting style, soft washes, paper texture, hand-painted illustration',
    keywords: ['watercolor', '水彩', 'hand-painted', 'painting'],
  },
]

/**
 * 根据 drama.style 字符串匹配风格预设
 */
export function getStylePreset(style?: string | null): StylePreset {
  if (!style) return STYLE_PRESETS[0] // default to realistic
  const lower = style.toLowerCase()
  for (const preset of STYLE_PRESETS) {
    if (preset.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return preset
    }
  }
  return STYLE_PRESETS[0] // fallback to realistic
}

/**
 * 预设库。当前覆盖 5 个主流风格场景。
 * 新增风格：在数组末尾追加即可，keywords 数组任意一项命中即生效。
 */
export const NEGATIVE_PROMPT_PRESETS: NegativePromptPreset[] = [
  {
    id: 'anime',
    label: '动漫',
    keywords: ['anime', '二次元', '漫画', '卡通', 'manga', 'cartoon', '动漫'],
    prompt:
      'realistic, photo, photograph, 3d render, live action, blurry, watermark, text, deformed, ugly, low quality, extra fingers, disfigured, bad anatomy',
  },
  {
    id: 'realistic',
    label: '写实',
    keywords: ['realistic', '真人', '电影', 'cinematic', 'live action', '写实'],
    prompt:
      'cartoon, anime, drawing, illustration, 3d render, blurry, watermark, text, deformed face, extra fingers, ugly, low quality, bad anatomy',
  },
  {
    id: 'ink',
    label: '水墨',
    keywords: ['水墨', 'ink', '国风', '水彩', 'ink wash', 'chinese painting'],
    prompt:
      'neon, vibrant colors, modern, cartoon, anime, 3d, photo, blurry, watermark, text, low quality',
  },
  {
    id: 'cinematic',
    label: '电影感',
    keywords: ['cinematic', 'film', '电影感', 'movie', 'epic', '大片', '商业片'],
    prompt:
      'cartoon, anime, drawing, flat lighting, overexposed, underexposed, blurry, watermark, text, low quality, amateur',
  },
  {
    id: 'ghibli',
    label: '吉卜力',
    keywords: ['ghibli', '吉卜力', '宫崎骏', 'studio ghibli'],
    prompt:
      'photorealistic, sharp photo, harsh lighting, neon colors, cyberpunk, modern, 3d render, blurry, watermark, text',
  },
  {
    id: 'comic',
    label: '美式漫画',
    keywords: ['comic', '美式', 'superhero', 'comic book'],
    prompt:
      'photorealistic, photo, photograph, realistic skin, 3d render, blurry, watermark, text, low quality',
  },
  {
    id: 'watercolor',
    label: '水彩',
    keywords: ['watercolor', '水彩', 'hand-painted', 'painting'],
    prompt:
      'photorealistic, photo, 3d render, digital art, neon, vibrant colors, sharp edges, blurry, watermark, text',
  },
  {
    id: 'generic',
    label: '通用',
    keywords: [], // 永不主动匹配，只作为 fallback
    prompt:
      'blurry, watermark, text, low quality, deformed, ugly, extra fingers, disfigured, bad anatomy, jpeg artifacts',
  },
]

/**
 * 根据 drama.style 字符串匹配最佳预设
 *
 * @param style 风格字符串（如 "中国古典神话水墨风格"，null/undefined 走 fallback）
 * @returns 命中的预设对象
 */
export function getPresetByStyle(style?: string | null): NegativePromptPreset {
  if (!style) return NEGATIVE_PROMPT_PRESETS[NEGATIVE_PROMPT_PRESETS.length - 1]
  const lower = style.toLowerCase()
  for (const preset of NEGATIVE_PROMPT_PRESETS) {
    if (preset.keywords.length === 0) continue // 跳过 fallback
    if (preset.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return preset
    }
  }
  return NEGATIVE_PROMPT_PRESETS[NEGATIVE_PROMPT_PRESETS.length - 1] // fallback 到通用
}

/**
 * 根据预设 ID 查预设（前端 chip 点击时用）
 */
export function getPresetById(id: string): NegativePromptPreset | undefined {
  return NEGATIVE_PROMPT_PRESETS.find((p) => p.id === id)
}

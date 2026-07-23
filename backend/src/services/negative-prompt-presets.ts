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
    label: '真人电影',
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
    keywords: ['film', '电影感', 'movie', 'epic', '大片', '商业片'],
    prompt:
      'cartoon, anime, drawing, flat lighting, overexposed, underexposed, blurry, watermark, text, low quality, amateur',
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

/**
 * AGE ANCHOR — 独立模块，跟 face-archive 解耦
 * PM msg-20260929-002 Sprint 5 Task G
 *
 * 设计动机:
 *   - face-archive 管"五官/发型/服饰"风格 (D 模块注入)
 *   - AGE ANCHOR 管"年龄态视觉差异" (本模块)
 *   - 两个独立维度, 互不污染, 各自常量文件 + 解耦 schema
 *
 * 兼容性:
 *   - 跟 93e3e81 realistic preset 兼容 (realistic 是画风, AGE ANCHOR 是年龄态视觉)
 *   - 跟 existing prompts 字段兼容 (imagePrompt 三段并列硬拼, 不污染 PERMANENT/PLOT_STATE 拆分)
 *   - 跟 face-archive tokens 兼容 (两者并列入 imagePrompt 末尾)
 *
 * 注入位置:
 *   - src/routes/characters.ts imagePrompt 拼接 (single + batch)
 *   - 拼法: aestheticTokens + faceArchiveTokens + ageAnchorTokens 三段并列 (全 code-side)
 *
 * 锚定策略 (按 character.age 选 range, fallback drama 默认 35):
 *   - parseAgeFromAppearance(appearance) — regex /(\d+)\s*(岁|years?\s*old)/i
 *   - 找不到 → 用 drama 默认 35
 *   - 默认 age 35 → 'early_adult' (30-39 轻微眼角纹, 下颌线紧致)
 *
 * 跨剧多样性:
 *   - face-archive ORDER BY RANDOM() 保证脸型差异化
 *   - AGE ANCHOR 按实际 age 选 range (无随机, 确定性, 给图片生成稳定视觉参考)
 */

export interface AgeRange {
  /** 短代码 — 用于日志/调试 */
  slug: 'young_adult' | 'early_adult' | 'middle_age' | 'mature'
  /** 年龄区间 (显示用) */
  ageRange: string
  /** 正向提示词 token — 注入 imagePrompt (空串则不注入) */
  anchorTokens: string
  /** 内部注释 — 锚定'年龄态视觉差异'不锚定'具体五官' */
  hint: string
}

export const AGE_RANGES: AgeRange[] = [
  {
    slug: 'young_adult',
    ageRange: '20-29',
    anchorTokens: '清晰轮廓, 紧致肌肤, 饱满面部脂肪, 无明显皱纹, 年轻有活力',
    hint: '20-29 青春期已过的年轻成人 — 面部脂肪饱满, 皮肤紧致, 无皱纹',
  },
  {
    slug: 'early_adult',
    ageRange: '30-39',
    anchorTokens: '轻微眼角纹, 下颌线紧致, 皮肤饱满微失弹性, 成熟干练',
    hint: '30-39 早期成人 — 初始衰老信号 (眼角纹), 整体仍年轻',
  },
  {
    slug: 'middle_age',
    ageRange: '40-49',
    anchorTokens: '明显法令纹, 眼角纹加深, 皮肤微松弛, 发际线稳定, 沉稳气质',
    hint: '40-49 中年 — 衰老信号明显 (法令纹, 眼角纹), 皮肤开始松弛',
  },
  {
    slug: 'mature',
    ageRange: '50-59',
    anchorTokens: '深刻皱纹, 皮肤松弛明显, 花白或灰白发丝, 眼神深邃, 长者气质',
    hint: '50-59 成熟期 — 深度衰老 (深刻皱纹 + 皮肤松弛 + 花白发)',
  },
]

/** 默认年龄 — 没找到 drama 数据 / 没 parse 到数字 age 时 fallback */
export const DEFAULT_AGE = 35

/**
 * 按数字年龄选 AGE_RANGES (闭区间下限匹配)
 * 20-29 → young_adult
 * 30-39 → early_adult
 * 40-49 → middle_age
 * 50-59 → mature
 * < 20 → young_adult (少年/未成年)
 * >= 60 → mature (老年)
 */
export function getAgeRangeForAge(age: number): AgeRange {
  if (age < 30) return AGE_RANGES[0]  // young_adult
  if (age < 40) return AGE_RANGES[1]  // early_adult
  if (age < 50) return AGE_RANGES[2]  // middle_age
  return AGE_RANGES[3]                  // mature
}

/**
 * 从 appearancePermanent / appearance 文本里 parse 数字 age
 * 支持:
 *   - "25 岁" / "25岁"
 *   - "25 years old" / "25-year-old"
 *   - "around 30" / "about 35"
 * 找不到返回 null (调用方 fallback DEFAULT_AGE)
 */
export function parseAgeFromAppearance(text: string | null | undefined): number | null {
  if (!text) return null
  // 中英双语 + 多种格式
  const patterns = [
    /(\d+)\s*岁/,
    /(\d+)\s*years?\s*old/i,
    /(\d+)\s*-\s*year\s*-?\s*old/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m && m[1]) {
      const n = parseInt(m[1], 10)
      if (n >= 0 && n < 200) return n  // sanity check
    }
  }
  return null
}

/**
 * 选 age anchor tokens (用于 imagePrompt 注入)
 * 优先级:
 *  1. parseAgeFromAppearance(char.appearancePermanent || char.appearance)
 *  2. fallback DEFAULT_AGE (35 → early_adult)
 * 3. 返回对应 range 的 anchorTokens (空串则不注入)
 */
export function getAgeAnchorTokens(appearanceText: string | null | undefined): string {
  const age = parseAgeFromAppearance(appearanceText) ?? DEFAULT_AGE
  const range = getAgeRangeForAge(age)
  return range.anchorTokens
}

/**
 * 角色性别后置保险 — Sprint 12 Task B (PM msg-20261017-072)
 *
 * 问题: Task A 给 permanent_traits enum 加了 gender 维度, 但 appearancePermanent 文本
 *   最后还要过一道 LLM 改写 (sanitizeImagePrompt → MiniMax gemini) —— LLM 改写时
 *   可能把 gender 丢掉, 导致 Task A 白做一半。
 *   实际事故: drama 14 林达 (剧本明确"男") 被改写成 'Linda East Asian woman'。
 *
 * 方案: 纯 code-side 正则校验 (【不调 LLM, 不增加耗时】):
 *   1. 从 characters.permanentTraits JSON 读 category=='gender' 的 value
 *   2. 检查 sanitizeImagePrompt 返回值里是否还含对应性别词
 *   3. 检测不到 → append 英文兜底词 + logTaskWarn 便于统计 LLM 改写可靠性
 *   4. 检测到 → 原样返回 (不覆盖 LLM 的表达, 它的英文写法通常更准确)
 *
 * ⚠️ 不改 sanitizeImagePrompt 本身 (它被 characters/scenes/props/images/grid 5 处复用,
 *   改签名影响面大)。只在 characters.ts 的两个调用点后处理。
 *
 * 老数据兼容 (PM D2 已锁定不回填): permanentTraits 无 gender 项 → 跳过校验, 行为跟现在一致。
 */
import { logTaskWarn } from './task-logger.js'

/** gender value → 检测正则 + 英文兜底词 */
const GENDER_RULES: Array<{
  /** 匹配 permanentTraits 里 gender 的 value (中文简体/繁体) */
  match: RegExp
  /** 检测 sanitizeImagePrompt 输出里是否还含该性别 (英文 + 中文双查) */
  detect: RegExp
  /** 兜底追加的英文词 (PM 2026-10-17 拍板用英文 — sanitizer 输出本来就是英文) */
  fallback: string
}> = [
  {
    // ⚠️⚠️ female/woman 规则必须排在 male/man 之前 (顺序敏感, 不能调换!)
    //   'woman' 里含 'man' — 词边界救不了: w-o-m-a-n 中 man 前一个字符是 'o',
    //   \bman\b 的 \b 判定是"非单词字符 vs 单词字符", 'o' 和 'm' 都是单词字符,
    //   所以 woman 内部根本不存在边界, \bman\b 会匹配到 woman 的 man 子串。
    //   同理 'female' 含 'male' 子串 (f-e-m-a-l-e, male 前是 'e', 同样是单词字符)。
    //   实测 (Sprint 12 Task B 自测): 顺序反过来时 'Linda, East Asian woman' 会被
    //   误判为"缺男性词" 而追加 ', male' — 已通过顺序约束修掉。
    match: /^(?:女性|女|woman$|female$|f$)/i,
    detect: /\b(?:female|women|woman|feminine|lady|her|she)\b|女性|女人|女$/i,
    fallback: ', female',
  },
  {
    match: /^(?:男性|男|男性$|male$|m$|he$|him$)/i,
    // female/woman/women/feminine/lady 已由上一条规则拦掉, 这里不再重复
    detect: /\b(?:male|men|man|masculine|gentleman|his|he|him)\b|男性|男人|男$/i,
    fallback: ', male',
  },
  {
    match: /^(?:中性|无性别|non-?binary|androgynous|neutral)$/i,
    detect: /\b(?:non-?binary|androgynous|gender-?neutral|neutral)\b|中性|无性别/i,
    fallback: ', androgynous',
  },
]

/**
 * 从 permanentTraits JSON 字符串里提取 gender 维度的 value。
 * @returns gender 描述 (如 '男性' / '女性'), 无 gender 项或解析失败返回 null
 */
export function extractGenderTrait(permanentTraits: string | null | undefined): string | null {
  if (!permanentTraits) return null
  try {
    const parsed = JSON.parse(permanentTraits)
    if (!Array.isArray(parsed)) return null
    for (const item of parsed) {
      if (item?.category === 'gender' && typeof item.value === 'string' && item.value.trim()) {
        return item.value.trim()
      }
    }
    return null
  } catch {
    // 老数据 JSON 损坏时按无 gender 处理, 不阻断生图
    return null
  }
}

/**
 * 后置保险: 检查 sanitizeImagePrompt 的输出是否还含该角色的性别词, 丢了就在末尾 append 英文兜底词。
 *
 * ⚠️ 只【append】, 不替换 / 不删除 LLM 已有内容 (LLM 改写的英文表达通常比兜底词更准确更丰富)。
 * ⚠️ 纯正则判断, 【不调 LLM】, 不增加响应时间。
 *
 * @param prompt        sanitizeImagePrompt 的返回值 (已改写成英文)
 * @param gender        该角色 permanent_traits 里的 gender value (如 '男性')
 * @param context       日志上下文 { characterId, dramaId }
 * @returns 加了兜底词的 prompt (检测到性别词时原样返回)
 */
export function ensureGenderInPrompt(
  prompt: string,
  gender: string | null,
  context: { characterId?: number; dramaId?: number } = {},
): string {
  // 老数据 (PM D2 锁定不回填) → 无 gender 项, 跳过校验, 行为跟现在一致
  if (!gender) return prompt

  const rule = GENDER_RULES.find(r => r.match.test(gender.trim()))
  if (!rule) {
    // gender value 不在三种规则内 (LLM 写了怪值, 如 'unknown') → 不兜底, 避免乱加词
    return prompt
  }

  // 检测到性别词 → 原样返回, 不干预 LLM 的表达
  if (rule.detect.test(prompt)) return prompt

  // 未检测到 → append 英文兜底词 + 记 warn 便于统计 LLM 改写可靠性
  const guarded = `${prompt.trimEnd()}${rule.fallback}`
  logTaskWarn('CharacterGender', 'gender-dropped-by-sanitizer', {
    ...context,
    gender,
    fallback: rule.fallback,
    promptPreview: prompt.slice(0, 200),
  })
  return guarded
}

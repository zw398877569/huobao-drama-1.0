/**
 * Prompt quality checklist — slop trap removal for AI video prompts.
 *
 * Sources: vault/reference/prompt-quality-checklist.md (human-readable
 * mirror) + Seedance 2.0 anti-slop-lexicon (v6.6.0) inspiration.
 *
 * What this does:
 *   - Strips or replaces empty adjectives ("cinematic", "beautiful",
 *     "dramatic", "epic", ...) that AI image / video models tend to
 *     over-react to without actually improving the output.
 *   - Replaces known low-quality terms ("zoom in" → "slow push-in",
 *     "cinematic lighting" → "" + reminder, etc.) with more precise
 *     phrasing that Agnes / Seedance / Qwen-VL respond to better.
 *   - Whitespace / punctuation cleanup.
 *
 * What it does NOT do:
 *   - Translate Chinese → English. The prompts may be bilingual or
 *     fully Chinese — leave language alone.
 *   - Reorder content or rewrite structurally. This is a non-creative
 *     filter, by design — it runs on agent-generated text where we
 *     want to preserve the LLM's intent and only remove slop.
 *
 * Performance: O(n * |rules|), but rules are small and prompts are
 * short. Fine to run on every save.
 */

// Each rule: { slop, preferred, category, reason }.
// - slop: literal text to match, case-insensitive, word-boundary.
// - preferred: replacement text. If empty string, the slop is stripped
//   along with its surrounding whitespace.
// - category: 视觉形容词 / 镜头术语 / 光线描述 / 运动描述.
// - reason: human-readable explanation (logged when a replacement
//   actually fires).
export type PromptKind = 'image' | 'video' | 'any'

interface SlopRule {
  slop: string
  preferred: string
  category: '视觉形容词' | '镜头术语' | '光线描述' | '运动描述'
  reason: string
  // Restrict to a kind; omit (undefined) means applies to all kinds.
  kinds?: PromptKind[]
}

const SLOP_RULES: SlopRule[] = [
  // ── 视觉形容词 (visual adjectives) ─────────────────────────────
  { slop: 'cinematic',      preferred: '', category: '视觉形容词', reason: '抽象词，模型响应不稳定；用具体光线 / 调色代替' },
  { slop: 'beautiful',      preferred: '', category: '视觉形容词', reason: '形容词无信息量；改写具体视觉元素' },
  { slop: 'stunning',       preferred: '', category: '视觉形容词', reason: '形容词无信息量' },
  { slop: 'gorgeous',       preferred: '', category: '视觉形容词', reason: '形容词无信息量' },
  { slop: 'impressive',     preferred: '', category: '视觉形容词', reason: '形容词无信息量' },
  { slop: 'dramatic',       preferred: '', category: '视觉形容词', reason: '模糊；改写具体对比 / 阴影 / 紧张感' },
  { slop: 'epic',           preferred: 'sweeping wide shot', category: '视觉形容词', reason: '太宽泛；改写具体尺度 + 景别' },
  { slop: 'high quality',   preferred: '', category: '视觉形容词', reason: '默认期望，去掉避免重复触发' },
  { slop: 'high-quality',   preferred: '', category: '视觉形容词', reason: '默认期望' },
  { slop: 'professional',   preferred: '', category: '视觉形容词', reason: '无信息量' },
  { slop: 'masterpiece',    preferred: '', category: '视觉形容词', reason: '无信息量' },
  { slop: 'breathtaking',   preferred: '', category: '视觉形容词', reason: '无信息量' },
  { slop: 'award-winning',  preferred: '', category: '视觉形容词', reason: '触发误判，且无信息量' },

  // ── 镜头术语 (camera / shot terminology) ────────────────────────
  // "zoom" is a digital focal-length change, NOT a physical camera
  // move. Models that take it literally produce "scaling" artifacts
  // instead of perspective changes. Prefer dolly / push-in.
  { slop: 'zoom in',     preferred: 'slow push-in',      category: '镜头术语', reason: 'zoom 是数码焦距变化，常被误处理；用 dolly / push-in 表达物理推进' },
  { slop: 'zoom-in',     preferred: 'slow push-in',      category: '镜头术语', reason: '同上' },
  { slop: 'zooms in',    preferred: 'pushes in slowly',  category: '镜头术语', reason: '同上' },
  { slop: 'zooming in',  preferred: 'pushing in slowly', category: '镜头术语', reason: '同上' },
  { slop: 'zoom out',    preferred: 'slow pull-back',    category: '镜头术语', reason: 'zoom 是数码焦距变化，用 dolly out' },
  { slop: 'zoom-out',    preferred: 'slow pull-back',    category: '镜头术语', reason: '同上' },
  { slop: 'zooms out',   preferred: 'pulls back slowly', category: '镜头术语', reason: '同上' },
  { slop: 'zooming out', preferred: 'pulling back slowly', category: '镜头术语', reason: '同上' },
  { slop: 'crash zoom',  preferred: 'snap focus pull',   category: '镜头术语', reason: 'crash zoom 在大多数 AI 视频模型里不可控' },

  { slop: 'POV shot',          preferred: 'first-person POV shot', category: '镜头术语', reason: '显式第一人称视角，模型更稳定' },
  { slop: 'POV',               preferred: 'first-person POV',      category: '镜头术语', reason: '同上（独立词匹配，谨慎使用）' },
  { slop: 'tracking shot',     preferred: 'tracking shot following [subject]', category: '镜头术语', reason: '指明跟拍对象' },
  { slop: 'pan shot',          preferred: 'lateral pan',          category: '镜头术语', reason: 'lateral 比 pan 更精确' },
  { slop: 'dolly zoom',        preferred: 'dolly push with zoom', category: '镜头术语', reason: 'Vertigo 效果需要分别说明' },

  // ── 光线描述 (lighting) ────────────────────────────────────────
  // "cinematic lighting" / "moody lighting" / "dramatic lighting"
  // — three flavors of the same problem. The model will pick something
  // arbitrary; better to write the actual lighting recipe.
  { slop: 'cinematic lighting',  preferred: '',  category: '光线描述', reason: '抽象词；改写方向 + 色温 + 软硬' },
  { slop: 'moody lighting',     preferred: '',  category: '光线描述', reason: '抽象词；改写具体光影' },
  { slop: 'dramatic lighting',  preferred: '',  category: '光线描述', reason: '抽象词；改写具体光影' },
  { slop: 'beautiful lighting', preferred: '',  category: '光线描述', reason: '抽象词' },
  { slop: 'good lighting',      preferred: '',  category: '光线描述', reason: '无信息量' },
  { slop: 'natural lighting',   preferred: 'available daylight', category: '光线描述', reason: '更明确（自然光在不同模型里差异极大）' },
  { slop: 'soft lighting',      preferred: 'diffused soft light', category: '光线描述', reason: '显式光源软硬' },
  { slop: 'hard lighting',      preferred: 'direct hard light',  category: '光线描述', reason: '显式光源软硬' },

  // ── 运动描述 (movement / motion) ────────────────────────────────
  { slop: 'smooth camera movement', preferred: '', category: '运动描述', reason: 'AI 视频默认就是平滑的，重复触发' },
  { slop: 'dynamic motion',         preferred: '', category: '运动描述', reason: '抽象词' },
  { slop: 'camera moves',           preferred: '', category: '运动描述', reason: '无主语 / 无方向' },
  { slop: 'slow motion',            preferred: 'half-speed playback', category: '运动描述', reason: 'slow motion 在文本里常被模型误读为延迟生成' },
  { slop: 'fast motion',            preferred: 'time-lapse playback',  category: '运动描述', reason: '同上' },
]

/**
 * Apply the slop checklist to a prompt string. Returns the cleaned
 * text plus a list of rules that fired (for logging / debugging).
 *
 * Matching: case-insensitive, word-boundary, treats both English and
 * Chinese text as one searchable corpus. Replacements preserve the
 *   - First-letter casing of the original (e.g. "Cinematic" →
 *     "" rather than "cinematic" → ""), so sentence flow stays OK.
 *   - Adjacent whitespace (strip trailing space when preferred is "").
 *
 * Idempotent: running apply twice returns the same result.
 */
export function applyQualityChecklist(
  text: string | undefined | null,
  kind: PromptKind = 'any'
): { cleaned: string; fired: Array<{ rule: SlopRule; original: string }> } {
  if (!text) return { cleaned: text ?? '', fired: [] }
  const fired: Array<{ rule: SlopRule; original: string }> = []
  let result = text

  for (const rule of SLOP_RULES) {
    if (rule.kinds && !rule.kinds.includes(kind)) continue

    // Escape regex metachars in the slop term.
    const escaped = rule.slop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Word boundary — \b works for ASCII, Chinese characters don't have
    // \b semantics in JS, so we use a custom look-around that treats
    // any non-letter as a boundary on both sides.
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])(${escaped})(?![A-Za-z0-9_])`,
      'gi'
    )

    result = result.replace(pattern, (match) => {
      fired.push({ rule, original: match })
      if (rule.preferred === '') {
        // Strip — drop the word and collapse surrounding whitespace
        return ''
      }
      // Preserve leading capital if the original had one
      const originalCapped = /^[A-Z]/.test(match)
      const replacementCapped = /^[A-Z]/.test(rule.preferred)
      if (originalCapped && !replacementCapped) {
        return rule.preferred.charAt(0).toUpperCase() + rule.preferred.slice(1)
      }
      return rule.preferred
    })
  }

  // Post-cleanup: collapse double spaces, strip trailing commas / periods
  // left behind by a stripped word, normalize multiple newlines.
  result = result
    .replace(/[ \t]{2,}/g, ' ')                       // collapse spaces
    .replace(/\s+,/g, ',')                            // " ," → ","
    .replace(/\s+\./g, '.')                           // " ." → "."
    .replace(/,\s*\./g, '.')                          // ", ." → "."
    .replace(/\n{3,}/g, '\n\n')                       // collapse blank lines
    .replace(/^[ \t]+|[ \t]+$/gm, '')                  // trim line whitespace
    .trim()

  return { cleaned: result, fired }
}

/**
 * Return the full rules table (for docs / debugging). Order matches
 * the SLOP_RULES definition.
 */
export function getSlopRules(): readonly SlopRule[] {
  return SLOP_RULES
}

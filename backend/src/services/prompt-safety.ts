/**
 * Prompt IP safety — P2 from seedance-optimizations checklist.
 *
 * Pre-flight rewrite layer that runs before a prompt is sent to the
 * image / video provider. Detects references that are likely to be
 * flagged as copyright, trademark, or privacy violations:
 *
 *   - Celebrity names (Taylor Swift, LeBron James, Joe Biden, etc.)
 *   - Brand names (Nike, Apple, Coca-Cola, Disney, ...)
 *   - IP characters (Mickey Mouse, Spider-Man, Pikachu, Darth Vader, ...)
 *   - Logo descriptors ("the swoosh", "the apple logo", ...)
 *   - Private individuals referenced by name
 *   - "looks like X" / "in the style of X" / "resembling X" patterns
 *
 * For each match, rewrite to the generic descriptor from the
 * project's prompts/policy-cheatsheet.md table and log the change.
 * The original prompt is preserved on the storyboard row so the UI
 * can show before/after diff.
 *
 * Design choices:
 *   - Pure function, no LLM call. This runs on every storyboard save
 *     so it has to be cheap.
 *   - Conservative detection. False positives (rewriting something
 *     that wasn't actually IP) are acceptable; false negatives
 *     (missing real IP) just defer to the existing 400 retry path.
 *   - Idempotent (running twice = running once).
 *
 * Public helper: buildProductionContextPrefix() returns a short
 * prefix that downstream code (e.g. prompt-sanitizer.ts retry
 * path) can prepend when a benign production context is being
 * misjudged by the upstream policy filter.
 */

export type SafetyCategory = 'celebrity' | 'brand' | 'ip_character' | 'logo' | 'private' | 'style_pattern' | 'other'

export interface SafetyNote {
  original: string         // the exact text that was matched (preserves casing)
  replacement: string      // what we swapped it for
  category: SafetyCategory
  reason: string           // human-readable explanation
}

export interface SafetyResult {
  cleaned: string
  flagged: boolean         // true if any rewrite happened
  notes: SafetyNote[]
}

// ── Rewrite rules ──────────────────────────────────────────────────
// Each rule: { pattern, replacement, category, reason }.
// Patterns are case-insensitive. Replacement runs through the same
// case-preserving path as prompt-quality.ts.

interface SafetyRule {
  pattern: RegExp
  replacement: string
  category: SafetyCategory
  reason: string
  // Optional kind filter (image / video). Undefined = applies to all.
  kind?: 'image' | 'video'
}

const SAFETY_RULES: SafetyRule[] = [
  // ── "looks like X" / "in the style of X" style patterns ──────────
  // These run first so that the X part is stripped before the specific
  // entity rules try to rewrite it. Tightened to 1-3 words so we don't
  // eat full sentences if the likeness clause is followed by description.
  { pattern: /\s*,?\s*(looks like|looking like|resembling)\s+[A-Z][\w'-]+(?:\s+[A-Z]?[\w'-]+){0,2}/g, replacement: '', category: 'style_pattern',
    reason: '"looks like X" 直接指代名人/IP，移除相似度描述' },
  { pattern: /\s*,?\s*in the style of\s+[A-Z][\w'-]+(?:\s+[A-Z]?[\w'-]+){0,2}/g, replacement: '', category: 'style_pattern',
    reason: '"in the style of X" 引用受版权保护的创作者，移除' },
  { pattern: /\s*,?\s*(穿着|身着|模仿)\s*[一-龥]{2,8}\s*(风格|造型|装扮)/g, replacement: '', category: 'style_pattern',
    reason: '"穿着 X 风格" 引用受版权保护的视觉风格' },

  // ── Brands (consumer products / tech) ────────────────────────────
  { pattern: /\bNike\b/g, replacement: 'athletic', category: 'brand',
    reason: 'Nike 是注册商标；用通用描述代替' },
  { pattern: /\bAdidas\b/g, replacement: 'athletic (three-stripe)', category: 'brand',
    reason: 'Adidas 是注册商标' },
  { pattern: /\bApple\b/g, replacement: 'modern tech', category: 'brand',
    reason: 'Apple 是注册商标；用通用描述代替' },
  { pattern: /\bSamsung\b/g, replacement: 'modern smartphone brand', category: 'brand',
    reason: 'Samsung 是注册商标' },
  { pattern: /\biPhone\b/g, replacement: 'modern smartphone with a notch', category: 'brand',
    reason: 'iPhone 是 Apple 注册商标' },
  { pattern: /\bCoca[-\s]?Cola\b/g, replacement: 'contoured glass soda bottle with red label', category: 'brand',
    reason: 'Coca-Cola 是注册商标' },
  { pattern: /\bPepsi\b/g, replacement: 'cola-flavored soda bottle', category: 'brand',
    reason: 'Pepsi 是注册商标' },
  { pattern: /\bDisney\b/g, replacement: 'major animation studio style', category: 'brand',
    reason: 'Disney 是注册商标' },
  { pattern: /\bMcDonald'?s\b/g, replacement: 'fast food burger chain', category: 'brand',
    reason: 'McDonald\'s 是注册商标' },
  { pattern: /\bStarbucks\b/g, replacement: 'coffee chain with mermaid logo', category: 'brand',
    reason: 'Starbucks 是注册商标' },
  { pattern: /\bBMW\b/g, replacement: 'luxury German sedan', category: 'brand',
    reason: 'BMW 是注册商标' },
  { pattern: /\bMercedes[-\s]?Benz\b/g, replacement: 'luxury German sedan (three-pointed star)', category: 'brand',
    reason: 'Mercedes-Benz 是注册商标' },
  { pattern: /\bTesla\b/g, replacement: 'modern electric sedan', category: 'brand',
    reason: 'Tesla 是注册商标' },

  // ── Logos ───────────────────────────────────────────────────────
  { pattern: /\bswoosh\b/gi, replacement: 'curved check-mark side accent', category: 'logo',
    reason: '"swoosh" 直接指代 Nike logo' },
  { pattern: /\bapple logo\b/gi, replacement: 'fruit-shaped emblem', category: 'logo',
    reason: '"apple logo" 直接指代 Apple 注册商标' },
  { pattern: /\bthree[-\s]pointed star\b/gi, replacement: 'three-pointed star hood ornament', category: 'logo',
    reason: 'Mercedes hood logo' },

  // ── IP characters (cartoons / superheroes / anime / film) ────────
  { pattern: /\bMickey\s+Mouse\b/g, replacement: 'anthropomorphic cartoon mouse in red shorts and white gloves', category: 'ip_character',
    reason: 'Mickey Mouse 是 Disney 受版权保护角色' },
  { pattern: /\bMinnie\s+Mouse\b/g, replacement: 'anthropomorphic cartoon mouse in a polka-dot dress', category: 'ip_character',
    reason: 'Minnie Mouse 是 Disney 受版权保护角色' },
  { pattern: /\bDonald\s+Duck\b/g, replacement: 'anthropomorphic cartoon duck in a sailor suit', category: 'ip_character',
    reason: 'Donald Duck 是 Disney 受版权保护角色' },
  { pattern: /\bSpider[-\s]?Man\b/g, replacement: 'masked superhero in a red-and-blue skin-tight suit', category: 'ip_character',
    reason: 'Spider-Man 是 Marvel 受版权保护角色' },
  { pattern: /\bBatman\b/g, replacement: 'masked vigilante in a bat-shaped cowl and cape', category: 'ip_character',
    reason: 'Batman 是 DC 受版权保护角色' },
  { pattern: /\bSuperman\b/g, replacement: 'cape-wearing superhero with a chest emblem', category: 'ip_character',
    reason: 'Superman 是 DC 受版权保护角色' },
  { pattern: /\bPikachu\b/g, replacement: 'small yellow rodent-like creature with red cheeks and a lightning-shaped tail', category: 'ip_character',
    reason: 'Pikachu 是 Pokemon 受版权保护角色' },
  { pattern: /\bDarth\s+Vader\b/g, replacement: 'tall figure in a black helmet, cape, and mechanical armor suit', category: 'ip_character',
    reason: 'Darth Vader 是 Star Wars 受版权保护角色' },
  { pattern: /\bYoda\b/g, replacement: 'small green-skinned elder with pointed ears', category: 'ip_character',
    reason: 'Yoda 是 Star Wars 受版权保护角色' },
  { pattern: /\bGoku\b/g, replacement: 'muscular spiky-haired martial artist in an orange gi', category: 'ip_character',
    reason: 'Goku 是 Dragon Ball 受版权保护角色' },
  { pattern: /\bMario\b(?!\s+Lopez)/g, replacement: 'plumber in a red cap with a thick mustache', category: 'ip_character',
    reason: 'Mario 是 Nintendo 受版权保护角色' },
  { pattern: /\bHello\s+Kitty\b/g, replacement: 'cute anthropomorphic white cat with a red bow', category: 'ip_character',
    reason: 'Hello Kitty 是 Sanrio 受版权保护角色' },

  // ── Celebrities (politicians / athletes / entertainers) ─────────
  { pattern: /\bTaylor\s+Swift\b/g, replacement: 'female pop singer with shoulder-length blonde hair', category: 'celebrity',
    reason: 'Taylor Swift 是真实公众人物' },
  { pattern: /\bJoe\s+Biden\b/g, replacement: 'older male politician in a navy suit', category: 'celebrity',
    reason: 'Joe Biden 是真实公众人物' },
  { pattern: /\bDonald\s+Trump\b/g, replacement: 'older male politician with blonde swept hair', category: 'celebrity',
    reason: 'Donald Trump 是真实公众人物' },
  { pattern: /\bElon\s+Musk\b/g, replacement: 'tech executive in a black jacket', category: 'celebrity',
    reason: 'Elon Musk 是真实公众人物' },
  { pattern: /\bLeBron\s+James\b/g, replacement: 'tall muscular basketball player in a yellow jersey', category: 'celebrity',
    reason: 'LeBron James 是真实公众人物' },
  { pattern: /\bBrad\s+Pitt\b/g, replacement: 'man in his 50s with a sharp jawline and short salt-and-pepper hair', category: 'celebrity',
    reason: 'Brad Pitt 是真实公众人物' },
]

/**
 * Preserve original capitalisation of the first letter when the
 * replacement starts lowercase. Mirrors prompt-quality.ts logic.
 */
function preserveCase(original: string, replacement: string): string {
  if (!replacement) return replacement
  const originalCapped = /^[A-Z]/.test(original)
  const replacementCapped = /^[A-Z]/.test(replacement)
  if (originalCapped && !replacementCapped) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

export function checkPromptSafety(
  text: string,
  kind: 'image' | 'video' = 'image'
): SafetyResult {
  if (!text) return { cleaned: text ?? '', flagged: false, notes: [] }

  const notes: SafetyNote[] = []
  let cleaned = text

  for (const rule of SAFETY_RULES) {
    if (rule.kind && rule.kind !== kind) continue
    cleaned = cleaned.replace(rule.pattern, (match) => {
      // Avoid duplicate notes for the same original text within one pass
      if (notes.some((n) => n.original.toLowerCase() === match.toLowerCase())) {
        return preserveCase(match, rule.replacement)
      }
      notes.push({
        original: match,
        replacement: rule.replacement,
        category: rule.category,
        reason: rule.reason,
      })
      return preserveCase(match, rule.replacement)
    })
  }

  // Post-cleanup: collapse double spaces left by empty replacements.
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\s+,/g, ',').trim()

  return { cleaned, flagged: notes.length > 0, notes }
}

/**
 * Build a short prefix that downstream code can prepend when an
 * upstream policy filter has flagged something that the user
 * legitimately wanted (a benign production context).
 *
 * This is the canonical "false-positive fix" recommended in the
 * P2 IP-safe checklist: don't try to bypass the policy filter by
 * hiding intent — clarify the legitimate production context.
 *
 * Used by prompt-sanitizer.ts retry path. Exposed here so the
 * wording stays in one place.
 */
export function buildProductionContextPrefix(): string {
  return 'Professional film production context; fictional characters and situations; for educational and creative production use only. '
}

/**
 * Return the full rules table (for docs / debugging).
 */
export function getSafetyRules(): readonly SafetyRule[] {
  return SAFETY_RULES
}

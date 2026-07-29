/**
 * Event density firewall — P2 from seedance-optimizations checklist.
 *
 * Source: Seedance 2.0 event-density.md. Core idea: a single shot
 * should do one thing; overloading it with multiple independent events
 * (moves + actions + lighting shifts) makes the AI model produce muddy
 * or incoherent output.
 *
 * This module counts events in a video_prompt and classifies density
 * as low / medium / high. The classification is rule-based — fast,
 * deterministic, no LLM cost on the save hot path. We rely on the
 * storyboard_breaker agent to react to the high-density warning by
 * splitting its output across multiple storyboards when necessary.
 *
 * Heuristic:
 *   - Split the prompt by major sentence/clause separators (`.` `。` `;` `；`)
 *   - Each segment counts as one event if it contains any of:
 *       - Camera move keywords (push / pull / pan / track / dolly /
 *         crane / zoom / 推 / 拉 / 摇 / 移 / 升 / 降 / 跟)
 *       - Action verbs (walks / runs / opens / 转身 / 坐下 / 站起 …)
 *       - Lighting / mood keywords (light shifts, color shifts)
 *       - A segment longer than 60 characters (implicit density)
 *   - Add bonus events for explicit chaining markers
 *     (then / after / 然后 / 接着 / 随后 / and / and then)
 *   - Threshold:
 *       1-2 events  → low
 *       3-4 events  → medium
 *       5+  events  → high
 */

export type EventDensity = 'low' | 'medium' | 'high'

export interface EventValidationResult {
  density: EventDensity
  events: string[]
  suggestion: string | null
}

// Keep these keyword sets short and high-signal. False positives are
// worse than false negatives here — we only flag things that are
// actually likely to be independent events.
const CAMERA_MOVE_KEYWORDS = [
  // English
  'push-in', 'push in', 'pull-back', 'pull back', 'dolly in', 'dolly out',
  'pan left', 'pan right', 'tilt up', 'tilt down', 'crane up', 'crane down',
  'tracking shot', 'follow shot', 'arc shot', 'whip pan', 'zoom in', 'zoom out',
  'steadicam', 'handheld', 'crash zoom',
  // Chinese
  '推进', '推近', '推镜', '后拉', '拉远', '拉镜', '横摇', '俯仰', '升降',
  '跟拍', '弧线', '急速横摇', '环绕', '变焦', '手持', '无人机',
]

const ACTION_KEYWORDS = [
  // English (short verb forms; full Phrase-level actions are caught by
  // segment-length heuristic below)
  'walks', 'runs', 'opens', 'closes', 'turns', 'sits', 'stands', 'grabs',
  'drops', 'pushes', 'pulls', 'picks up', 'puts down', 'looks', 'whispers',
  'shouts', 'laughs', 'cries', 'fights', 'kisses', 'hugs', 'enters', 'exits',
  // Chinese
  '走', '跑', '打开', '关闭', '转身', '坐下', '站起', '拿起', '放下',
  '看', '低语', '喊', '笑', '哭', '打', '吻', '抱', '进入', '离开',
]

const LIGHTING_MOOD_KEYWORDS = [
  // English
  'light shifts', 'lighting shifts', 'shadow shifts', 'color shifts',
  'day to night', 'night to day', 'sunrise', 'sunset', 'flicker',
  'highlight', 'spotlight', 'glow',
  // Chinese
  '光线变化', '光影变化', '阴影变化', '色彩变化', '日夜转换', '日出',
  '日落', '闪烁', '高光', '聚光',
]

const CHAINING_KEYWORDS = [
  // English
  'then', 'and then', 'after that', 'afterwards', 'next', 'subsequently',
  'while', 'simultaneously',
  // Chinese
  '然后', '接着', '随后', '之后', '紧接着', '同时', '一边', '另一边',
]

interface SegmentedEvent {
  index: number
  kind: 'camera' | 'action' | 'mood' | 'chain' | 'implicit'
  text: string
  keyword?: string
}

function findFirstKeyword(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw
  }
  return null
}

function classifySegment(segment: string): { kind: SegmentedEvent['kind']; keyword?: string } {
  const trimmed = segment.trim()
  if (!trimmed) return { kind: 'implicit' }
  if (findFirstKeyword(trimmed, CAMERA_MOVE_KEYWORDS)) {
    return { kind: 'camera', keyword: findFirstKeyword(trimmed, CAMERA_MOVE_KEYWORDS) ?? undefined }
  }
  if (findFirstKeyword(trimmed, ACTION_KEYWORDS)) {
    return { kind: 'action', keyword: findFirstKeyword(trimmed, ACTION_KEYWORDS) ?? undefined }
  }
  if (findFirstKeyword(trimmed, LIGHTING_MOOD_KEYWORDS)) {
    return { kind: 'mood', keyword: findFirstKeyword(trimmed, LIGHTING_MOOD_KEYWORDS) ?? undefined }
  }
  // Long segments without an explicit marker are still considered events
  // — they describe a discrete visual beat.
  if (trimmed.length >= 60) return { kind: 'implicit' }
  // Anything else: short framing / filler — not an event
  return { kind: 'implicit' }
}

/**
 * Validate event density of a video_prompt. Pure function — no side
 * effects, no I/O. Cheap (single string scan) so it's safe to call on
 * every save.
 */
export function validateEventDensity(videoPrompt: string): EventValidationResult {
  if (!videoPrompt || !videoPrompt.trim()) {
    return { density: 'low', events: [], suggestion: null }
  }

  // 1. Split into segments by major separators.
  const segments = videoPrompt
    .split(/[.。;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // 2. Classify each segment.
  const classified: SegmentedEvent[] = segments.map((seg, i) => {
    const { kind, keyword } = classifySegment(seg)
    return { index: i, kind, text: seg, keyword }
  })

  // 3. Count chaining markers across the whole prompt.
  const chainHits: string[] = []
  for (const kw of CHAINING_KEYWORDS) {
    // Use a simple case-insensitive substring scan with a word-ish
    // boundary so we don't double-count overlapping words.
    const re = new RegExp(`(?<![A-Za-z0-9_])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'gi')
    const matches = videoPrompt.match(re)
    if (matches) chainHits.push(...matches)
  }

  // 4. Build the events list — only meaningful events (not implicit noise).
  // Implicit-kind short framing segments are dropped; long implicit ones
  // are kept (they describe a beat).
  const events: string[] = []
  for (const ev of classified) {
    if (ev.kind === 'camera' || ev.kind === 'action' || ev.kind === 'mood') {
      events.push(ev.text.length > 80 ? ev.text.slice(0, 80) + '…' : ev.text)
    } else if (ev.kind === 'implicit' && ev.text.length >= 60) {
      events.push(ev.text.length > 80 ? ev.text.slice(0, 80) + '…' : ev.text)
    }
  }

  // 5. Add chaining markers as separate compact events.
  // We cap chaining events at 3 to avoid inflating density when the prompt
  // legitimately has many conjunctions inside a single shot.
  events.push(
    ...chainHits.slice(0, 3).map((c) => `…${c.trim()}…`)
  )

  const count = events.length
  let density: EventDensity
  let suggestion: string | null = null
  if (count >= 5) {
    density = 'high'
    suggestion = `检测到 ${count} 个独立事件。建议拆分到 2-3 个分镜，每个 1-2 个事件。`
  } else if (count >= 3) {
    density = 'medium'
    suggestion = `检测到 ${count} 个事件。可以接受，但建议合并部分动作或运镜。`
  } else {
    density = 'low'
  }

  return { density, events, suggestion }
}

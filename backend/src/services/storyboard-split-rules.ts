/**
 * ★ Sprint 47 T7 (PM msg-20261115-188): 拆镜的【纯逻辑】(不碰 DB → 可离线断言)
 *
 *   台词/画面描述的语义切分 + 两镜时长分配 + 要不要拆的判定。DB 那一半在 services/storyboard-split.ts。
 */
import { computeEffectiveDialogueFloor, countDialogueChars } from '../constants/shot-type-baseline.js'

/** ★ PM D1: 单镜时长上限 12 秒 */
export const SPLIT_MAX_DURATION = 12

export interface SplitPart {
  description: string
  action: string
  result: string
  atmosphere: string
  dialogue: string
}

/**
 * ★ 规则兜底: 把台词按预算切成两半 (不切在句子中间)。
 *   · 优先按【说话人换行】切 (每行 = 一个角色的一句话 → 天然是语义边界)
 *   · 单行太长 → 再按句末标点 (。！？) 切
 * @returns null = 切不动 (只有一行且没有句末标点)
 */
export function splitDialogueByBudget(dialogue: string, maxChars: number): { first: string; second: string } | null {
  const lines = String(dialogue || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  if (lines.length === 1) return splitLongLine(lines[0], maxChars)
  const first: string[] = []
  const rest: string[] = []
  let acc = 0
  for (const line of lines) {
    const len = countDialogueChars(line)
    if (rest.length === 0 && (first.length === 0 || acc + len <= maxChars)) {
      first.push(line)
      acc += len
      continue
    }
    rest.push(line)
  }
  if (!rest.length) return null
  return { first: first.join('\n'), second: rest.join('\n') }
}

/** 单行太长 → 在句末标点处切 (切在句子之间, 不切句子中间) */
function splitLongLine(line: string, maxChars: number): { first: string; second: string } | null {
  const sentences = line.split(/(?<=[。！？!?…；;])/).map((s) => s.trim()).filter(Boolean)
  if (sentences.length < 2) return null
  const first: string[] = []
  const rest: string[] = []
  let acc = 0
  for (const s of sentences) {
    const len = countDialogueChars(s)
    if (rest.length === 0 && (first.length === 0 || acc + len <= maxChars)) {
      first.push(s)
      acc += len
      continue
    }
    rest.push(s)
  }
  if (!rest.length) return null
  return { first: first.join(''), second: rest.join('') }
}

/** ★ 规则兜底: 画面描述按句号切 (第二镜加「（承上）」标出承接关系) */
export function splitTextByBudget(text: string, maxChars: number): { first: string; second: string } {
  const t = String(text || '').trim()
  if (!t) return { first: '', second: '' }
  const sentences = t.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
  if (sentences.length < 2) {
    // 没有句号 → 第二镜承上, 画面描述复制一份 (宁可重复也不要凭空编)
    return { first: t, second: `（承上）${t}` }
  }
  const first: string[] = []
  const rest: string[] = []
  let acc = 0
  for (const s of sentences) {
    const len = countDialogueChars(s)
    if (rest.length === 0 && (first.length === 0 || acc + len <= maxChars)) {
      first.push(s)
      acc += len
      continue
    }
    rest.push(s)
  }
  if (!rest.length) return { first: t, second: `（承上）${t}` }
  return { first: first.join(''), second: `（承上）${rest.join('')}` }
}

/**
 * ★ 两镜的时长分配 (纯函数):
 *   每镜 = max(自己那半的台词 floor, 按字数比例分配的时长), 且 ≤ SPLIT_MAX_DURATION
 *   ★ 总时长 ≈ 拆前 (台词 floor 兜底时会略长 —— 宁可长也不裁台词)
 */
export function computeSplitDurations(
  originalDuration: number,
  charsFirst: number,
  charsSecond: number,
): { durations: number[]; total: number; floorBound: boolean } {
  const floor1 = computeEffectiveDialogueFloor(charsFirst)
  const floor2 = computeEffectiveDialogueFloor(charsSecond)
  const totalChars = charsFirst + charsSecond
  const ratio = totalChars > 0 ? charsFirst / totalChars : 0.5
  let d1 = Math.max(floor1, Math.round(originalDuration * ratio))
  let d2 = Math.max(floor2, originalDuration - d1)
  const floorBound = d1 + d2 > originalDuration
  if (d1 > SPLIT_MAX_DURATION) d1 = SPLIT_MAX_DURATION
  if (d2 > SPLIT_MAX_DURATION) d2 = SPLIT_MAX_DURATION
  if (d2 < 1) d2 = 1
  return { durations: [d1, d2], total: d1 + d2, floorBound }
}

/**
 * ★ 这一镜要不要拆 (纯函数 → 可离线断言)。
 *   ★ 只在超长时拆: 不超 12 秒的镜拆了会让画面节奏变碎 (工单硬要求)。
 */
export function shouldSplitShot(duration: number): boolean {
  return Number(duration ?? 0) > SPLIT_MAX_DURATION
}


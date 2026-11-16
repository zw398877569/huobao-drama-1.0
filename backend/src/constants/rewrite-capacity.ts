/**
 * ★ Sprint 48 T3 (PM msg-20261116-194): AI 改写阶段的【内容容量】(跟着集长走)
 *
 * 【为什么要有】
 *   现状: 改写 agent 完全不知道这一集要演多久 → 写多少算多少。
 *   ep21 目标 100 秒, 却写出 1044 字 = 232 秒纯对白 (是目标的 2.3 倍) → 拆解阶段装不下 → 截台词。
 *   ★ 目标时长来源必须与拆解阶段【同一个】(用户手设的优先, 否则自动估算) → 用 getEpisodeTargetSeconds。
 *
 * 【换算口径】
 *   · 字数上限 = 目标秒数 × CHINESE_SPEECH_RATE(4.5 字/秒, 项目现成常量) × DIALOGUE_SHARE(0.7)
 *     → 台词最多占成片 70% 的时间, 其余留给动作/空镜/转场
 *   · 场景时长区间 = 目标 ÷ 6 ~ 目标 ÷ 3 (夹在 [15,90] 秒)
 *   · 场景个数 = 目标 ÷ 场景时长 (100 秒 → 3~6 个, 与老口径一致)
 *   · 冲突密度 = 每 clamp(目标÷6, 20, 45) 秒一个小冲突 (集越长, 冲突间隔可以稍宽)
 */
import { CHINESE_SPEECH_RATE } from './shot-type-baseline.js'

/** 台词最多占成片时长的比例 (其余留给动作/空镜/转场) */
export const DIALOGUE_SHARE = 0.7

export interface RewriteCapacity {
  /** 本集目标秒数 */
  targetSeconds: number
  /** 对白字数上限 */
  dialogueCharCap: number
  /** 每个场景的秒数区间 */
  sceneSecondsMin: number
  sceneSecondsMax: number
  /** 场景个数区间 */
  sceneCountMin: number
  sceneCountMax: number
  /** 冲突密度: 每多少秒一个小冲突 */
  conflictIntervalSec: number
}

/** ★ 按目标时长算出改写阶段的内容容量 (纯函数 → 可离线断言) */
export function computeRewriteCapacity(targetSeconds: number): RewriteCapacity {
  const t = Math.max(15, Math.round(Number(targetSeconds) || 100))
  const dialogueCharCap = Math.floor(t * CHINESE_SPEECH_RATE * DIALOGUE_SHARE)
  const sceneSecondsMax = Math.min(90, Math.max(30, Math.round(t / 3)))
  const sceneSecondsMin = Math.min(sceneSecondsMax, Math.max(15, Math.round(t / 6)))
  // ★ 场景数: 最少要 ceil(t/每场上限) 个才【装得下】目标时长; 最多 floor(t/每场下限) 个才不会超
  const sceneCountMin = Math.max(2, Math.ceil(t / sceneSecondsMax))
  const sceneCountMax = Math.max(sceneCountMin, Math.min(8, Math.floor(t / sceneSecondsMin)))
  const conflictIntervalSec = Math.min(45, Math.max(20, Math.round(t / 6)))
  return {
    targetSeconds: t,
    dialogueCharCap,
    sceneSecondsMin,
    sceneSecondsMax,
    sceneCountMin,
    sceneCountMax,
    conflictIntervalSec,
  }
}

/**
 * ★ 渲染成给改写 agent 看的约束块 (直接进 prompt)。
 */
export function formatRewriteCapacity(cap: RewriteCapacity): string {
  return `【★ 本集容量约束 (按本集目标时长 ${cap.targetSeconds} 秒折算, 必须遵守)】
- 对白总字数 ≤ ${cap.dialogueCharCap} 字 (≈ ${cap.dialogueCharCap / CHINESE_SPEECH_RATE | 0} 秒纯对白; 台词最多占成片 ${Math.round(DIALOGUE_SHARE * 100)}%)
  ★ 超出这个字数 → 后面【拆解】时装不下, 会被迫截台词 (用户听成片会觉得"台词少了很多")
- 场景个数 ${cap.sceneCountMin}-${cap.sceneCountMax} 个; 每个场景 ${cap.sceneSecondsMin}-${cap.sceneSecondsMax} 秒
- 冲突密度: 每 ${cap.conflictIntervalSec} 秒至少 1 个"小冲突"(对撞/打断/反转)
- ★ 上述数字由【本集目标时长】折算而来 (不是写死的) —— 集长变了, 密度跟着走`
}

/**
 * ★ 算一版剧本的对白字数 (给自检用): 只数"角色：台词"形式的行。
 */
export function countScriptDialogueChars(script: string): number {
  let n = 0
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^([^：:]{1,12})\s*[：:]\s*(.+)$/)
    if (!m) continue
    n += m[2].replace(/[（(].+?[)）]/g, '').replace(/[\s　]/g, '').length
  }
  return n
}

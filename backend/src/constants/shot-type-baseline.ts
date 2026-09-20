/**
 * 分镜粒度常量 — Phase 2 (msg-20260920-003)
 *
 * 把时长决策所有硬编码值集中到一处, 不混入业务逻辑.
 * 上游: agents/index.ts planner prompt (软引导) + agents/tools/storyboard-tools.ts (硬约束)
 *
 * 设计原则:
 *   - 越近的镜头反而越短 (情绪密度高, 短才打)
 *   - 密度是系数 (scale) 不是区间 (range), 跟 baseline 相乘
 *   - dialogueFloor 防 8 字塞 11.7s 这种空转
 *   - 运镜速度也是系数 (运镜快=信息密度高=时长短)
 */

// ── 景别 baseline 表 ────────────────────────────────────────
// 7 档常用景别, 跟 agents/index.ts planner prompt P2 措辞同步
// 超出表的 shotType (例如 "鸟瞰") → getBaselineFor() 用 MS fallback
export const SHOT_TYPE_BASELINE: Record<string, { min: number; max: number }> = {
  ECU_大特写: { min: 2, max: 3 },
  CU_特写:    { min: 3, max: 4 },
  MS_近景:    { min: 4, max: 5 },
  MLS_中景:   { min: 5, max: 6 },
  MLS_中全景: { min: 6, max: 8 },
  WS_全景:    { min: 7, max: 9 },
  WS_远景:    { min: 8, max: 10 },
}

// fallback: shotType 不在表里 (例如 "鸟瞰"/"主观"/"空镜") → 用 MS 4-5s
export const FALLBACK_BASELINE = SHOT_TYPE_BASELINE.MS_近景

export function getBaselineFor(shotType: string): { min: number; max: number } {
  return SHOT_TYPE_BASELINE[shotType] || FALLBACK_BASELINE
}

// ── 密度系数 (scale, 不是 range) ─────────────────────────────
// 跟 agents/director-intent-templates.ts 8 套模板的 durationCoefficient 字段同步
// low=1.2 (铺垫/余韵/悬念, 给时长) / high=0.6 (反转/高潮/情感爆发, 压缩)
export const DENSITY_SCALE: Record<'low' | 'medium' | 'high', number> = {
  low: 1.2,
  medium: 1.0,
  high: 0.6,
}

export const FALLBACK_DENSITY_SCALE = DENSITY_SCALE.medium

export function getDensityScale(density: string | undefined): number {
  if (density === 'low' || density === 'medium' || density === 'high') {
    return DENSITY_SCALE[density]
  }
  return FALLBACK_DENSITY_SCALE
}

// ── 运镜速度系数 (O1 修复: UI 摆设 → 第 4 因子) ──────────────
// 跟 agents/index.ts planner prompt factor-4 同步
export const MOVE_SCALE: Record<string, number> = {
  快速: 0.7,
  固定: 1.0,
  缓慢: 1.3,
}

export const FALLBACK_MOVE_SCALE = MOVE_SCALE.固定

export function getMoveScale(movement: string | undefined): number {
  return MOVE_SCALE[movement || ''] ?? FALLBACK_MOVE_SCALE
}

// ── 对白下限 (中文 4.5 字/秒 常识) ──────────────────────────
export const CHINESE_SPEECH_RATE = 4.5  // 字/秒
export const DIALOGUE_FLOOR_BASE = 1    // floor 公式里的 +1 余量

export function computeDialogueFloor(dialogueChars: number): number {
  if (!dialogueChars || dialogueChars <= 0) return 0
  return Math.ceil(dialogueChars / CHINESE_SPEECH_RATE) + DIALOGUE_FLOOR_BASE
}

// ── 短对白压缩规则 (P3) ────────────────────────────────────
export const SHORT_DIALOGUE_THRESHOLD = 10  // 字
export const SHORT_DIALOGUE_MAX = 8          // 秒

// ── 视频 API 硬约束 ─────────────────────────────────────────
export const VIDEO_MIN_DURATION = 4  // H3 模型硬约束下限
export const VIDEO_MAX_DURATION = 15 // H3 模型硬约束上限

// ── 钩子空间 (O3) ───────────────────────────────────────────
export const HOOK_OPENING_MIN = 3       // 开场镜 idx=0 最小时长
export const HOOK_CLOSING_MIN = 8       // 结尾镜最小时长
export const HOOK_CLIFFHANGER_MIN = 10  // 结尾镜且 cliffhanger 时最小时长
// 戏剧目的标签里命中这些字符串算 cliffhanger (由 scene-classifier 复用)
// 但现在 scene-classifier 还是 Phase 3 的事, 这里只放常量
export const CLIFFHANGER_TAGS = ['悬念'] as const

// ── 场景切换过渡开销 (O2) ────────────────────────────────────
export const SCENE_TRANSITION_BONUS = 0.5  // isFirstInScene 镜头 +0.5s

// ── Σ 收敛 (Phase 2 C, 默认参数) ─────────────────────────────
export const DEFAULT_EPISODE_TARGET_SECONDS = 100  // AI 漫剧主流时长 (B3 调研 240 样本 P50=100s)
export const EPISODE_TARGET_TOLERANCE = 1.1       // Σ 允许超过 target × 1.1 才缩放

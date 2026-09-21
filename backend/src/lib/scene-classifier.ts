/**
 * PM 派单 msg-20260920-004 Step 2.F: climax 3 路投票识别
 *
 * 3 路投票权重 (派单 three_signals):
 *   - primary_string_match (0.6): scene.intention.function 命中 CLIMAX_TAGS / CLIFFHANGER_TAGS
 *   - secondary_position (0.25): scene 在 episode 时间轴后 30% → +climax_score
 *   - tertiary_conflict_words (0.15): scene.prompt (代 description) 含冲突关键词 → +climax_score
 *
 * Voting logic (派单):
 *   - climaxScore ≥ 0.5 → climax
 *   - cliffhangerScore ≥ 0.3 且 scene 是 episode 最后一镜 → cliffhanger
 *   - climax 优先于 cliffhanger
 *   - 否则 normal
 *
 * 数据 layout 适配 (PM 派单假设 vs schema 实际):
 *   PM 派单假设 scene.intention.function + scene.description 字段, 实际:
 *   - intention 不在 scenes 表, 是 runtime 分析 (scene-intention.ts 跑 AI 拿),
 *     历史结果存 storyboards.sceneIntention JSON
 *   - scenes 表没 description 字段, scene.prompt 实际承担 description 语义角色
 *     (storyboard-tools.ts:227 description: scene.prompt)
 *   解耦: EpisodeSceneData = Scene & { intentionFunction?: DramaticFunctionKey }
 *   caller 负责组装 intentionFunction 字段 (从 storyboard.sceneIntention JSON 解析).
 *
 * Acceptance (派单 after_F_classifier):
 *   - scene.intention.function = '高潮' → climax ✓
 *   - scene.intention.function = '铺垫' 且在 episode 后 30% → climax (结构位置兜底)
 *   - scene.intention.function = '铺垫' 且在 episode 前 30% → normal
 */

import { schema } from '../db'
import type { DramaticFunctionKey } from '../agents/director-intent-templates'

export type Scene = typeof schema.scenes.$inferSelect
export type SceneTag = 'climax' | 'cliffhanger' | 'normal'

/**
 * Enriched scene data for classification. Caller assembles runtime fields
 * not present in scenes table (intention.function lives on storyboards.sceneIntention JSON).
 */
export type EpisodeSceneData = Scene & {
  /** Result from scene-intention agent, e.g. '高潮' | '对峙' | '反转' | '揭露' | '情感爆发' | '铺垫' | '悬念' */
  intentionFunction?: DramaticFunctionKey
}

/**
 * Episode position context for 3-vote signal.
 * Caller computes sceneIndex/sceneCount from episode scenes array.
 */
export interface EpisodePositionContext {
  /** Index of this scene in episode scenes array (0-based) */
  sceneIndex: number
  /** Total scenes in episode */
  sceneCount: number
}

// 3 路投票权重
const WEIGHT_PRIMARY = 0.6
const WEIGHT_SECONDARY = 0.25
const WEIGHT_TERTIARY = 0.15

// Climax tags — 跟 episode-duration-estimator.ts CLIMAX_TAGS 保持一致
// (PM 派单 task_F primary_string_match.CLIMAX_TAGS)
const CLIMAX_TAGS: ReadonlyArray<DramaticFunctionKey> = [
  '高潮',
  '对峙',
  '反转',
  '揭露',
  '情感爆发',
]

// Cliffhanger tags
const CLIFFHANGER_TAGS: ReadonlyArray<DramaticFunctionKey> = ['悬念']

// Tertiary conflict words (PM 派单: 12+ 个冲突关键词)
// 中文短剧常见冲突/高潮暗示词, 扫 scene.prompt 触发 climax_score
const CONFLICT_WORDS: ReadonlyArray<string> = [
  '打', '撞', '死', '杀', '怒', '对峙',
  '挣扎', '流血', '破碎', '撕裂', '崩溃',
  '破裂', '爆炸', '崩塌', '失控', '爆发',
]

// 阈值
const CLIMAX_THRESHOLD = 0.5
const CLIFFHANGER_THRESHOLD = 0.3
const LAST_THIRD_RATIO = 0.7

/**
 * Classify a scene as 'climax' | 'cliffhanger' | 'normal' via 3-vote signal.
 *
 * @param scene - Scene to classify (can include intentionFunction from runtime)
 * @param episodeContext - Optional position context for vote 2 (sceneIndex, sceneCount)
 * @returns SceneTag
 */
export function classifyScene(
  scene: EpisodeSceneData,
  episodeContext?: EpisodePositionContext,
): SceneTag {
  let climaxScore = 0
  let cliffhangerScore = 0

  // Vote 1: primary string match (weight 0.6) — intention.function 命中
  if (scene.intentionFunction !== undefined) {
    if (CLIMAX_TAGS.includes(scene.intentionFunction)) {
      climaxScore += WEIGHT_PRIMARY
    }
    if (CLIFFHANGER_TAGS.includes(scene.intentionFunction)) {
      cliffhangerScore += WEIGHT_PRIMARY
    }
  }

  // Vote 2: secondary position (weight 0.25) — 后 30% 位置
  if (episodeContext !== undefined && episodeContext.sceneCount > 0) {
    const isLastThird =
      episodeContext.sceneIndex >= Math.floor(episodeContext.sceneCount * LAST_THIRD_RATIO)
    if (isLastThird) climaxScore += WEIGHT_SECONDARY
  }

  // Vote 3: tertiary conflict words (weight 0.15) — scene.prompt 含冲突词
  const prompt = scene.prompt ?? ''
  if (typeof prompt === 'string' && CONFLICT_WORDS.some(w => prompt.includes(w))) {
    climaxScore += WEIGHT_TERTIARY
  }

  // Voting logic (派单): climax 优先于 cliffhanger, 否则 normal
  if (climaxScore >= CLIMAX_THRESHOLD) return 'climax'
  const isLastScene =
    episodeContext !== undefined &&
    episodeContext.sceneCount > 0 &&
    episodeContext.sceneIndex === episodeContext.sceneCount - 1
  if (cliffhangerScore >= CLIFFHANGER_THRESHOLD && isLastScene) return 'cliffhanger'
  return 'normal'
}

/**
 * Batch classify all scenes in an episode.
 * Convenience helper — calls classifyScene per scene with position context.
 *
 * @param scenes - Episode scenes in chronological order
 * @returns Array of SceneTag aligned with scenes array (same length, same order)
 */
export function classifyEpisodeScenes(
  scenes: EpisodeSceneData[],
): SceneTag[] {
  return scenes.map((scene, idx) =>
    classifyScene(scene, { sceneIndex: idx, sceneCount: scenes.length }),
  )
}

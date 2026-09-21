/**
 * PM 派单 msg-20260920-004 Step 2.C: 4 因子估算 episode 目标时长
 *
 * 公式 (PM 派单 factor_sources):
 *   - 剧情模式 base: 短 80 / 中 140 / 长 240 / 深度 480, 缺字段 → 100
 *   - scene transition overhead: scenes.length × 0.5
 *   - dialogue weight: sum(scenes.dialogue.length) × 0.05 (中文 4.5 字/秒 + 余量)
 *   - climax bonus: 命中 CLIMAX_TAGS 的 scene 数 ≥ 1 → target × 1.2
 *   - episode position penalty: 末集 (drama.episodes 索引后 30%) → target × 0.9
 *   - return range clamp: [60, 240]
 *
 * 数据 layout 适配 (PM 派单假设 vs schema 实际):
 *   PM 派单假设 scenes 有 dialogue + intention.function 字段, 实际:
 *   - dialogue 在 storyboards 表 (每个分镜一个), 不在 scenes
 *   - intention.function 是 runtime 分析 (scene-intention.ts 跑 AI 拿), 不是 db 字段
 *   解耦: EpisodeSceneData 接受 partial enriched scenes, 调用方负责组装.
 *   Step 3.D 接入时负责:
 *     - dialogue: 从 storyboards 聚合 (sum of dialogue per sceneId)
 *     - intentionFunction: 跑 sceneIntention agent 或从 storyboard.sceneIntention 读
 */

import { schema } from '../db'
import type { DramaticFunctionKey } from '../agents/director-intent-templates'

export type Episode = typeof schema.episodes.$inferSelect
export type Scene = typeof schema.scenes.$inferSelect

/**
 * Enriched scene data for estimation. Caller assembles runtime fields
 * not present in scenes table (dialogue lives on storyboards; intention.function
 * is computed by scene-intention agent).
 */
export type EpisodeSceneData = Scene & {
  /** Aggregated dialogue across all storyboards in this scene */
  dialogue?: string
  /** Result from scene-intention agent, e.g. '高潮' | '对峙' | '反转' | '情感爆发' */
  intentionFunction?: DramaticFunctionKey
}

/**
 * 剧情模式 base 系数 (PM 派单 D1 锁定 100s 默认, 4 档常量保留供 Step 4 UI 选择)
 */
export const MODE_BASE: Record<'短' | '中' | '长' | '深度', number> = {
  '短': 80,
  '中': 140,
  '长': 240,
  '深度': 480,
}
export const MODE_BASE_FALLBACK = 100

/**
 * Climax tags — 命中任一即视为高潮/情感密集 scene
 * 跟 director-intent-templates.ts 8 个戏剧功能对齐 (CLIMAX_TAGS 子集)
 */
export const CLIMAX_TAGS: ReadonlyArray<DramaticFunctionKey> = [
  '高潮',
  '对峙',
  '反转',
  '情感爆发',
]

/**
 * Episode position 阈值 (派单: 后 30% 算末集, × 0.9)
 */
const LAST_THIRD_RATIO = 0.7

/**
 * Estimate episode target duration in seconds.
 *
 * @param episodeId - 目标 episode 的 id
 * @param episodes - drama 所有 episodes (用来算 episode position — drama 内索引)
 * @param scenes - episode 的 scenes (caller 负责组装 dialogue/intentionFunction 字段)
 * @returns target seconds, clamped [60, 240]
 */
export function estimateTargetDuration(
  episodeId: number,
  episodes: Episode[],
  scenes: EpisodeSceneData[],
): number {
  // 1. 剧情模式 base (派单说 drama_type 字段代理, 实际 schema 无 → fallback 100)
  // TODO Step 4: 接 episodes.dramaType 字段 (UI 加完后用真实 base)
  const base = MODE_BASE_FALLBACK

  // 2. Scene transition overhead (派单: scenes.length × 0.5)
  const sceneOverhead = scenes.length * 0.5

  // 3. Dialogue weight (中文 4.5 字/秒 + 余量 → 0.05/字)
  //    派单说 sum(scenes.dialogue.length) × 0.05, 实际数据从 storyboard 聚合由 caller 填到 s.dialogue
  const dialogueChars = scenes.reduce(
    (sum, s) => sum + (s.dialogue?.length ?? 0),
    0,
  )
  const dialogueWeight = dialogueChars * 0.05

  // 4. Climax bonus: 命中 CLIMAX_TAGS的 scene 数 ≥ 1 → × 1.2
  const climaxSceneCount = scenes.filter(
    s => s.intentionFunction !== undefined && CLIMAX_TAGS.includes(s.intentionFunction),
  ).length
  const climaxMultiplier = climaxSceneCount >= 1 ? 1.2 : 1.0

  // 5. Episode position penalty: 末集 (drama 内索引后 30%) → × 0.9
  const targetEpisode = episodes.find(e => e.id === episodeId)
  const targetDramaId = targetEpisode?.dramaId ?? null
  const dramaEpisodes = targetDramaId === null
    ? []
    : episodes
        .filter(e => e.dramaId === targetDramaId)
        .sort((a, b) => a.episodeNumber - b.episodeNumber)
  const episodeIdx = dramaEpisodes.findIndex(e => e.id === episodeId)
  const isLastThird = episodeIdx >= Math.floor(dramaEpisodes.length * LAST_THIRD_RATIO)
  const positionMultiplier = isLastThird ? 0.9 : 1.0

  // 合计 + clamp [60, 240]
  const raw = (base + sceneOverhead + dialogueWeight) * climaxMultiplier * positionMultiplier
  return Math.max(60, Math.min(240, Math.round(raw)))
}

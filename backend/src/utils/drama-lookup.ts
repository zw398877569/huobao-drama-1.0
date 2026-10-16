/**
 * dramaId 反查 helper — Sprint 045 QA msg-20261016-068
 *
 * 背景: video_generations.dramaId 历史 158 条里 80 条 (50.6%) 为 null。
 *   根因是调用方都"偷懒"没传 dramaId:
 *     (1) batch-video-scheduler.ts 显式传 dramaId: undefined (注释写"storyboard 已带 episodeId",
 *         但 generateVideo 是直接把 params.dramaId 写进 DB, 不会自己反查)
 *     (2) routes/videos.ts 只用 body.drama_id, 前端不传就是 undefined
 *   → 正式分镜流 (source='storyboard') 的记录追溯不到所属剧集。
 *
 * 本模块提供两条反查链路, 供 batch-scheduler 和 routes/videos 共用, 避免各处重复写 join。
 *
 * ⚠️ 自由创作 (source='free') 天然没有 dramaId —— free creation 是脱离剧集的独立创作,
 *   调用方 (frontend/app/components/FreeCreationPanel.vue) 不传 storyboard_id 也不传 drama_id。
 *   所以【绝不能】给 video_generations.dramaId 加 notNull 约束 (会把自由创作功能打死),
 *   详见 QA msg-20261016-068 核实结论。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/**
 * 从 storyboardId 反查 dramaId (storyboard → episode → drama 两跳)。
 *
 * @returns dramaId; 查不到 (free 场景 storyboardId=null / 数据缺失) 返回 null
 */
export function lookupDramaIdByStoryboard(storyboardId: number | null | undefined): number | null {
  if (storyboardId == null || !Number.isInteger(storyboardId) || storyboardId <= 0) return null
  const [sb] = db.select({ episodeId: schema.storyboards.episodeId })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
    .all()
  if (!sb) return null
  return lookupDramaIdByEpisode(sb.episodeId)
}

/**
 * 从 episodeId 反查 dramaId (单跳)。
 *
 * @returns dramaId; episodeId 为空或查不到返回 null
 */
export function lookupDramaIdByEpisode(episodeId: number | null | undefined): number | null {
  if (episodeId == null || !Number.isInteger(episodeId) || episodeId <= 0) return null
  const [ep] = db.select({ dramaId: schema.episodes.dramaId })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .all()
  return ep?.dramaId ?? null
}

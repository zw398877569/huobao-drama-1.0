/**
 * ★ Sprint 47 单 189 (PM msg-20261115-189): 给【已有剧集】补齐本镜剧情目的 (dramatic_function)
 *
 * 【为什么需要】
 *   V4 planner 每镜本来就产出 intent_function (铺垫/揭露/反转/高潮/余韵/悬念/对峙/情感爆发),
 *   但存库时被丢掉了 → 情绪推断的最高优先级(剧情目的)永远拿不到数据 →
 *   "同一角色在铺垫和高潮两种剧情目的下情绪应不同" 这条验收标准跑不出来。
 *   新拆的剧集现在会直接落库 (见 storyboard-planner-service.ts); 已有剧集要补齐。
 *
 * 【补齐来源 (零 LLM 成本)]
 *   episodes.planning_data 里留着 planner 的 step1_plan / step2_details —— 每镜都有 intent_function
 *   → 直接按 shot_number 映射回 storyboard 即可, 不用重新调模型, 也不用重跑拆解。
 *
 * 【没有 planning_data 的老剧集]
 *   → 这条路走不通, 只能退回已有的 per-shot LLM 意图分析 (POST /storyboards/:id/analyze-intention),
 *     它写的是 scene_intention; 情绪推断那边 scene_intention 是兜底来源 → 也能命中。
 *     (回执里会写清楚代价: 每镜一次 LLM 调用)
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

export interface BackfillItem {
  storyboardId: number
  storyboardNumber: number
  dramaticFunction: string | null
  written: boolean
}

export interface BackfillResult {
  episodeId: number
  /** 数据来源: planning_data (零成本) / none (需要 LLM 分析兜底) */
  source: 'planning_data' | 'none'
  /** 写入了几镜 */
  updated: number
  /** 已有值跳过了几镜 */
  skipped: number
  /** 找不到对应 intent_function 的镜数 */
  missing: number
  items: BackfillItem[]
}

import { extractIntentMap } from './dramatic-function-utils.js'

/**
 * 给一集的所有分镜补齐 dramatic_function。
 * @param overwrite 已写过的要不要覆盖 (默认 false → 只补空的)
 */
export function backfillEpisodeDramaticFunction(
  episodeId: number,
  opts: { overwrite?: boolean } = {},
): BackfillResult {
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) {
    return { episodeId, source: 'none', updated: 0, skipped: 0, missing: 0, items: [] }
  }
  const intentMap = extractIntentMap(episode.planningData as string | null)
  const storyboards = db.select({
    id: schema.storyboards.id,
    storyboardNumber: schema.storyboards.storyboardNumber,
    dramaticFunction: schema.storyboards.dramaticFunction,
  })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const items: BackfillItem[] = []
  let updated = 0
  let skipped = 0
  let missing = 0

  for (const sb of storyboards) {
    const fn = intentMap.get(Number(sb.storyboardNumber)) || null
    if (!fn) {
      missing++
      items.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, dramaticFunction: null, written: false })
      continue
    }
    if (sb.dramaticFunction && !opts.overwrite) {
      skipped++
      items.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, dramaticFunction: sb.dramaticFunction, written: false })
      continue
    }
    db.update(schema.storyboards)
      .set({ dramaticFunction: fn, updatedAt: new Date().toISOString() })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    updated++
    items.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, dramaticFunction: fn, written: true })
  }

  return {
    episodeId,
    source: intentMap.size ? 'planning_data' : 'none',
    updated,
    skipped,
    missing,
    items,
  }
}

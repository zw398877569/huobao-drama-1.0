/**
 * ★ Sprint 41 追加单 176 (PM msg-20261113-176): 定时计划【重复镜头】防护
 *
 * 【问题】同一个镜头被排进两个未完成的计划 → 到点时两个计划都会跑它 →
 *   【同一个镜头生成了两次, 钱扣了两次】, 而且两版可能还不一样 (模型有随机性)。
 *   库里已有真实案例: 镜 781 同时在计划 #12 与 #13 里 → video_generations 里有两条记录。
 *
 * 【口径】
 *   · "未完成" = status ∈ (pending, running)
 *   · done / failed / cancelled 【不算】→ 用户要能重跑一个失败的镜头, 不能把这条路堵死
 *   · 历史数据不清洗 (本单只防新建时的重复)
 */
import { db, schema } from '../db/index.js'
import { and, eq, inArray } from 'drizzle-orm'
import { logTaskWarn } from '../utils/task-logger.js'

/** 算作"未完成"的计划状态 (★ 与计划状态机对齐: pending / running) */
export const ACTIVE_PLAN_STATUSES = ['pending', 'running']

export interface PlanRow {
  id: number
  status?: string | null
  /** JSON array string */
  shotIds?: string | null
  scheduledAt?: string | null
}

export interface ShotConflict {
  shotId: number
  /** 占用它的计划 id */
  planId: number
  /** 那个计划的触发时间 */
  scheduledAt: string
}

/** 解析计划里的 shot_ids (JSON 字符串; 坏了就当空) */
export function parseShotIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * 纯函数: 找出【本次要排的镜头】里, 已经被【未完成计划】占用的那些。
 */
export function findShotConflicts(shotIds: number[], plans: PlanRow[]): ShotConflict[] {
  const wanted = new Set(shotIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))
  const conflicts: ShotConflict[] = []
  const seen = new Set<string>()
  for (const p of plans || []) {
    const st = p?.status
    if (!st || !ACTIVE_PLAN_STATUSES.includes(st)) continue      // ★ done/failed/cancelled 不算
    for (const id of parseShotIds(p?.shotIds)) {
      if (!wanted.has(id)) continue
      const key = `${p.id}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push({ shotId: id, planId: p.id, scheduledAt: p.scheduledAt || '' })
    }
  }
  return conflicts.sort((a, b) => a.shotId - b.shotId || a.planId - b.planId)
}

/** 时间格式化成人能看的 (本地时区; 解析不了就原样返回) */
export function formatPlanTime(scheduledAt: string | null | undefined): string {
  const s = String(scheduledAt || '')
  if (!s) return '未知时间'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 生成给用户看的拒绝信息 (★ 要具体到: 哪些镜头 / 属于哪条计划 / 什么时候触发)。
 * @param shotNoById storyboard id → 镜号 (有就显示镜号, 没有就退回 id)
 */
export function formatConflictMessage(
  conflicts: ShotConflict[],
  shotNoById?: Map<number, number> | Record<number, number>,
): string {
  if (!conflicts.length) return ''
  const noOf = (id: number): number | null => {
    if (!shotNoById) return null
    const v = shotNoById instanceof Map ? shotNoById.get(id) : shotNoById[id]
    return Number.isFinite(v as number) ? Number(v) : null
  }
  const items = conflicts.map((c) => {
    const no = noOf(c.shotId)
    const label = no != null ? `#${no}` : `#${c.shotId}`
    return `${label}(id=${c.shotId}) 已在计划 #${c.planId} (${formatPlanTime(c.scheduledAt)} 触发)`
  })
  return `这些镜头已经在未完成的定时计划里, 不能重复排入: ${items.join('; ')}`
}

/**
 * 查本集所有未完成计划里已占用的镜头 → 冲突列表 (查库版; 纯逻辑在上面的 findShotConflicts)。
 */
export function findEpisodeShotConflicts(episodeId: number, shotIds: number[]): ShotConflict[] {
  const plans = db.select({
    id: schema.batchVideoSchedules.id,
    status: schema.batchVideoSchedules.status,
    shotIds: schema.batchVideoSchedules.shotIds,
    scheduledAt: schema.batchVideoSchedules.scheduledAt,
  })
    .from(schema.batchVideoSchedules)
    .where(and(
      eq(schema.batchVideoSchedules.episodeId, episodeId),
      inArray(schema.batchVideoSchedules.status, ACTIVE_PLAN_STATUSES),
    ))
    .all()
  const conflicts = findShotConflicts(shotIds, plans)
  if (conflicts.length) {
    logTaskWarn('BatchVideoSchedule', 'duplicate-shot-guard', {
      episodeId,
      conflicts: conflicts.map(c => ({ shotId: c.shotId, planId: c.planId, scheduledAt: c.scheduledAt })),
      hint: '新建计划里有镜头已被未完成计划占用 → 已拒绝 (不新建计划记录)',
    })
  }
  return conflicts
}

/** 冲突镜头对应的 storyboard 镜号 (给错误信息用: #镜号 比 #id 好认) */
export function getShotNumbers(shotIds: number[]): Map<number, number> {
  const map = new Map<number, number>()
  if (!shotIds.length) return map
  try {
    const rows = db.select({
      id: schema.storyboards.id,
      storyboardNumber: schema.storyboards.storyboardNumber,
    })
      .from(schema.storyboards)
      .where(inArray(schema.storyboards.id, shotIds))
      .all()
    for (const r of rows) map.set(r.id, Number(r.storyboardNumber))
  } catch {
    /* 查不到就用 id 显示 */
  }
  return map
}

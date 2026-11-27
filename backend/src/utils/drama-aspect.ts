/**
 * ★ 单 msg-20261127-002 (竖屏链路): 剧集级画幅 (aspect ratio) 的唯一事实来源
 *
 * 存储: dramas.metadata (现成 TEXT 字段) 里存 JSON, 形如 {"aspect_ratio":"9:16"}
 * ★ 不改 DB schema; 没设置 / 16:9 → 行为与改动前完全一致 (默认 16:9)。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

/** 默认画幅 —— ★ 与改动前一致 (横屏 16:9) */
export const DEFAULT_DRAMA_ASPECT = '16:9'

/** 剧集画幅可选值 (前端创建/编辑剧集下拉用; 16:9 默认) */
export const DRAMA_ASPECT_OPTIONS = [
  '16:9',
  '9:16',
  '4:3',
  '3:2',
  '1:1',
  '2:3',
  '3:4',
  '4:5',
  '21:9',
] as const

export type DramaAspect = (typeof DRAMA_ASPECT_OPTIONS)[number]

/** 归一化: 只接受白名单里的值, 其它一律落默认 16:9 */
export function normalizeDramaAspect(raw: unknown): string {
  const v = String(raw ?? '').trim()
  return (DRAMA_ASPECT_OPTIONS as readonly string[]).includes(v) ? v : DEFAULT_DRAMA_ASPECT
}

/** dramas.metadata 可能是 JSON 字符串 / 对象 / null → 统一成对象 (解析失败 → {}) */
export function parseDramaMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, any>
  try {
    const j = JSON.parse(String(raw))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** metadata 对象 → 存库用的字符串 (对象直接 stringify; 字符串原样) */
export function stringifyDramaMetadata(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return null
  }
}

/** 读某个剧集的画幅 (读不到 / 没设置 → 默认 16:9) */
export function getDramaAspectRatio(dramaId?: number | null): string {
  if (!dramaId) return DEFAULT_DRAMA_ASPECT
  try {
    const [row] = db.select({ metadata: schema.dramas.metadata })
      .from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
    return normalizeDramaAspect(parseDramaMetadata(row?.metadata).aspect_ratio)
  } catch {
    return DEFAULT_DRAMA_ASPECT
  }
}

/**
 * 画幅 → 图片生成 size (短边固定 1080)
 * ★ 16:9 = 1920x1080 —— 与改动前的默认 size 逐字一致 (横屏剧集零变化)
 */
export function imageSizeForAspect(aspectRatio?: string | null): string {
  switch (normalizeDramaAspect(aspectRatio)) {
    case '9:16': return '1080x1920'
    case '4:3': return '1440x1080'
    case '3:2': return '1620x1080'
    case '1:1': return '1080x1080'
    case '2:3': return '720x1080'
    case '3:4': return '810x1080'
    case '4:5': return '864x1080'
    case '21:9': return '2520x1080'
    case '16:9':
    default: return '1920x1080'
  }
}

/** 从 storyboard / scene / character / prop 反查所属 drama (各图片入口兜底都传了 dramaId, 这里只兜底) */
export function lookupDramaIdByStoryboardId(storyboardId?: number | null): number | null {
  if (!storyboardId) return null
  try {
    const [sb] = db.select({ episodeId: schema.storyboards.episodeId })
      .from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    if (!sb?.episodeId) return null
    const [ep] = db.select({ dramaId: schema.episodes.dramaId })
      .from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
    return ep?.dramaId ?? null
  } catch {
    return null
  }
}

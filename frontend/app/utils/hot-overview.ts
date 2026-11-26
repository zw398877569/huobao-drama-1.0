/**
 * ★ Sprint 58 T2 (PM msg-20261126-243): /hot 统计概览 —— 题材分布 Top 12 + 各平台数据量对比
 *   纯函数, 零依赖, 可离线断言。★ 不引第三方图表库 (CSS 横向条形图)。
 *
 * ★ 数据来源:
 *   - 题材分布: boards.genre_stats.tags (M3 给的完整统计, KEEP_FULL 不参与裁剪)
 *   - 各平台数据量: boards.kept_count (后端新增: 各源【裁剪后】实际保留的条数)
 *     ★ 不是 sources_count (那是【裁剪前】的原始条数, 例如 xhs_hot 81 —— 图上数字要跟
 *       页面实际列出的条目数一致, 所以必须用裁剪后的口径)
 */

/** 算 pct 之前的中间结构 */
type RawRow = { name: string; value: number }

export interface BarRow {
  /** 题材名 / 平台名 */
  name: string
  /** 数值 (题材 count / 平台条数) */
  value: number
  /** 条长百分比 (相对最大值, 0~100) */
  pct: number
}

/**
 * ★ 平台 → 源 key 列表 (PM 给定的映射)
 *
 * ★ 与 PM 原映射有三处差异 —— 为了让【图上数字 = 页面实际列出的条目数】成立 (本单 AC9):
 *   ① gh_zh_aigc / gh_en_aigc (GitHub Trending 的 AIGC 榜) 不并进 B站:
 *      这两条在页面上列在【GitHub Trending】分区; 并进 B站 会让 B站 图上数字 32 ≠ 页面列出的 30 条
 *   ② aico_xiaohongshu (小红书 AIGC 创作者榜) 不并进小红书: 页面上没列它
 *      (小红书分区列的是 xhs_hot, 关键词组只是计数)
 *   ③ xhs_content_signal 不并进小红书: 它是 xhs_hot 的【子集】(cat=='content'),
 *      并进去 = 同一批条目算两遍
 */
export const PLATFORM_SOURCES: { platform: string; sources: string[] }[] = [
  {
    platform: '红果',
    sources: ['hongguo_ai_drama', 'hongguo_comic_drama', 'hongguo_real_drama', 'hongguo_hot_search'],
  },
  { platform: 'B站', sources: ['aico_bilibili', 'bili_tech_aigc', 'bili_aigc_content', 'bili_aigc_tool'] },
  { platform: '抖音', sources: ['aico_douyin', 'hot_douyin'] },
  { platform: '小红书', sources: ['xhs_hot'] },
  { platform: '微博', sources: ['hot_weibo'] },
]

/** 题材分布 Top N (按 count 降序) */
export function buildGenreTop(boards: any, n: number = 12): BarRow[] {
  const tags = Array.isArray(boards?.genre_stats?.tags) ? boards.genre_stats.tags : []
  const rows = tags
    .map((t: any) => ({ name: String(t?.tag ?? t?.name ?? ''), value: Number(t?.count) || 0 }))
    .filter((r: RawRow) => !!r.name)
    .sort((a: RawRow, b: RawRow) => b.value - a.value)
    .slice(0, Math.max(0, n))
  return withPct(rows)
}

/** 各平台数据量对比 (kept_count = 裁剪后各源实际保留条数) —— 降序 */
export function buildPlatformRows(boards: any): BarRow[] {
  const kept = boards?.kept_count || {}
  const rows: RawRow[] = PLATFORM_SOURCES.map((p) => ({
    name: p.platform,
    value: p.sources.reduce((n, k) => n + (Number(kept[k]) || 0), 0),
  }))
  rows.sort((a: RawRow, b: RawRow) => b.value - a.value)
  return withPct(rows)
}

/** 相对最大值算条长百分比 (保留 1 位小数) */
function withPct(rows: RawRow[]): BarRow[] {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
  return rows.map((r) => ({ ...r, pct: max > 0 ? Math.round((r.value / max) * 1000) / 10 : 0 }))
}

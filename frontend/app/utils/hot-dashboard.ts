/**
 * ★ Sprint 58 返工 (PM msg-20261126-240): daily-hot 看板 (/hot) 的取数解包 —— 纯函数, 零依赖, 可离线断言
 *
 * ★ 病根 (QA 2026-11-26 blocked): 页面里写的是 `resp?.data ?? resp` —— 但 useApi 的 req()
 *   已经把 {code, data, message} 剥掉了, resp 本身就是 payload 层 → 再剥一层就把【分区对象】
 *   当成了 payload 层 → 分区对象里恰好也有 date 字段 → 页头"数据日期"看起来是对的 (把 bug 藏住了),
 *   而分区数据(.data)取不到 → 页面永远显示"还没有 daily-hot 数据", 8 个分区一个都不出。
 *
 * ★ 后端契约 (GET /api/v1/daily-hot?date=latest|YYYY-MM-DD, useApi 剥壳后):
 *   { date, size_bytes, available_dates, data: { <8 个分区的原始数据>, generated_at, sources_count, ... } }
 *   ★ 无任何文件 → 404 {code, message:'还没有任何 daily-hot 数据 ...'} (useApi 会 throw)
 *   ★ 指定日期不存在 → 404 {code, message:'没有 YYYY-MM-DD 的数据 (现有: ...)'}
 */

/** 8 个分区各自的数据源 key —— 全都没有 → 后端确实没数据 */
export const BOARD_KEYS = [
  'hongguo_duanju',
  'hongguo_hot_search',
  'bili_tech_ranking',
  'aicoder_cli',
  'hot_search',
  'xhs_hot',
  'xhs_by_keyword',
  'github_trending',
  'hot_aigc_words',
  'hot_content_cross',
  'genre_stats',
]

/** 解包后的结果 —— 页头(日期/生成时间) + 日期切换列表 + 8 个分区的数据, 缺一不可 */
export interface HotPayload {
  /** 8 个分区的原始数据容器 */
  boards: Record<string, any>
  /** 数据日期 */
  date: string
  /** 生成时间 */
  generatedAt: string
  /** 可切日期列表 */
  availableDates: string[]
}

/**
 * 是不是 payload 层? —— 必须【同时】有 date(string) 和 available_dates(array)
 * ★ 只看 date 不够: 分区对象里也有 date 字段 → 那正是旧 bug 的伪装
 */
export function isPayloadLayer(o: any): boolean {
  return (
    !!o &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    typeof o.date === 'string' &&
    Array.isArray(o.available_dates)
  )
}

/**
 * 从接口响应里解包 —— 形状不对就抛错 (绝不当成"后端没数据")
 * @param resp useApi 剥掉 {code,data,message} 之后的响应体
 */
export function unpackHot(resp: any): HotPayload {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
    throw new Error('接口返回的不是对象')
  }
  // 正常: resp 已经是 payload 层; 万一外层还包着 {code,data,message}, 这里再认一次 (只剥到认得出为止)
  const layer = isPayloadLayer(resp) ? resp : isPayloadLayer(resp?.data) ? resp.data : null
  if (!layer) {
    const keys = Object.keys(resp).join(',') || '无'
    throw new Error(
      `接口返回的数据形状不对 (顶层没有同时出现 date + available_dates; 实际 keys: ${keys})`,
    )
  }
  const boards = layer.data
  if (!boards || typeof boards !== 'object' || Array.isArray(boards)) {
    throw new Error('接口返回的数据形状不对 (data 应为分区数据对象)')
  }
  return {
    boards,
    date: layer.date,
    generatedAt: typeof boards.generated_at === 'string' ? boards.generated_at : '',
    availableDates: layer.available_dates.filter((x: any) => typeof x === 'string'),
  }
}

/**
 * 后端【确实没数据】(404) 的两种说法 → 空状态, 不是错误
 *   ① '还没有任何 daily-hot 数据 (等 M3 的 daily-hot 跑完后 POST 上来)'
 *   ② '没有 2026-11-24 的数据 (现有: ... )'
 */
export function isNoDataError(msg: string): boolean {
  return /还没有任何\s*daily-hot\s*数据|没有\s*\d{4}-\d{2}-\d{2}\s*的数据/.test(String(msg || ''))
}

/** 分区数据里有没有内容 —— 一个都没有 → 后端确实没数据 (空状态) */
export function hasAnyBoard(boards: any): boolean {
  return BOARD_KEYS.some((k) => boards?.[k] != null)
}

/* ── 8 个分区的 key 映射 (纯函数, 离线可断言不串 key) ── */

/**
 * ★ Sprint 58 (PM msg-20261123-227): daily-hot 数据看板 /hot
 *   8 个分区 (2026-11-23 用户拍板) —— 每个 key 都对着 M3 vault 里的真实 raw JSON 核对过, 别串 key
 */
export interface Group { label: string; items: any[]; note?: string }
export interface Section { key: string; label: string; sourceKeys: string[]; groups: (d: any) => Group[] }

const arr = (v: any) => (Array.isArray(v) ? v : [])

export function buildHotSections(): Section[] {
  return [
  {
    key: 'hongguo', label: '红果短剧', sourceKeys: [],
    groups: (d) => [
      { label: 'AI 短剧', items: arr(d?.hongguo_duanju?.['ai-drama']) },
      { label: 'AI 漫剧', items: arr(d?.hongguo_duanju?.['comic-drama']) },
      { label: '真人剧', items: arr(d?.hongguo_duanju?.['real-drama']) },
      { label: '短剧热搜', items: arr(d?.hongguo_hot_search?.['hot-search-drama']) },
      { label: '真人剧热搜', items: arr(d?.hongguo_hot_search?.['hot-search-real-drama']) },
    ],
  },
  {
    key: 'bili', label: 'B站', sourceKeys: ['aico_bilibili', 'bili_tech_aigc'],
    groups: (d) => [
      { label: '技术区 AIGC 榜', items: arr(d?.bili_tech_ranking?.aigc) },
      { label: 'AI 创作者榜', items: arr(d?.aicoder_cli?.bilibili) },
      // ★ by_rid 是【嵌套 dict】: { rid: { label, total, aigc: [] } }
      ...Object.entries(d?.bili_tech_ranking?.by_rid || {}).map(([rid, v]: any) => ({
        label: `分区 ${v?.label || rid}`, items: arr(v?.aigc),
      })),
    ],
  },
  {
    key: 'douyin', label: '抖音', sourceKeys: ['aico_douyin'],
    groups: (d) => [
      { label: 'AIGC 创作者榜', items: arr(d?.aicoder_cli?.douyin) },
      { label: '热搜', items: arr(d?.hot_search?.douyin) },
    ],
  },
  {
    key: 'xhs', label: '小红书', sourceKeys: ['aico_xiaohongshu'],
    groups: (d) => [
      { label: '热门笔记', items: arr(d?.xhs_hot) },
      // ★ xhs_by_keyword 的值是【数字计数】不是 list → 当分组计数显示, 不当条目
      ...Object.entries(d?.xhs_by_keyword || {}).map(([kw, v]: any) => ({
        label: `关键词 ${kw}`, items: [], note: typeof v === 'number' ? `${v} 条` : undefined,
      })),
    ],
  },
  {
    key: 'weibo', label: '微博热搜', sourceKeys: [],
    groups: (d) => [
      { label: '热搜榜', items: arr(d?.hot_search?.weibo) },
    ],
  },
  {
    key: 'github', label: 'GitHub Trending', sourceKeys: ['gh_en_aigc', 'gh_zh_aigc'],
    groups: (d) => [
      { label: '中文 AIGC', items: arr(d?.github_trending?.zh_aigc) },
      { label: '英文 AIGC', items: arr(d?.github_trending?.en_aigc) },
      { label: '中文总榜', items: arr(d?.github_trending?.zh_total) },
      { label: '英文总榜', items: arr(d?.github_trending?.en_total) },
    ],
  },
  {
    key: 'cross', label: '跨平台热点词', sourceKeys: [],
    groups: (d) => [
      { label: 'AIGC 热点词', items: arr(d?.hot_aigc_words) },
      { label: '跨平台内容', items: arr(d?.hot_content_cross) },
      { label: '各平台热搜汇总', items: arr(d?.hot_search?.all) },
    ],
  },
  {
    key: 'genre', label: '题材统计', sourceKeys: [],
    groups: (d) => [
      { label: '题材分布', items: arr(d?.genre_stats?.tags) },
    ],
  },
]
}

/**
 * ★ Sprint 58 (PM msg-20261123-227): daily-hot 原始 JSON 的【入库裁剪】—— ★ 纯函数, 零依赖, 可离线断言
 *
 * 背景: daily-hot 每天产出一份 ~107KB 的 raw JSON → 原样存 + 原样拉都偏重, 长尾没人看
 *   → 在【后端入库时】裁剪: 每榜 ≤50 条, title ≤200 字 / author ≤50 字, kw + url 原样,
 *     genre_stats / sources_count 完整保留, 裁完单日 ≤40KB。
 *
 * ★ 排序口径 (2026-11-25 用 M3 vault 里的真实 raw JSON 逐榜核对过):
 *   - 绝对热度数值字段优先级: like_num > like > hot > view > count > fans
 *   - ★ rank / position 是【名次】(1 = 第一) → 拿它降序会把第一名排到最后, 所以【不】当热度字段
 *   - 榜里没有这些字段的 (aicoder_cli / hongguo_*) → 保持原序 (原数据本来就是榜序)
 *   - xhs_hot 有 like_num → 会真的按点赞降序 (工单验收点)
 */

/** 每榜最多保留多少条 */
export const MAX_ITEMS_PER_BOARD = 50
/** title 最长 */
export const MAX_TITLE_LEN = 200
/** author 最长 */
export const MAX_AUTHOR_LEN = 50
/** 单日裁剪后的体积上限 (40KB) */
export const MAX_DAILY_BYTES = 40 * 1024
/** ★ 完整保留、不参与裁剪的顶层 key (体积小价值高) */
export const KEEP_FULL_KEYS = ['genre_stats', 'sources_count']
/** 绝对热度数值字段 (按优先级) —— ★ 不含 rank / position (那是名次不是热度) */
export const HEAT_FIELDS = ['like_num', 'like', 'hot', 'view', 'count', 'fans'] as const

function isNum(v: any): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 找这一榜用的热度字段 (取榜内第一条能用的; 整榜统一一个字段 → 排序稳定) */
export function pickHeatField(items: any[]): string | null {
  for (const f of HEAT_FIELDS) {
    if (items.some((it) => it && typeof it === 'object' && isNum(it[f]))) return f
  }
  return null
}

/** 裁剪单条 (title / author 截断; kw + url 原样) */
export function trimItem(item: any): any {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const out: any = { ...item }
  if (typeof out.title === 'string' && out.title.length > MAX_TITLE_LEN) {
    out.title = out.title.slice(0, MAX_TITLE_LEN)
  }
  if (typeof out.author === 'string' && out.author.length > MAX_AUTHOR_LEN) {
    out.author = out.author.slice(0, MAX_AUTHOR_LEN)
  }
  return out
}

/** 裁剪一个榜 (list): 热度降序 → 取前 limit → 逐条截断 */
export function trimBoardItems(items: any[], limit: number = MAX_ITEMS_PER_BOARD): any[] {
  if (!Array.isArray(items)) return items
  const heat = pickHeatField(items)
  let ordered = items
  if (heat) {
    // 稳定降序 (热度相同保持原序)
    ordered = items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => {
        const av = a.it && typeof a.it === 'object' ? a.it[heat] : undefined
        const bv = b.it && typeof b.it === 'object' ? b.it[heat] : undefined
        const an = isNum(av) ? av : -Infinity
        const bn = isNum(bv) ? bv : -Infinity
        if (an === bn) return a.i - b.i
        return bn - an
      })
      .map((x) => x.it)
  }
  return ordered.slice(0, Math.max(0, limit)).map(trimItem)
}

/**
 * 递归裁剪任意值
 *   - list → 裁条数 + 逐条截断
 *   - dict → 逐 key 递归 (★ by_rid 这种嵌套 dict 里的 list 也会被裁)
 *   - 其它 (数字 / 字符串 / null) → 原样
 */
export function trimValue(value: any, limit: number = MAX_ITEMS_PER_BOARD, keepKeys: string[] = KEEP_FULL_KEYS): any {
  if (Array.isArray(value)) return trimBoardItems(value, limit)
  if (value && typeof value === 'object') {
    const out: any = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = keepKeys.includes(k) ? v : trimValue(v, limit, keepKeys)
    }
    return out
  }
  return value
}

export interface TrimResult {
  data: any
  /** 裁剪后 JSON 字节数 */
  bytes: number
  /** 实际用的每榜条数上限 */
  limit: number
}


/**
 * ★ 单 243 T2 (PM msg-20261126-243): kept_count —— 每个源【裁剪后实际保留】的条数
 *
 * ★ 与 sources_count 的关系:
 *   - sources_count = M3 采集侧给的【裁剪前】原始条数 (KEEP_FULL_KEYS, 完整保留) → 本单一个字都没改
 *   - kept_count   = ★【裁剪后】这一轮真正留下来的条数 (同一份数据, 两个口径, 一起给)
 *   - key 集合以 sources_count 为准 → 两者严格同构
 *
 * ★ 取法与 M3 采集脚本 (cronTask/daily-aigc-hot/daily-aigc-hot.sh) 的 sources_count 同构:
 *   同一份 raw JSON 的同一批源, 只是数的是【裁剪后】的数组长度
 *   (bili_aigc_content / bili_aigc_tool 是 by_rid 各分区 content/tool 的合计;
 *    xhs_content_signal 是 xhs_hot 里 cat=='content' 的条数 —— 它是 xhs_hot 的【子集】)
 */
export function countKeptBySource(data: any): Record<string, number> {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const len = (v: any): number => (Array.isArray(v) ? v.length : 0)
  /** dict 下每个 value 都是 list → 求和 (hongguo_hot_search) */
  const sumLists = (v: any): number => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 0
    let n = 0
    for (const x of Object.values(v)) n += len(x)
    return n
  }
  /** bili_tech_ranking.by_rid 各分区的某个子榜合计 (content / tool) */
  const sumByRid = (field: string): number => {
    const byRid = d?.bili_tech_ranking?.by_rid
    if (!byRid || typeof byRid !== 'object' || Array.isArray(byRid)) return 0
    let n = 0
    for (const rid of Object.values(byRid)) n += len((rid as any)?.[field])
    return n
  }
  const counts: Record<string, number> = {
    aico_douyin: len(d?.aicoder_cli?.douyin),
    aico_xiaohongshu: len(d?.aicoder_cli?.xiaohongshu),
    aico_bilibili: len(d?.aicoder_cli?.bilibili),
    gh_en_aigc: len(d?.github_trending?.en_aigc),
    gh_zh_aigc: len(d?.github_trending?.zh_aigc),
    bili_tech_aigc: len(d?.bili_tech_ranking?.aigc),
    bili_aigc_content: sumByRid('content'),
    bili_aigc_tool: sumByRid('tool'),
    hongguo_ai_drama: len(d?.hongguo_duanju?.['ai-drama']),
    hongguo_comic_drama: len(d?.hongguo_duanju?.['comic-drama']),
    hongguo_real_drama: len(d?.hongguo_duanju?.['real-drama']),
    hongguo_hot_search: sumLists(d?.hongguo_hot_search),
    xhs_hot: len(d?.xhs_hot),
    xhs_content_signal: Array.isArray(d?.xhs_hot)
      ? d.xhs_hot.filter((n: any) => n?.cat === 'content').length
      : 0,
    hot_douyin: len(d?.hot_search?.douyin),
    hot_weibo: len(d?.hot_search?.weibo),
    hot_bilibili: len(d?.hot_search?.bilibili),
    hot_content_cross: len(d?.hot_content_cross),
    hot_aigc_words: len(d?.hot_aigc_words),
  }
  // ★ key 集合以 sources_count 为准 (保证两者严格同构)
  const src = d?.sources_count
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const out: Record<string, number> = {}
    for (const k of Object.keys(src)) out[k] = counts[k] ?? 0
    return out
  }
  return counts
}

/**
 * 裁剪一整份 daily-hot raw JSON
 * ★ 体积兜底: 每榜 ≤50 之后若仍 >40KB → 按比例缩条数重试 (最多 8 轮)
 */
export function trimDailyHot(raw: any, maxBytes: number = MAX_DAILY_BYTES): TrimResult {
  let limit = MAX_ITEMS_PER_BOARD
  let data = trimValue(raw, limit)
  let bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8')
  let rounds = 0
  while (bytes > maxBytes && limit > 5 && rounds < 8) {
    limit = Math.max(5, Math.floor(limit * 0.75))
    data = trimValue(raw, limit)
    bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8')
    rounds += 1
  }
  // ★ 单 243 T2: 附上 kept_count (各源裁剪后实际保留条数)
  //   ★ 裁剪逻辑 / limit / 体积预算【一个字都没动】—— kept_count 是在裁剪【之后】算的,
  //     不参与上面的体积兜底循环 (否则同一天 limit 会从 20 掉到 15 → PM 给的核数就变了)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data.kept_count = countKeptBySource(data)
    bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8')
  }
  return { data, bytes, limit }
}

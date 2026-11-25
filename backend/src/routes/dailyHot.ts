/**
 * ★ Sprint 58 (PM msg-20261123-227): daily-hot 数据看板 —— 后端收/取端点
 *
 * 架构前提 (★ 别设计错):
 *   daily-hot 的新数据只在 M3 的 Obsidian vault, 而【项目后端跑在 Intel Mac 192.168.3.16】→
 *   后端【读不到】vault (Intel 那份 clone 只有 9-20 的老数据)。
 *   → 链路: M3 的 daily-hot 跑完 → POST 到本端点 → 后端存自己 data 目录 → 前端查 API。
 *   ★ 不试图让后端直接读 vault。
 *
 * 端点:
 *   POST /api/v1/daily-hot          收当天 raw JSON (裸 JSON) → 裁剪 → 落盘 data/daily-hot/YYYY-MM-DD.json
 *   GET  /api/v1/daily-hot?date=latest|YYYY-MM-DD   取回 (缺省/latest → 最近一天)
 *
 * 存储: 文件 (跟 flow-logs 一个套路), ★ 不新增数据库表
 * 保留: 30 天 (每次 POST + 后端启动时清掉超期文件)
 *
 * ★ POST body 形态 (定稿, Data 侧照此实现): 【裸 JSON】(不包装)
 *   - 日期取 body.date (raw JSON 自带, 例 '2026-11-25'); 缺失/格式不对 → 400 明确报错
 *   - ★ 兼容 {date, data} 包装形态 (万一先按包装发) —— 有 data 数组且 date 在外层就用它
 *   - 裁剪全在后端做 → Data 那边 POST 原始 JSON 即可
 */
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { success, badRequest, notFound } from '../utils/response.js'
import { trimDailyHot, MAX_DAILY_BYTES, MAX_ITEMS_PER_BOARD } from '../services/daily-hot-trim.js'

const app = new Hono()

/**
 * ★ 2026-11-23 P0 热修 (单 228): ES module 里【没有 __dirname 这个全局】!
 *   本项目 backend/package.json 是 "type": "module" → 直接写 __dirname 会在【模块求值期】抛
 *   ReferenceError: __dirname is not defined in ES module scope → 整个后端容器反复重启。
 *   ★ 而且 tsc 抓不到: backend/tsconfig.json 的 "types": ["node"] 让 @types/node 提供了
 *     __dirname 的【CommonJS 类型声明】→ 类型层面合法, 运行时才炸 → 必须照项目既有写法:
 *     path.dirname(fileURLToPath(import.meta.url))  (见 utils/storage.ts / utils/file-log.ts / db/index.ts)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 存储目录: 容器内 /app/data/daily-hot (compose 把 /app/data 挂到 host) */
export const DAILY_HOT_DIR =
  process.env.DAILY_HOT_DIR || path.resolve(__dirname, '../../../data/daily-hot')
/** 保留天数 */
export const KEEP_DAYS = 30

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function ensureDir(): void {
  if (!fs.existsSync(DAILY_HOT_DIR)) fs.mkdirSync(DAILY_HOT_DIR, { recursive: true })
}

/** 目录里已有的日期 (升序) */
export function listStoredDates(): string[] {
  try {
    if (!fs.existsSync(DAILY_HOT_DIR)) return []
    return fs.readdirSync(DAILY_HOT_DIR)
      .map((f) => (f.endsWith('.json') ? f.slice(0, -5) : ''))
      .filter((d) => DATE_RE.test(d))
      .sort()
  } catch {
    return []
  }
}

/** ★ 删掉超期 (超过 KEEP_DAYS 天) 的文件 —— POST 时 + 后端启动时各跑一次 */
export function cleanupDailyHot(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 3600 * 1000)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  let removed = 0
  for (const d of listStoredDates()) {
    if (d >= cutoffStr) continue
    try {
      fs.unlinkSync(path.join(DAILY_HOT_DIR, `${d}.json`))
      removed += 1
    } catch {
      // 删不掉就跳过 (不因为清理失败挡住上报)
    }
  }
  return removed
}

/** POST —— 收当天 raw JSON → 裁剪 → 落盘 */
app.post('/', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, 'body 必须是合法 JSON (daily-hot raw JSON)')
  }
  if (!body || typeof body !== 'object') return badRequest(c, 'body 必须是 JSON 对象')

  // ★ 兼容 {date, data} 包装; 定稿形态是裸 JSON
  const payload =
    body && Array.isArray(body.data) && typeof body.data === 'object' ? body.data : body
  const date = String(body?.date || payload?.date || '').trim()
  if (!DATE_RE.test(date)) {
    return badRequest(c, `缺少合法的 date 字段 (应为 YYYY-MM-DD, 收到: ${date || '空'})`)
  }

  try {
    ensureDir()
    const { data, bytes, limit } = trimDailyHot(payload)
    fs.writeFileSync(path.join(DAILY_HOT_DIR, `${date}.json`), JSON.stringify(data), 'utf-8')
    const removed = cleanupDailyHot()
    return success(c, {
      date,
      size_bytes: bytes,
      items_per_board: limit,
      max_bytes: MAX_DAILY_BYTES,
      boards: Object.keys(data || {}),
      cleaned_files: removed,
    })
  } catch (err: any) {
    return badRequest(c, `写入失败: ${err?.message || err}`)
  }
})

/** GET —— 取回裁剪后的数据 (date=latest 或 YYYY-MM-DD, 缺省 = latest) */
app.get('/', async (c) => {
  const q = (c.req.query('date') || 'latest').trim()
  const dates = listStoredDates()
  if (!dates.length) {
    return notFound(c, '还没有任何 daily-hot 数据 (等 M3 的 daily-hot 跑完后 POST 上来)')
  }
  let date = q
  if (q === 'latest' || q === '') {
    date = dates[dates.length - 1]
  } else if (!DATE_RE.test(q)) {
    return badRequest(c, `date 参数格式不对: ${q} (应为 latest 或 YYYY-MM-DD)`)
  } else if (!dates.includes(q)) {
    return notFound(c, `没有 ${q} 的数据 (现有: ${dates[0]} ~ ${dates[dates.length - 1]})`)
  }
  try {
    const raw = fs.readFileSync(path.join(DAILY_HOT_DIR, `${date}.json`), 'utf-8')
    const json = JSON.parse(raw)
    return success(c, { date, size_bytes: Buffer.byteLength(raw, 'utf-8'), available_dates: dates, data: json })
  } catch (err: any) {
    return notFound(c, `读取 ${date} 失败: ${err?.message || err}`)
  }
})

export default app

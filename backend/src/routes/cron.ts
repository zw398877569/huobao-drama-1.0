/**
 * cron 任务监控路由 — 外部 launchd 任务 wrapper 上报接口
 * wrapper 脚本: ~/bin/task-runner.sh
 *
 * 端点:
 *   POST   /cron/runs         wrapper 上报 START  → INSERT (status='running')
 *   PATCH  /cron/runs/:runId  wrapper 上报 END    → UPDATE (status, exitCode, output)
 *   GET    /cron/runs         列表查询 (按 date/status/name 过滤, 含聚合 stats)
 *   GET    /cron/runs/:runId  单条详情
 *
 * 隔离说明:
 *   - 独立路由文件, 不依赖任何已有 service
 *   - 独立表 cron_runs, 与 logTask* / videoGenerations 等无关
 *   - 所有错误都返回 4xx + 中文 message, 不污染其他端点
 */
import { Hono } from 'hono'
import { desc, eq, gte, lte, and, notInArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { now } from '../utils/response.js'

const app = new Hono()

// === stale-running sweep ===
// launchd 任务被 SIGKILL (OOM / launchd Throttle / 用户 kill) 时, wrapper 永远不会发出 END,
// 对应记录会卡在 status='running' 永远 — 这里在 GET /runs 前做一个 lazy 回收。
// 阈值按任务单独配 (每个任务最长运行时间不同), 没列出的走默认。
// 只在 GET /runs 触发 (不是单条详情), 用户打开 dashboard 顺手清, 不需要额外 cron。
const STALE_THRESHOLD_MS: Record<string, number> = {
  dailylearn: 2 * 60 * 60 * 1000,        // 2h — Phase 2 LLM 最长 15-20 分钟, 2h 是宽松上限
  minimaxlearn: 2 * 60 * 60 * 1000,
  videounderstand: 30 * 60 * 1000,        // 30min — 单视频 5-10 分钟
  'daily-hot-list': 30 * 60 * 1000,      // 30min — 8 数据源约 10 分钟
}
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000 // 未知任务走 2h 默认

function sweepStaleRuns() {
  const ts = Date.now()
  const updated = now() // updatedAt 是 text (ISO), endedAt 是 integer (ms)
  let swept = 0

  // 按任务单独阈值扫一遍
  for (const [name, threshold] of Object.entries(STALE_THRESHOLD_MS)) {
    const cutoff = ts - threshold
    const result = db.update(schema.cronRuns).set({
      status: 'failed',
      endedAt: ts,
      exitCode: -1,
      output: `[stale-orphan] no END reported after ${Math.round(threshold / 60000)}min, assumed killed (OOM/launchd/SIGKILL)`,
      updatedAt: updated,
    }).where(and(
      eq(schema.cronRuns.name, name),
      eq(schema.cronRuns.status, 'running'),
      lte(schema.cronRuns.startedAt, cutoff),
    )).run()
    swept += (result as any)?.changes ?? 0
  }

  // 兜底: 未知任务名 (不在 PER_TASK_MS 的), 超过默认阈值也清
  const knownNames = Object.keys(STALE_THRESHOLD_MS)
  const cutoff = ts - DEFAULT_STALE_MS
  const result = db.update(schema.cronRuns).set({
    status: 'failed',
    endedAt: ts,
    exitCode: -1,
    output: `[stale-orphan] no END reported after ${Math.round(DEFAULT_STALE_MS / 60000)}min (default), assumed killed`,
    updatedAt: updated,
  }).where(and(
    eq(schema.cronRuns.status, 'running'),
    lte(schema.cronRuns.startedAt, cutoff),
    notInArray(schema.cronRuns.name, knownNames),
  )).run()
  swept += (result as any)?.changes ?? 0

  if (swept > 0) console.log(`[cron] sweepStaleRuns: cleaned ${swept} stale-orphan running record(s)`)
  return swept
}

/** wrapper 上报 START — 幂等: 同一 runId 已存在则返回 200 不报错 */
app.post('/runs', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, 'invalid json body') }
  const { runId, name, startedAt } = body
  if (!runId || typeof runId !== 'string') return badRequest(c, 'runId required (string)')
  if (!name || typeof name !== 'string') return badRequest(c, 'name required (string)')
  if (typeof startedAt !== 'number') return badRequest(c, 'startedAt required (number, unix ms)')

  const ts = now()
  try {
    db.insert(schema.cronRuns).values({
      runId, name, status: 'running',
      startedAt, createdAt: ts, updatedAt: ts,
    }).run()
    return created(c, { runId })
  } catch (e: any) {
    // runId UNIQUE 冲突 — 重复 START, 视为幂等成功
    if (String(e?.message || '').includes('UNIQUE')) {
      return success(c, { runId, deduped: true })
    }
    return badRequest(c, `insert failed: ${e.message}`)
  }
})

/** wrapper 上报 END — 更新状态/退出码/输出 */
app.patch('/runs/:runId', async (c) => {
  const runId = c.req.param('runId')
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, 'invalid json body') }
  const { status, endedAt, exitCode, output } = body
  if (status !== 'success' && status !== 'failed') {
    return badRequest(c, 'status must be "success" or "failed"')
  }
  if (typeof endedAt !== 'number') return badRequest(c, 'endedAt required (number, unix ms)')

  // 取 started_at 算 duration
  const [existing] = db.select().from(schema.cronRuns)
    .where(eq(schema.cronRuns.runId, runId)).all()
  if (!existing) return badRequest(c, `runId not found: ${runId}`)

  const durationMs = Math.max(0, endedAt - existing.startedAt)
  // 输出截到 2000 字符, 防止巨大日志撑爆 DB
  const trimmedOutput = typeof output === 'string' ? output.slice(-2000) : ''

  db.update(schema.cronRuns)
    .set({
      status, endedAt,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      output: trimmedOutput,
      durationMs,
      updatedAt: now(),
    })
    .where(eq(schema.cronRuns.runId, runId))
    .run()
  return success(c, { runId, durationMs })
})

/** 列表查询 — 支持 date / status / name 过滤 */
app.get('/runs', async (c) => {
  // lazy stale-running sweep — 把超期未结束的 running 行标记成 stale-orphan
  sweepStaleRuns()

  const date = c.req.query('date')   // YYYY-MM-DD (Asia/Shanghai)
  const status = c.req.query('status')
  const name = c.req.query('name')
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 200)))

  const conds: any[] = []
  if (date) {
    // 兼容 ISO 字符串和 YYYY-MM-DD; 全部按 Asia/Shanghai 00:00 算
    const start = new Date(date + 'T00:00:00+08:00').getTime()
    if (!Number.isFinite(start)) return badRequest(c, `invalid date: ${date}`)
    const end = start + 86400000
    conds.push(gte(schema.cronRuns.startedAt, start))
    conds.push(lte(schema.cronRuns.startedAt, end - 1))
  }
  if (status === 'running' || status === 'success' || status === 'failed') {
    conds.push(eq(schema.cronRuns.status, status))
  }
  if (name) conds.push(eq(schema.cronRuns.name, name))

  let q: any = db.select().from(schema.cronRuns)
  if (conds.length) q = q.where(and(...conds))
  const rows = q.orderBy(desc(schema.cronRuns.startedAt)).limit(limit).all()

  // 聚合 stats
  const stats = { total: rows.length, success: 0, failed: 0, running: 0, avgDurationMs: 0 }
  let totalDur = 0, durCount = 0
  for (const r of rows) {
    if (r.status === 'success') stats.success++
    else if (r.status === 'failed') stats.failed++
    else if (r.status === 'running') stats.running++
    if (typeof r.durationMs === 'number') { totalDur += r.durationMs; durCount++ }
  }
  stats.avgDurationMs = durCount > 0 ? Math.round(totalDur / durCount) : 0

  return success(c, { runs: rows, stats })
})

/** 单条详情 */
app.get('/runs/:runId', async (c) => {
  const runId = c.req.param('runId')
  const [row] = db.select().from(schema.cronRuns)
    .where(eq(schema.cronRuns.runId, runId)).all()
  return success(c, row || null)
})

export default app

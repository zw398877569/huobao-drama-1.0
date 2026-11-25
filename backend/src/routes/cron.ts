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
// ★ Sprint 57 T2-A: DELETE /runs 要留操作痕迹 → 用项目里的 logTask (写文件日志, 不碰 DB)
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
// ★ Sprint 57 T2-A (PM msg-20261123-226): 调度健康度 (应跑 N / 实跑 M / 漏跑 K) —— 纯逻辑在 services/cron-health.ts
import { computeAllTaskHealth, parseSlots, isProtectedTaskName, dayRange, normalizeSource } from '../services/cron-health.js'

const app = new Hono()

/** outputs 字段是 JSON 字符串 (SQLite TEXT 只能存字符串), GET 返回时 parse 成真数组, 避免前端按字符迭代 */
function parseOutputs(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// === stale-running sweep ===
// launchd 任务被 SIGKILL (OOM / launchd Throttle / 用户 kill) 时, wrapper 永远不会发出 END,
// 对应记录会卡在 status='running' 永远 — 这里在 GET /runs 前做一个 lazy 回收。
// 阈值按任务单独配 (每个任务最长运行时间不同), 没列出的走默认。
// 只在 GET /runs 触发 (不是单条详情), 用户打开 dashboard 顺手清, 不需要额外 cron。
const STALE_THRESHOLD_MS: Record<string, number> = {
  dailylearn: 2 * 60 * 60 * 1000,        // 2h — Phase 2 LLM 最长 15-20 分钟, 2h 是宽松上限
  minimaxlearn: 2 * 60 * 60 * 1000,
  videounderstand: 30 * 60 * 1000,        // 30min — 单视频 5-10 分钟
  'face-archive': 2 * 60 * 60 * 1000,    // 2h — Phase 2 codex exec 最长 10-15 分钟, 2h 宽松
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
  // ★ Sprint 57 T2-A: 区分【定时跑】与【手动跑】—— 没有它就分不清"定时器死了"与"手动调试跑"
  const source = normalizeSource(body.source)
  const slot = typeof body.slot === 'string' && body.slot.trim() ? body.slot.trim() : null
  if (!runId || typeof runId !== 'string') return badRequest(c, 'runId required (string)')
  if (!name || typeof name !== 'string') return badRequest(c, 'name required (string)')
  if (typeof startedAt !== 'number') return badRequest(c, 'startedAt required (number, unix ms)')

  const ts = now()
  try {
    db.insert(schema.cronRuns).values({
      runId, name, status: 'running',
      startedAt, createdAt: ts, updatedAt: ts,
      source, slot,
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
  const { status, endedAt, exitCode, output, outputs } = body
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
  // 2026-09-28 增量: outputs 数组 (wrapper 从 log "✓ label: /abs/path" 提取)
  // wrapper 发的是 JSON array (像 ["path1","path2"]), 不是 string. 后端要 stringify 才能存 TEXT 列
  // 2026-09-29 修: 原来只判 string 漏了 array, 导致 wrapper 发数组时被存 null, dashboard 看不到产出的 paths
  let trimmedOutputs: string | null = null
  if (Array.isArray(outputs)) {
    trimmedOutputs = JSON.stringify(outputs).slice(0, 10000)
  } else if (typeof outputs === 'string') {
    trimmedOutputs = outputs.slice(0, 10000)
  }

  db.update(schema.cronRuns)
    .set({
      status, endedAt,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      output: trimmedOutput,
      outputs: trimmedOutputs,
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

  // 聚合 stats + parse outputs
  const stats: { total: number; success: number; failed: number; running: number; avgDurationMs: number; suspectZeroDuration: number } = { total: rows.length, success: 0, failed: 0, running: 0, avgDurationMs: 0, suspectZeroDuration: 0 }
  let totalDur = 0, durCount = 0
  // ★ Sprint 57 T2-A: duration_ms=0 且 success 的记录 → 明确标记 (不拒收, 但看板要能看出可疑)
  const runs = rows.map(r => ({
    ...r,
    outputs: parseOutputs(r.outputs),
    suspectZeroDuration: r.status === 'success' && typeof r.durationMs === 'number' && r.durationMs === 0,
  }))
  for (const r of runs) {
    if (r.status === 'success') stats.success++
    else if (r.status === 'failed') stats.failed++
    else if (r.status === 'running') stats.running++
    if (typeof r.durationMs === 'number') { totalDur += r.durationMs; durCount++ }
  }
  stats.avgDurationMs = durCount > 0 ? Math.round(totalDur / durCount) : 0
  stats.suspectZeroDuration = runs.filter((r: any) => r.suspectZeroDuration).length

  // ★ Sprint 57 T2-A: 调度健康度 (应跑 N / 实跑 M / 漏跑 K) —— 按 cron_schedules 的档位表算
  let health: any[] = []
  if (date) {
    const schedRows = db.select().from(schema.cronSchedules).all()
    health = computeAllTaskHealth(
      schedRows.map((s: any) => ({ taskName: s.taskName, slots: s.slots })),
      runs as any,
      date,
    )
  }

  return success(c, { runs, stats, health })
})

// ★ Sprint 57 T2-A (PM msg-20261123-226): 调度档位表 (应跑 N 的来源)
//   ★ 声明在 '/runs/:runId' 【之前】—— 否则 Hono 让 :id 通配段抢先 match
app.get('/schedules', async (c) => {
  const rows = db.select().from(schema.cronSchedules).all()
  return success(c, {
    schedules: rows.map((r: any) => ({ ...r, slotList: parseSlots(r.slots) })),
  })
})

app.post('/schedules', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, 'invalid json body') }
  const taskName = String(body?.task_name || '').trim()
  if (!taskName) return badRequest(c, 'task_name required')
  const slotsRaw = String(body?.slots || '').trim()
  const slotList = parseSlots(slotsRaw)
  if (!slotList.length) return badRequest(c, 'slots required (逗号分隔 HHMM, 例 2200,2300,0000)')
  for (const s of slotList) {
    if (!/^\d{4}$/.test(s) || Number(s.slice(0, 2)) > 23 || Number(s.slice(2)) > 59) {
      return badRequest(c, `slots 里有非法档位: ${s} (应为 HHMM, 例 2200)`)
    }
  }
  const timezone = String(body?.timezone || 'Asia/Shanghai')
  const enabled = body?.enabled === false || body?.enabled === 0 ? 0 : 1
  const ts = now()
  const [existing] = db.select().from(schema.cronSchedules)
    .where(eq(schema.cronSchedules.taskName, taskName)).all()
  if (existing) {
    db.update(schema.cronSchedules).set({ slots: slotsRaw, timezone, enabled, updatedAt: ts } as any)
      .where(eq(schema.cronSchedules.taskName, taskName)).run()
  } else {
    db.insert(schema.cronSchedules).values({ taskName, slots: slotsRaw, timezone, enabled } as any).run()
  }
  return success(c, { taskName, slots: slotsRaw, timezone, enabled })
})

// ★ Sprint 57 T2-A: 批量删除运行记录 (清理调试脏数据)
//   ★ 正式任务名的记录【删不掉】→ 400 拒绝 (防手滑删掉真实调度记录); 只有测试/探针类 name 能删
//   ★ 删完留一条操作痕迹 (logTaskProgress)
app.delete('/runs', async (c) => {
  const name = String(c.req.query('name') || '').trim()
  const from = String(c.req.query('from') || '').trim()
  const to = String(c.req.query('to') || '').trim()
  if (!name) return badRequest(c, 'name required (query)')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return badRequest(c, 'from 与 to 必填 (YYYY-MM-DD, Asia/Shanghai)')
  }
  if (isProtectedTaskName(name)) {
    const msg = `拒绝删除正式任务「${name}」的运行记录 —— 只有测试/探针类 name (如 array-retest / probe-test / log-test) 能删`
    logTaskWarn('CronAPI', 'delete-runs-rejected', { name, from, to, reason: 'protected-task-name' })
    return badRequest(c, msg)
  }
  const { start } = dayRange(from)
  const { end } = dayRange(to)
  if (!start || !end || end <= start) return badRequest(c, `from/to 区间不对: ${from} ~ ${to}`)
  const before = db.select().from(schema.cronRuns).where(eq(schema.cronRuns.name, name)).all().length
  db.delete(schema.cronRuns).where(and(
    eq(schema.cronRuns.name, name),
    gte(schema.cronRuns.startedAt, start),
    lte(schema.cronRuns.startedAt, end - 1),
  )).run()
  const after = db.select().from(schema.cronRuns).where(eq(schema.cronRuns.name, name)).all().length
  const deleted = Math.max(0, before - after)
  logTaskProgress('CronAPI', 'delete-runs', { name, from, to, deleted, before, after })
  return success(c, { name, from, to, deleted, before, after })
})

/** 单条详情 */
app.get('/runs/:runId', async (c) => {
  const runId = c.req.param('runId')
  const [row] = db.select().from(schema.cronRuns)
    .where(eq(schema.cronRuns.runId, runId)).all()
  if (!row) return success(c, null)
  return success(c, { ...row, outputs: parseOutputs(row.outputs) })
})

/** POST /runs/:runId/log — 增量: wrapper 上传完整 log (末尾 ~50KB)
 *  与 PATCH /runs/:runId 完全独立, 失败不影响主 cron 状态
 *  body: { log: string } */
app.post('/runs/:runId/log', async (c) => {
  const runId = c.req.param('runId')
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, 'invalid json body') }
  const { log } = body
  if (typeof log !== 'string') return badRequest(c, 'log (string) required')

  // 截到 50KB 防止巨大 payload 撑爆 DB (原始 log 可能几 MB)
  const MAX = 50 * 1024
  const trimmedLog = log.length > MAX ? log.slice(-MAX) : log

  // 确认 runId 存在 (避免创建孤儿 row)
  const [existing] = db.select().from(schema.cronRuns)
    .where(eq(schema.cronRuns.runId, runId)).all()
  if (!existing) return badRequest(c, `runId not found: ${runId}`)

  db.update(schema.cronRuns)
    .set({ outputFull: trimmedLog, updatedAt: now() })
    .where(eq(schema.cronRuns.runId, runId))
    .run()

  return success(c, { runId, logLen: trimmedLog.length, truncated: log.length > MAX })
})

export default app

/**
 * face-archive 同步 + 查询路由
 * PM msg-20260929-002 Sprint 5 Task B
 *
 * 数据源: ~/Obsidian/cronTask/aicg-demo/data/face-types.json (Mac cron 任务产出)
 * 表: face_type_entries (schema.ts) — 4 索引 manual-2026-09-29-face-type-entries.sql
 * 注入位置 (后续 Task D):
 *   - characters.ts imagePrompt 拼接 (code-side 1-2 条精选)
 *   - grid-prompt-tools.ts generateCharacterPrompt (LLM-side few-shot 5-8 条)
 *
 * 路由: /api/v1/face-entries/* (注册在 src/index.ts)
 *   GET  /             列表查询 (factor? gender? limit?)
 *   POST /sync         Mac cron 原子事务同步 (insert 新 + delete 旧 + 校验)
 *   GET  /stats        按 factor 计数 (PM dashboard 排查同步状态)
 */
import { Hono } from 'hono'
import { eq, and, sql, desc, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'

const app = new Hono()

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

/** GET /face-entries — 列表查询, 按 factor/gender 过滤, 默认 20 条, 上限 100 */
app.get('/', async (c) => {
  const factor = c.req.query('factor')
  const gender = c.req.query('gender')
  const limitParam = c.req.query('limit')
  const limit = Math.min(
    Math.max(parseInt(limitParam || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )

  const conditions = []
  if (factor) conditions.push(eq(schema.faceTypeEntries.factor, factor))
  if (gender) conditions.push(eq(schema.faceTypeEntries.gender, gender))

  const where = conditions.length ? and(...conditions) : undefined
  const rows = db.select().from(schema.faceTypeEntries)
    .where(where)
    .orderBy(desc(schema.faceTypeEntries.archivedAt))
    .limit(limit)
    .all()

  const total = db.select({ count: sql<number>`count(*)` })
    .from(schema.faceTypeEntries)
    .where(where)
    .all()[0]?.count ?? 0

  // 还原 data JSON.parse — 让前端能直接拿 prompt_tokens 等原始字段
  const entries = rows.map((r) => {
    let parsed: unknown = null
    try { parsed = JSON.parse(r.data) } catch { parsed = {} }
    return {
      id: r.id,
      factor: r.factor,
      externalId: r.externalId,
      name: r.name,
      nameEn: r.nameEn,
      gender: r.gender,
      promptTokens: r.promptTokens,
      data: parsed,
    }
  })

  return success(c, { entries, total, limit })
})

/**
 * POST /face-entries/sync — Mac cron 原子同步
 *
 * Body: { entries: Array<{ factor, externalId, name, nameEn?, data, promptTokens?, gender?, source? }>, archivedAt: ISO8601 }
 *
 * 三阶段事务 (drizzle better-sqlite3 transaction, throw → 全部 rollback):
 *   1. delete 旧条目 where archived_at != newArchivedAt (新数据 arrive, 旧 archived_at 整批清掉)
 *   2. insert 新条目 (按 factor+externalId 唯一索引, 重复 → UNIQUE 约束抛错回滚)
 *   3. 校验 total_received == inserted, 不等抛错回滚
 *
 * 幂等性:
 *   - 同 archivedAt 第二次 push: delete 阶段不删 (archived_at 一致), insert 阶段撞 UNIQUE 索引 → 回滚 → 返回 { partialSynced: 0 }
 *   - 不同 archivedAt (face-archive 数据变更): delete 阶段清掉旧 archived_at 条目, insert 新条目 → 全替换
 *
 * atomic_safety: < 100ms 事务, 99.99% 不会撞上 LLM 调用 (Task D code-side SELECT 是只读, 不阻塞)
 */
app.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return badRequest(c, 'Invalid JSON body')
  const rawEntries = Array.isArray(body.entries) ? body.entries : null
  const newArchivedAt = body.archivedAt
  if (!rawEntries || rawEntries.length === 0) return badRequest(c, 'entries array is required (empty not allowed)')
  if (!newArchivedAt || typeof newArchivedAt !== 'string') return badRequest(c, 'archivedAt (ISO8601 string) is required')

  // 字段校验 (基本格式, 详细校验在事务内)
  for (const [i, e] of rawEntries.entries()) {
    if (!e || typeof e.factor !== 'string') return badRequest(c, `entries[${i}].factor is required (string)`)
    if (!e.externalId || typeof e.externalId !== 'string') return badRequest(c, `entries[${i}].externalId is required (string)`)
    if (!e.name || typeof e.name !== 'string') return badRequest(c, `entries[${i}].name is required (string)`)
    if (!e.data || typeof e.data !== 'object') return badRequest(c, `entries[${i}].data is required (object)`)
  }

  const ts = now()
  let deletedCount = 0
  let insertedCount = 0
  let receivedCount = rawEntries.length

  try {
    db.transaction((tx) => {
      // 1. delete 旧条目 (archived_at != newArchivedAt)
      const delRes = tx.delete(schema.faceTypeEntries)
        .where(ne(schema.faceTypeEntries.archivedAt, newArchivedAt))
        .run()
      deletedCount = delRes.changes

      // 2. insert 新条目
      const values = rawEntries.map((e: any) => ({
        factor: e.factor,
        externalId: e.externalId,
        name: e.name,
        nameEn: e.nameEn ?? null,
        data: JSON.stringify(e.data),
        promptTokens: e.promptTokens ?? (e.data && typeof e.data === 'object' && e.data.prompt_tokens) ? e.data.prompt_tokens : null,
        gender: e.gender ?? null,
        source: e.source ?? 'face-archive',
        archivedAt: newArchivedAt,
        syncedAt: ts,
        createdAt: ts,
      }))
      const insRes = tx.insert(schema.faceTypeEntries).values(values).run()
      insertedCount = insRes.changes

      // 3. 校验 received == inserted (better-sqlite3 insert.changes 反映受影响行数)
      if (insertedCount !== receivedCount) {
        throw new Error(`insert mismatch: received=${receivedCount} inserted=${insertedCount}`)
      }
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: `Sync failed (transaction rolled back): ${err.message}`,
      partialSynced: 0,
      receivedCount,
    }, 500)
  }

  return success(c, {
    receivedCount,
    insertedCount,
    deletedCount,
    archivedAt: newArchivedAt,
    syncedAt: ts,
  })
})

/** GET /face-entries/stats — 按 factor 计数 + total, PM dashboard 排查同步状态 */
app.get('/stats', async (c) => {
  const counts = db.select({
    factor: schema.faceTypeEntries.factor,
    count: sql<number>`count(*)`,
  })
    .from(schema.faceTypeEntries)
    .groupBy(schema.faceTypeEntries.factor)
    .all()

  const total = counts.reduce((s, r) => s + r.count, 0)

  // 转成 { factor: count } map 给前端方便用
  const byFactor: Record<string, number> = {}
  for (const r of counts) byFactor[r.factor] = r.count

  return success(c, { counts: byFactor, total })
})

export default app

import { Hono } from 'hono'
import { eq, and, isNull, like, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
// ★ 单 msg-20261127-002: 剧集画幅存 dramas.metadata (不改 schema)
import { stringifyDramaMetadata } from '../utils/drama-aspect.js'
import { DEFAULT_TEMPLATE_ID } from '../prompt-templates/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { getActiveVideoConfigLabel } from '../services/ai.js'
// ★ Sprint 50 T2 (PM msg-20261117-201): 存量角色重算要有 flow-log 记录 (处理了哪些角色/新旧值)
import { logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
// ★ Sprint 47 T1 (PM msg-20261115-188): 角色级语音参数的批量自动推导
import {
  deriveCharacterVoiceParams, serializeVoiceParams, isVoiceParamsEmpty, parseVoiceParams,
} from '../services/character-voice-params.js'

const app = new Hono()

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  let query = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))

  const allRows = await query.orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    // ★ Sprint 26 Task B: 过滤已软删的剧集 (否则删掉的集还显示在剧集列表里 = 删除没生效)
    const eps = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, drama.id), isNull(schema.episodes.deletedAt)))
    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, drama.id))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, drama.id))
    return {
      ...toSnakeCase(drama),
      tags: drama.tags ? JSON.parse(drama.tags) : [],
      total_episodes: eps.length,
      episodes: toSnakeCaseArray(eps).map((ep: any) => ({
      ...ep,
      // 2026-10-12 sprint 43 FIX-7: 跟后端 getActiveConfig('video') 行为对齐, 不再误显示"未配置"
      activeVideoConfigLabel: getActiveVideoConfigLabel(ep.videoConfigId),
    })),
      characters: toSnakeCaseArray(chars),
      scenes: toSnakeCaseArray(scns),
    }
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: body.style,
    // 2026-09-23: 角色美学独立维度, nullable, 默认 null → 代码 fallback 'neutral'
    characterAesthetic: body.character_aesthetic ?? null,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: stringifyDramaMetadata(body.metadata),
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [result] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, Number(res.lastInsertRowid))).all()

  // Create default episodes
  const totalEpisodes = body.total_episodes || 1
  for (let i = 1; i <= totalEpisodes; i++) {
    db.insert(schema.episodes).values({
      dramaId: result.id,
      episodeNumber: i,
      title: `第${i}集`,
      status: 'draft',
      // ★ Sprint 25 (PM msg-20261027-112): 新建 drama 的默认 episode 模板 = H3 (同上, 必须显式写)
      promptTemplate: DEFAULT_TEMPLATE_ID,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt)).all()
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!drama) return notFound(c, '剧本不存在')

  // ★ Sprint 26 Task B: 同样过滤已软删的剧集
  const eps = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, id), isNull(schema.episodes.deletedAt)))
  const chars = await db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, id))
  const scns = await db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, id))
  const prps = await db.select().from(schema.props)
    .where(eq(schema.props.dramaId, id))

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: toSnakeCaseArray(eps).map((ep: any) => ({
      ...ep,
      // 2026-10-12 sprint 43 FIX-7: 跟后端 getActiveConfig('video') 行为对齐, 不再误显示"未配置"
      activeVideoConfigLabel: getActiveVideoConfigLabel(ep.videoConfigId),
    })),
    characters: toSnakeCaseArray(chars),
    scenes: toSnakeCaseArray(scns),
    props: toSnakeCaseArray(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.character_aesthetic !== undefined) updates.characterAesthetic = body.character_aesthetic
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) {
    // ★ 单 002: 支持传对象或 JSON 字符串, 统一按字符串落库 (dramas.metadata 是 TEXT)
    updates.metadata = stringifyDramaMetadata(body.metadata)
  }
  db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id)).run()
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id))
  return success(c)
})

// PUT /dramas/:id/characters - Save characters
/**
 * ★ Sprint 47 T1 (PM msg-20261115-188): 为整个 drama 的角色【批量按特征推导语音参数】。
 *   前端音色页一个按钮搞定 (不然要一个一个点) —— 推导值直接落库, 用户还能逐个再手改。
 */
app.post('/:id/characters/voice-params/derive', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!drama) return notFound(c, 'Drama not found')
  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, id)).all()
  const items: Array<{ id: number; name: string; params: any; before: any }> = []
  let changed = 0      // ★ 推导出了参数的角色数 (前端提示用)
  let updated = 0      // ★ 落库值与旧值【真的不同】的角色数 (工单 201 T2 验收要能看出来)
  logTaskProgress('VoiceParamsDerive', 'derive-start', {
    dramaId: id, total: chars.length,
    hint: '按角色特征重新推导音高/音量档位 (Sprint 50 T1 新档表: 45-59 新增一档, 女声不再被压进男声区)',
  })
  for (const ch of chars) {
    if (ch.deletedAt) continue
    const derived = deriveCharacterVoiceParams({
      name: ch.name,
      role: ch.role,
      description: ch.description,
      personality: ch.personality,
      appearancePermanent: ch.appearancePermanent,
      permanentTraits: ch.permanentTraits,
    })
    // ★ 旧值 (解析成对象, 便于日志/响应里对比新旧)
    const before = parseVoiceParams(ch.voiceParams ?? null)
    if (isVoiceParamsEmpty(derived)) {
      items.push({ id: ch.id, name: ch.name, params: {}, before })
      logTaskProgress('VoiceParamsDerive', 'character-empty', {
        dramaId: id, characterId: ch.id, name: ch.name, before,
        hint: '推导不出参数 (年龄/性别读不出来) → 保持现状, 不写入',
      })
      continue
    }
    const serialized = serializeVoiceParams(derived)
    const valueChanged = serialized !== (ch.voiceParams ?? '')
    db.update(schema.characters)
      .set({ voiceParams: serialized, updatedAt: now() })
      .where(eq(schema.characters.id, ch.id))
      .run()
    changed++
    if (valueChanged) updated++
    items.push({ id: ch.id, name: ch.name, params: derived, before })
    logTaskProgress('VoiceParamsDerive', 'character-derived', {
      dramaId: id, characterId: ch.id, name: ch.name,
      before, after: derived, valueChanged,
    })
  }
  logTaskSuccess('VoiceParamsDerive', 'derive-done', {
    dramaId: id, total: chars.length, derived: changed, updated,
    hint: 'derived = 推导出了参数的角色数; updated = 落库值与旧值真的不同的角色数',
  })
  return success(c, { dramaId: id, total: chars.length, changed, updated, items })
})

app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      await db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        // ★ Sprint 25: 批量新建 episode 时也要显式写默认模板 (同上)
        promptTemplate: (ep.prompt_template ? String(ep.prompt_template).trim() : '') || DEFAULT_TEMPLATE_ID,
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

export default app

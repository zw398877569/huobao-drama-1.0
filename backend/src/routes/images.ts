import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /images — Generate image
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    // 防御性：兼容 "<configId>:<modelName>" 复合格式（多模型选择器）
    const { configId: explicitConfigId, model: explicitModel } = parseConfigIdWithModel(body.config_id)
    // 优先级: 用户弹窗显式选的 > episode 锁定的 image_config_id > getActiveConfig fallback
    let configId: number | undefined = explicitConfigId
    if (configId === undefined && body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.imageConfigId != null) configId = ep.imageConfigId
      }
    }

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', body)
    // 所有 image 生成路径都过 sanitize(角色/场景/分镜/grid 共用)
    // Sprint 21 (QA msg-20261025-085): 按 body 里的 id 推断 kind ——
    //   storyboard_id → 镜头图 (本路由当前唯一的调用方就是镜头图; 优先判断, 免得将来
    //                    镜头图请求里带了 scene_id 被误判成"空场景" → 镜头里的人被剥掉)
    //   character_id  → 角色设定稿 (中性背景约束) / scene_id → 场景 (空场景约束)
    const imageKind = body.storyboard_id ? 'shot'
      : (body.character_id ? 'character' : (body.scene_id ? 'scene' : 'shot'))
    const safePrompt = await sanitizeImagePrompt(body.prompt, { kind: imageKind })
    const id = await generateImage({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      prompt: safePrompt,
      model: body.model || explicitModel,
      size: body.size,
      referenceImages: body.reference_images,
      frameType: body.frame_type,
      configId,
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    logTaskSuccess('ImageAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /images — List by storyboard_id, drama_id, or episode_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')
  const episodeId = c.req.query('episode_id')

  let rows = db.select().from(schema.imageGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  // episode_id: 通过 storyboards 表关联过滤，避免跨集宫格历史混在一起
  if (episodeId) {
    const episodeStoryboardIds = db.select({ id: schema.storyboards.id })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, Number(episodeId)))
      .all()
      .map(r => r.id)
    rows = rows.filter(r => r.dramaId === Number(dramaId) && (episodeStoryboardIds.includes(r.storyboardId) || !r.storyboardId))
  }

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

export default app

import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
// ★ Sprint 31 追加 (PM msg-20261102-137): 画面内文字保护 (引号内容 → <screen_text>)
import { wrapQuotedAsScreenText, maskScreenText, restoreScreenText } from '../utils/screen-text.js'
// ★ Sprint 36 追加 (T3, PM msg-20261107-159): 本镜【显式关联道具】的表面文字 → 注进帧 prompt
import { buildPropScreenTextInjection } from '../utils/screen-text.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

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
    // ★ Sprint 28 fix_2 (PM msg-20261028-129): 参考图超限被丢弃的清单 → 进 flow-log。
    //   原来只有前端 console 直打 stdout, 用户在页面上完全看不到自己哪张角色图被挤掉了。
    if (Array.isArray(body.dropped_references) && body.dropped_references.length) {
      const droppedChars = body.dropped_references.filter((d: any) => d?.kind === 'character')
      logTaskWarn('ImageAPI', 'reference-dropped', {
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        frameType: body.frame_type,
        droppedCount: body.dropped_references.length,
        droppedCharacterCount: droppedChars.length,
        dropped: body.dropped_references,
        hint: droppedChars.length
          ? '本镜的参考图超过上限, 这些被挤掉了 —— 含角色形象图, 脸可能对不上'
          : '本镜的参考图超过上限, 这些被挤掉了',
      })
    }
    // ★ Sprint 28 fix_2: 本次用的接力图 (上一镜的末帧) —— 也进 flow-log, 不用看前端 console
    if (body.relay_shot_number != null) {
      logTaskProgress('ImageAPI', 'relay-reference', {
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        frameType: body.frame_type,
        relayShotNumber: body.relay_shot_number,
        hint: '本次首帧的参考图里含上一镜的末帧 (接力)',
      })
    }
    // 所有 image 生成路径都过 sanitize(角色/场景/分镜/grid 共用)
    // Sprint 21 (QA msg-20261025-085): 按 body 里的 id 推断 kind ——
    //   storyboard_id → 镜头图 (本路由当前唯一的调用方就是镜头图; 优先判断, 免得将来
    //                    镜头图请求里带了 scene_id 被误判成"空场景" → 镜头里的人被剥掉)
    //   character_id  → 角色设定稿 (中性背景约束) / scene_id → 场景 (空场景约束)
    const imageKind = body.storyboard_id ? 'shot'
      : (body.character_id ? 'character' : (body.scene_id ? 'scene' : 'shot'))
    // ★ Sprint 31 追加 (PM msg-20261102-137): 首尾帧 prompt 里【引号包的内容】是画面里要显示的文字
    //   (订单备注 / 门牌号), 生图链路的两道 LLM 工序 (rule F 改写 + 英文翻译) 会把它翻成英文
    //   → 手机屏上的中文线索读不出来。用 <screen_text> 包住 → 两道工序都绕开它。
    //   ★ 只对首尾帧生效 —— 角色图 / 场景图 的引号内容不是画面文字, 不动 (零回归)。
    const isShotFrame = body.frame_type === 'first_frame' || body.frame_type === 'last_frame'

    // ★ Sprint 36 追加 (T3, PM msg-20261107-159): 本镜【显式关联】的道具 → 把道具表面文字注进帧 prompt。
    //   道具图上印着的字 (例: 手机订单备注『501，王阿姨…』) 是剧情关键线索, 不在任何一句台词里
    //   → 只能靠画面承载; 不点出来的话模型只会把屏幕画成一块糊 (线索彻底丢)。
    //   ★ 只取 storyboard_props 里【显式关联】的道具, 不取本集所有道具。
    //   ★ 走的是下面那条现成的 <screen_text> 通路 (mask → sanitize → restore) → 不另写一套。
    let promptInput = body.prompt
    let injectedPropTexts: { name: string; texts: string[] }[] = []
    if (isShotFrame && body.storyboard_id) {
      const sbId = Number(body.storyboard_id)
      const links = db.select({ propId: schema.storyboardProps.propId })
        .from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, sbId)).all()
      const propIds = links.map(l => l.propId).filter(Boolean)
      if (propIds.length) {
        const propRows = db.select({ name: schema.props.name, description: schema.props.description })
          .from(schema.props).where(inArray(schema.props.id, propIds)).all()
        const { block, injected } = buildPropScreenTextInjection(propRows)
        if (block) {
          injectedPropTexts = injected
          promptInput = `${body.prompt}, ${block}`
          logTaskProgress('ImageAPI', 'prop-screen-text-injected', {
            storyboardId: sbId,
            dramaId: body.drama_id,
            frameType: body.frame_type,
            props: injected.map(x => ({ name: x.name, texts: x.texts })),
            hint: '本镜显式关联道具的表面文字已注进帧 prompt (走 <screen_text> 保护, 两道 LLM 工序都不翻译不改写)',
          })
        }
      }
    }

    //   ★ 用【占位符】而不是标签去过 sanitizer —— LLM 改写时保住一个短 ASCII token
    //     比保住整个 <screen_text>…</screen_text> 块稳得多; 改写完再还原成标签存库。
    let safePrompt: string
    if (isShotFrame) {
      const masked = maskScreenText(wrapQuotedAsScreenText(promptInput))
      const sanitized = await sanitizeImagePrompt(masked.text, { kind: imageKind })
      safePrompt = restoreScreenText(sanitized, masked.items)
    } else {
      safePrompt = await sanitizeImagePrompt(promptInput, { kind: imageKind })
    }
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

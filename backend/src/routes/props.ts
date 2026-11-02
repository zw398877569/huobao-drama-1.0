import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
// ★ Sprint 31 追加 (PM msg-20261102-137): 道具表面文字的提取与包装
import { extractPropScreenText, wrapScreenText } from '../utils/screen-text.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /props/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, id)).all()
  if (!prop) return badRequest(c, 'Prop not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  // prompt 优先级：生成的 image_prompt > description fallback
  const rawPrompt = prop.prompt || prop.description || `${prop.name}, product shot, high quality`
  // ★ Sprint 31 追加 (PM msg-20261102-137): 道具表面/界面上的【真实文字】要进生图 prompt。
  //   改前只写 'customer note field containing Chinese text' 这种描述 → 模型自己编内容
  //   (实测道具图上写的是『请不要放辣椒…』, 跟剧情毫无关系) → 剧情关键线索根本没出现在道具上。
  //   ★ 只有【判定为道具表面文字】的引号内容才注入 (人名 / 台词引用那类不注入 —— 印到道具上就脏了)。
  const screenTexts = extractPropScreenText(prop.description || '')
  // Sprint 21: 接上 kind 机制 (prop 暂不改行为 —— QA fix_3 要求先调查影响面)
  let prompt = await sanitizeImagePrompt(rawPrompt, { kind: 'prop' })
  if (screenTexts.length) {
    // ★ 追加在 sanitize 【之后】—— 指令不该再过一遍 LLM 改写 (rule F 是 'comma-separated short phrases',
    //   会把指令改没了), 而 <screen_text> 块内容是画面上的字, 必须原样保留。
    const block = screenTexts.map(t => wrapScreenText(t)).join(' ')
    prompt = `${prompt}, on-screen text: ${block} — reproduce that Chinese text on the screen EXACTLY as written, character for character; do not translate it, do not rewrite it, do not add or remove any character`
    logTaskProgress('PropImage', 'screen-text-injected', { propId: id, propName: prop.name, screenTexts })
  }
  try {
    logTaskStart('PropImage', 'generate', { propId: id, episodeId: ep.id, dramaId: prop.dramaId, name: prop.name })
    // config_id 兼容 "<configId>:<modelName>" 复合格式（多模型选择器）与纯数字 ID；model 用于覆盖 config.model
    const { configId: explicitConfigId, model: explicitModel } = parseConfigIdWithModel(body?.config_id)
    const effectiveConfigId = explicitConfigId ?? ep.imageConfigId
    const genId = await generateImage({ propId: id, dramaId: prop.dramaId, prompt, configId: effectiveConfigId ?? undefined, model: explicitModel })
    logTaskSuccess('PropImage', 'generate', { propId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('PropImage', 'generate', { propId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app

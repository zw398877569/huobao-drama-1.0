import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getStylePreset } from '../services/negative-prompt-presets.js'

const app = new Hono()

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  if ('voice_style' in body || 'voiceStyle' in body) {
    updates.voiceSampleUrl = null
  }
  db.update(schema.characters).set(updates).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// POST /characters/:id/generate-voice-sample
app.post('/:id/generate-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!char.voiceStyle) return badRequest(c, '请先分配音色')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  try {
    logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle })
    const audioPath = await generateVoiceSample(char.name, char.voiceStyle, ep.audioConfigId ?? undefined)
    db.update(schema.characters)
      .set({ voiceSampleUrl: audioPath, updatedAt: now() })
      .where(eq(schema.characters.id, id)).run()
    logTaskSuccess('VoiceSample', 'generate', { characterId: id, path: audioPath })
    return success(c, { voice_sample_url: audioPath })
  } catch (err: any) {
    logTaskError('VoiceSample', 'generate', { characterId: id, error: err.message })
    return badRequest(c, 'TTS 生成失败: ' + err.message)
  }
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const charDetail = char.appearance || char.description || ''
  const personality = char.personality || ''
  const [drama] = db.select({ style: schema.dramas.style })
    .from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
  const stylePreset = getStylePreset(drama?.style || undefined)
  const rawPrompt = [
    char.name,
    charDetail,
    personality ? 'personality: ' + personality : '',
    stylePreset.positiveCharacterTokens,
    'character reference sheet, official character design',
    'layout: large full-body portrait on left, three-view figures (front/side/back) on right',
    'includes: face closeup, eye detail, hair detail, outfit detail, accessory detail',
    'consistent character design across all views, clean light gradient background',
    'high quality, detailed illustration, professional character art',
  ].filter(Boolean).join(', ')
  const prompt = await sanitizeImagePrompt(rawPrompt)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  // 预查询所有相关 drama 的 style — 避免 N+1 查询(批量生图时多角色通常同属一个 drama)
  const matchedChars = db.select({ id: schema.characters.id, dramaId: schema.characters.dramaId })
    .from(schema.characters)
    .where(inArray(schema.characters.id, ids.length ? ids : [0])).all()
  const uniqueDramaIds = Array.from(new Set(matchedChars.map(c => c.dramaId)))
  const dramaStyleMap = new Map<number, ReturnType<typeof getStylePreset>>()
  for (const did of uniqueDramaIds) {
    const [drama] = db.select({ style: schema.dramas.style })
      .from(schema.dramas).where(eq(schema.dramas.id, did)).all()
    dramaStyleMap.set(did, getStylePreset(drama?.style || undefined))
  }
  const results: number[] = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    const charDetail = char.appearance || char.description || ''
    const personality = char.personality || ''
    const stylePreset = dramaStyleMap.get(char.dramaId) || getStylePreset(undefined)
    const rawPrompt = [
      char.name,
      charDetail,
      personality ? 'personality: ' + personality : '',
      stylePreset.positiveCharacterTokens,
      'character reference sheet, official character design',
      'layout: large full-body portrait on left, three-view figures (front/side/back) on right',
      'includes: face closeup, eye detail, hair detail, outfit detail, accessory detail',
      'consistent character design across all views, clean light gradient background',
      'high quality, detailed illustration, professional character art',
    ].filter(Boolean).join(', ')
    const prompt = await sanitizeImagePrompt(rawPrompt)
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app

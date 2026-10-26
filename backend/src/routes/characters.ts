import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
// Sprint 12 Task B (PM msg-20261017-072): 立绘 prompt 后置保险 — gender 被 LLM 改写丢失时 append 英文兜底词
import { extractGenderTrait, ensureGenderInPrompt } from '../utils/gender-guard.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getStylePreset } from '../services/negative-prompt-presets.js'
import { getCharacterAestheticTokens } from '../constants/character-aesthetics.js'
import { getAgeAnchorTokens } from '../constants/age-anchor.js'
import { selectForCodeSide, logFewshotSelection } from '../services/face-archive-service.js'

const app = new Hono()

// GET /characters/:id — fetch single character (2026-09-24 PM msg-20260924-002 task_D)
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [char] = db.select().from(schema.characters)
    .where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  return success(c, {
    id: char.id,
    drama_id: char.dramaId,
    name: char.name,
    role: char.role,
    description: char.description,
    appearance_permanent: char.appearancePermanent,
    personality: char.personality,
    voice_style: char.voiceStyle,
    voice_provider: char.voiceProvider,
    voice_sample_url: char.voiceSampleUrl,
    image_url: char.imageUrl,
    local_path: char.localPath,
    reference_images: char.referenceImages,
    seed_value: char.seedValue,
    sort_order: char.sortOrder,
    created_at: char.createdAt,
    updated_at: char.updatedAt,
  })
})

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  // V2 治本 (msg-20261010-001): characters 表 plot_state 列被 DROP, 'appearance' 字段也已被 RENAME → 仅允许 appearancePermanent
  for (const key of ['name', 'role', 'description', 'appearancePermanent', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
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

  // V2 治本 (msg-20261010-001): 只读 appearancePermanent (PERMANENT 列), 不再 fallback deprecated appearance 列 (已被 RENAME)
  const charDetail = char.appearancePermanent || char.description || ''
  const personality = char.personality || ''
  const [drama] = db.select({ style: schema.dramas.style, characterAesthetic: schema.dramas.characterAesthetic })
    .from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
  const stylePreset = getStylePreset(drama?.style || undefined)
  // 2026-09-23 PM msg-20260923-002 fix #2: 注入角色美学 token (独立维度, 与 stylePreset 解耦)
  const aestheticTokens = getCharacterAestheticTokens(drama?.characterAesthetic)
  // Sprint 5 Task D: face-archive code-side 1-2 条精选 (latest archivedAt DESC)
  // V2 治本 (msg-20261010-001): appearance 列已被 RENAME → DROP, 不再传给 CharacterContext
  // ★ Sprint 24 fix_1 (PM msg-20261026-101): face-archive 档案块【不再拼进生图 prompt】。
  //   实测 (drama 16 ep16): 选到的档案条目全是古风 (danfeng phoenix eyes / bean-paste lips /
  //   silver hairpin / classical chinese beauty / low chignon) → rule F 要求
  //   "Keep every concrete detail of the original description" → LLM 忠实照抄进英文 prompt
  //   → 角色图长出剧本里没有的【银色发簪】+【盘发】, 还多出围裙和手表。
  //   根因: selectForCodeSide 的 _drama 参数根本没被使用 (只按 factor='Face' + gender 过滤),
  //   face_type_entries 表也没有【风格/题材】维度 → 做不出安全的风格门控,
  //   对现代题材项目参考价值 ≈ 0 (库里最近归档的条目全是古风)。
  //   082/083 的剥除逻辑只写在 fallback 分支 —— 之前 240 字符上限意外充当了过滤器,
  //   rule F 放宽上限 (0060bc0) 后档案块就原样回来了。
  //   ⚠️ 选档 + 留痕保留 (还能在 flow log 里看到候选条目), 只是不再喂给 LLM。
  //   要恢复这个功能, 前置条件是 face_type_entries 能按 drama 风格/题材过滤。
  const faceArchiveEntries = selectForCodeSide({ id: char.dramaId, style: drama?.style, characterAesthetic: drama?.characterAesthetic }, { id: char.id, name: char.name, personality: char.personality, dramaId: char.dramaId, appearancePermanent: char.appearancePermanent, permanentTraits: char.permanentTraits }, 2)
  if (faceArchiveEntries.length) logFewshotSelection({ scope: 'code-side', dramaId: char.dramaId, characterId: char.id, entries: faceArchiveEntries })
  // Sprint 5 Task G: AGE ANCHOR 独立模块 (跟 face-archive 解耦, 三段并列硬拼)
  // V2 治本 (msg-20261010-001): 只读 appearancePermanent (PERMANENT 列)
  const ageAnchorTokens = getAgeAnchorTokens(char.appearancePermanent || char.description)
  const rawPrompt = [
    char.name,
    charDetail,
    // Sprint 21 fix_2: 背景约束提前 + 写得更硬。
    //   LLM 改写被规则 F 卡在 240 字符 (inLen 2236 → outLen 240, 模板被压缩 89%),
    //   原来的 'clean light gradient background' 排在最后 → 被挤掉 → 背景语义丢失 →
    //   生图模型自由发挥成户外院子。放前面 + 写死"中性影棚背景 + 不得出现环境元素"。
    'neutral plain seamless studio backdrop, even soft lighting, no environment, no room, no street, no outdoor scenery',
    personality ? 'personality: ' + personality : '',
    stylePreset.positiveCharacterTokens,
    aestheticTokens,
    ageAnchorTokens,
    'character reference sheet, official character design, focusing on the character\'s permanent visual identity (appearance, look, expression, posture, outfit)',
    // V2 治本 (msg-20261010-001): 移除 'ignore PLOT_STATE' 文字指令 — 数据源头已分 PERMANENT / PLOT_STATE 两列,
    //   拼接 image_prompt 时只读 character.appearance_permanent, 物理层面不可能再误读 plot_state。
    'do NOT include story-specific props, actions, or objects that only appear in particular scenes (e.g. "front paw rests on a red button" is a plot moment, not a permanent feature),',
    'AGE ANCHOR: if a numeric age is mentioned (e.g. "25 years old", "around 30"), pin the character to that exact integer; if vague ("young", "middle-aged"), default to 25-30 for protagonist or elderly for aged roles; do NOT free-render into 50+ when "around 30" is given,',
    'layout: large full-body portrait on left, three-view figures (front/side/back) on right',
    // ★ Sprint 24 fix_2 (PM msg-20261026-101): 原来这行是 'includes: face closeup, eye detail,
    //   hair detail, outfit detail, accessory detail' —— 清单式措辞 + 'accessory detail'
    //   会让模型 (a) 把这些当成"要标注在图上的条目" → 图上出现文字标签;
    //   (b) 凭空造饰品 (drama 15 的银发簪 / drama 16 的手表和围裙都是这么来的)。
    //   改成描述画面本身, 不列条目, 也不指向具体物件类别。
    'showing the same facial features, hairstyle and outfit in every view',
    'consistent character design across all views',
    'high quality, detailed illustration, professional character art',
  ].filter(Boolean).join(', ')
  // Sprint 21 (QA msg-20261025-085) fix_2: 角色形象图的背景必须中性, 不能由模型自由发挥
  //   (实测王秀兰 82104a51 被放到户外院子+灯笼+盆栽, 剧本写的是'约20平米一室一厅室内')。
  //   kind='character' → LLM 分支规则 + LLM 之后追加中性影棚背景硬约束。
  const sanitizedPrompt = await sanitizeImagePrompt(rawPrompt, { kind: 'character' })
  // Sprint 12 Task B: 后置保险 — sanitizeImagePrompt 是 LLM 改写环节, 可能把 gender 丢掉
  //   (实际事故: drama 14 林达剧本明确"男" 被改写成 'Linda East Asian woman')。
  //   纯正则校验, 不调 LLM 不增加耗时; 老数据无 gender trait (PM D2 锁定不回填) → 自动跳过。
  const prompt = ensureGenderInPrompt(sanitizedPrompt, extractGenderTrait(char.permanentTraits), {
    characterId: id,
    dramaId: char.dramaId,
  })
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    // config_id 兼容 "<configId>:<modelName>" 复合格式（多模型选择器）与纯数字 ID；model 用于覆盖 config.model
    const { configId: explicitConfigId, model: explicitModel } = parseConfigIdWithModel(body?.config_id)
    const effectiveConfigId = explicitConfigId ?? ep.imageConfigId
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, configId: effectiveConfigId ?? undefined, model: explicitModel })
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
  // 2026-09-23 PM msg-20260923-002 fix #2: 预查询 drama.style + characterAesthetic (避免 N+1)
  const dramaStyleMap = new Map<number, ReturnType<typeof getStylePreset>>()
  const dramaAestheticMap = new Map<number, string>()
  for (const did of uniqueDramaIds) {
    const [drama] = db.select({ style: schema.dramas.style, characterAesthetic: schema.dramas.characterAesthetic })
      .from(schema.dramas).where(eq(schema.dramas.id, did)).all()
    dramaStyleMap.set(did, getStylePreset(drama?.style || undefined))
    dramaAestheticMap.set(did, getCharacterAestheticTokens(drama?.characterAesthetic))
  }
  const results: number[] = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    // V2 治本 (msg-20261010-001): 只读 appearancePermanent (PERMANENT 列), 不再 fallback deprecated appearance 列 (已被 RENAME)
  const charDetail = char.appearancePermanent || char.description || ''
    const personality = char.personality || ''
    const stylePreset = dramaStyleMap.get(char.dramaId) || getStylePreset(undefined)
    const aestheticTokens = dramaAestheticMap.get(char.dramaId) || ''
    // Sprint 5 Task D: face-archive code-side 1-2 条精选 (batch 路径)
    // ★ Sprint 24 fix_1: 同单个路径 —— 档案块只留痕, 不进 prompt (古风污染源)
    const faceArchiveEntries = selectForCodeSide({ id: char.dramaId, style: dramaStyleMap.get(char.dramaId)?.slug, characterAesthetic: dramaAestheticMap.get(char.dramaId) || undefined }, { id: char.id, name: char.name, personality: char.personality, dramaId: char.dramaId, appearancePermanent: char.appearancePermanent, permanentTraits: char.permanentTraits }, 2)
    if (faceArchiveEntries.length) logFewshotSelection({ scope: 'code-side', dramaId: char.dramaId, characterId: char.id, entries: faceArchiveEntries })
    // Sprint 5 Task G: AGE ANCHOR 独立模块 (batch 路径)
    // V2 治本 (msg-20261010-001): 只读 appearancePermanent (PERMANENT 列)
    const ageAnchorTokens = getAgeAnchorTokens(char.appearancePermanent || char.description)
    const rawPrompt = [
      char.name,
      charDetail,
      // Sprint 21 fix_2: 同单个路径 (背景约束提前)
      'neutral plain seamless studio backdrop, even soft lighting, no environment, no room, no street, no outdoor scenery',
      personality ? 'personality: ' + personality : '',
      stylePreset.positiveCharacterTokens,
      aestheticTokens,
      ageAnchorTokens,
      'character reference sheet, official character design, focusing on the character\'s permanent visual identity (appearance, look, expression, posture, outfit)',
    'do NOT include story-specific props, actions, or objects that only appear in particular scenes (e.g. "front paw rests on a red button" is a plot moment, not a permanent feature),',
      'layout: large full-body portrait on left, three-view figures (front/side/back) on right',
      // ★ Sprint 24 fix_2: 同单个路径 (清单式措辞 → 描述式)
      'showing the same facial features, hairstyle and outfit in every view',
      'consistent character design across all views',
      'high quality, detailed illustration, professional character art',
    ].filter(Boolean).join(', ')
    // Sprint 21 fix_2: 同单个路径 (kind='character')
    const sanitizedPrompt = await sanitizeImagePrompt(rawPrompt, { kind: 'character' })
    // Sprint 12 Task B: 同 B1, 每个角色独立校验各自的 gender (批量不能共用一个判断)
    const prompt = ensureGenderInPrompt(sanitizedPrompt, extractGenderTrait(char.permanentTraits), {
      characterId: cid,
      dramaId: char.dramaId,
    })
    try {
      // config_id 兼容 "<configId>:<modelName>" 复合格式（多模型选择器）与纯数字 ID；model 用于覆盖 config.model
      const { configId: explicitConfigId, model: explicitModel } = parseConfigIdWithModel(body?.config_id)
      const effectiveConfigId = explicitConfigId ?? ep.imageConfigId
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, configId: effectiveConfigId ?? undefined, model: explicitModel })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app

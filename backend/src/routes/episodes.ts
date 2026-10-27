import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DEFAULT_TEMPLATE_ID } from '../prompt-templates/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase } from '../utils/transform.js'

const app = new Hono()

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  if (!body.image_config_id || !body.video_config_id || !body.audio_config_id) {
    return badRequest(c, 'image_config_id, video_config_id and audio_config_id are required')
  }
  const ts = now()

  // Get next episode number
  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, body.drama_id))
    .orderBy(schema.episodes.episodeNumber).all()
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  // Step 4.E: target_duration 可选 (UI 滑块), null 表示用 estimator 自动算
  const targetDuration = (typeof body.target_duration === 'number' && body.target_duration > 0)
    ? Math.round(body.target_duration) : null

  const res = db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId: body.image_config_id,
    videoConfigId: body.video_config_id,
    audioConfigId: body.audio_config_id,
    // ★ Sprint 25 (PM msg-20261027-112): 新建 episode 的 prompt 模板默认 H3。
    //   必须【显式写】—— 列是 TEXT NOT NULL DEFAULT 'general', 不写就落到数据库默认值,
    //   DEFAULT_TEMPLATE_ID 改了也白改 (老库的列默认值烤在 sqlite_master 里, 改不动)。
    promptTemplate: (body.prompt_template ? String(body.prompt_template).trim() : '') || DEFAULT_TEMPLATE_ID,
    // Step 4.E: schema 列由 Step 3.D 添加 (db/index.ts:41)
    ...(targetDuration != null ? { targetDuration } : {}),
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(res.lastInsertRowid))).all()
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    audio_config_id: ep.audioConfigId,
    text_config_id: ep.textConfigId ?? null,  // Sprint 6 Task F — 分镜拆解模型选择持久化
    target_duration: ep.targetDuration,
  })
})

// POST /episodes/estimate-target-duration — 智能估算目标时长 (Step 4.E)
//   body: { drama_id: number, episode_number?: number }
//   用途: UI 在创建集表单上点 "智能估算" 按钮时调用, 给一个建议值
//   策略 (heuristic, 新集没有 scenes/storyboards 不能跑完整 estimator):
//     - 基线 100s (AI 漫剧主流时长, B3 调研 P50)
//     - 加权: 现有 episode 已有 targetDuration → 取均值
//       现有 episode 没设置 → 用上面基线 (其决策被 estimator 给忽略)
//     - 边界: clamp 到 [60, 240] (UI 滑块范围)
//   真正完整版 (post估算): 调 lib/episode-duration-estimator.estimateTargetDuration(episodeId)
app.post('/estimate-target-duration', async (c) => {
  const body = await c.req.json().catch(() => ({} as any))
  const dramaId = Number(body.drama_id)
  if (!dramaId) return badRequest(c, 'drama_id required')

  // Step 4.E default baseline: 100s (跟 DEFAULT_EPISODE_TARGET_SECONDS 对齐)
  const BASELINE = 100
  const MIN_S = 60
  const MAX_S = 240

  // 取本 drama 已有 episode 的 targetDuration 平均值作为 prior
  const eps = db.select({ targetDuration: schema.episodes.targetDuration })
    .from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .all()
  const explicit = eps.map(e => e.targetDuration).filter((v): v is number => typeof v === 'number' && v > 0)
  const heuristic = explicit.length
    ? Math.round(explicit.reduce((a, b) => a + b, 0) / explicit.length)
    : BASELINE
  const clamped = Math.max(MIN_S, Math.min(MAX_S, heuristic))

  return success(c, {
    target_duration: clamped,
    source: explicit.length ? 'drama-average' : 'baseline',
    sample_count: explicit.length,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  // ★ Sprint 26 Task B follow-up (可选边界 a): 已软删的集当不存在 —— 不允许再改名/改配置。
  if (!getActiveEpisode(id)) return notFound(c, 'Episode not found')
  const body = await c.req.json()

  // Step 4.E: target_duration 加入允许字段 (UI 编辑 episode 也可改)
  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'target_duration', 'text_config_id']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, 'no valid fields')

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  // Step 4.E: target_duration 校验 + 写入, null 表示恢复自动估算
  if ('target_duration' in updates) {
    const v = updates.target_duration
    drizzleUpdates.targetDuration = (typeof v === 'number' && v > 0) ? Math.round(v) : null
  }
  // Sprint 6 Task F — 分镜拆解模型选择持久化 (D1 决策, 跟 image/video/audio config_id 一致)
  // null = 清除, 走 active text config fallback (Task B 'text-config-fallback' log)
  if ('text_config_id' in updates) {
    const v = updates.text_config_id
    drizzleUpdates.textConfigId = (typeof v === 'number' && v > 0) ? v : null
  }

  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))
  return success(c)
})

/**
 * 同一 episode 下按 storyboard_number 去重 (保留 id 最大的那条)。
 *
 * 反复拆解/重新生成本镜头时, 数据库会残留重复 storyboard_number 记录
 * (GET /episodes/:episode_id/storyboards 原本就有这个去重, 见那里的注释)。
 * ★ Sprint 26 Task B follow-up (PM msg-20261027-123): stats 接口也必须用同一套去重 ——
 *   否则确认框里的分镜数会翻倍 (实测 ep4: 原始 84 行 → 实际 42 镜)。
 * 两处共用这个函数 → 口径永远一致。
 */
function dedupeStoryboards<T extends { id: number; storyboardNumber: number }>(rows: T[]): T[] {
  const dedupeMap = new Map<number, T>()
  for (const r of rows) {
    const cur = dedupeMap.get(r.storyboardNumber)
    if (!cur || r.id > cur.id) dedupeMap.set(r.storyboardNumber, r)
  }
  return Array.from(dedupeMap.values()).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

/**
 * 取 episode —— 已软删的当【不存在】(Sprint 26 Task B, PM msg-20261027-121)
 *
 * ★ episodes 表本来就有 deleted_at 列 (schema + 用户的库里都有), 只是从来没启用过软删逻辑。
 *   这里开始启用它: 非空 = 已删除 → 所有按 episodeId 查的接口都要当它不存在。
 */
function getActiveEpisode(episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || ep.deletedAt) return null
  return ep
}

// GET /episodes/:id/stats — 删除前的规模统计 (Sprint 26 Task B)
//   给前端的二次确认框用: 让用户知道删的是什么规模。
//   ⚠️ 走【预查】而不是 DELETE 的响应 —— 确认框在删除【之前】弹, DELETE 的返回已经晚了。
app.get('/:id/stats', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const ep = getActiveEpisode(episodeId)
  if (!ep) return notFound(c, 'Episode not found')

  // ★ 先按 storyboard_number 去重 (跟 GET /episodes/:episode_id/storyboards 同一套口径)
  //   不去重的话, 反复拆解/重新生成残留的重复行会让分镜数翻倍 (实测 ep4: 84 行 → 实际 42 镜)。
  const sbs = dedupeStoryboards(
    db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
  )
  // 图片数口径: 该集分镜里【已经产出图】的【镜】数 (首帧/尾帧任一非空)。
  //   不用 image_generations 的记录数 —— 那会把废弃的重新生成版本也算进去, 数字偏大。
  const imageCount = sbs.filter(s => !!(s.firstFrameImage || s.lastFrameImage)).length
  // ★ 视频数口径跟图片数【完全对称】: 同一份去重后的分镜列表里【已经产出视频】的镜数。
  //   原来用的是 video_generations 的【记录数】(ep17 = 4, 其中 storyboard 910 生成了两次
  //   —— id 195 @02:08 与 id 197 @03:19, 后者是重新生成) → 与图片数自相矛盾。
  //   现在跟图片数一样按【实际产出的镜】算 → ep17 = 3。
  const videoCount = sbs.filter(s => !!(s.videoUrl)).length

  return success(c, {
    episode_id: episodeId,
    episode_title: ep.title,
    storyboard_count: sbs.length,
    image_count: imageCount,
    video_count: videoCount,
  })
})

// DELETE /episodes/:id — 软删 (Sprint 26 Task B)
//   照抄 dramas.ts:156 的做法: 只打 deletedAt 标记, 【不删】storyboards / 图片 / 视频 / 磁盘文件。
//   删一集连带毁掉 N 个分镜 + 图片 + 视频, 不可恢复风险太大 → 软删, 跟 drama 保持一致。
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
  if (!ep) return notFound(c, 'Episode not found')
  if (ep.deletedAt) return success(c, { id, already_deleted: true })
  await db.update(schema.episodes)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.episodes.id, id))
    .run()
  return success(c, { id })
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!getActiveEpisode(episodeId)) return notFound(c, 'Episode not found')
  const links = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = db.select().from(schema.characters).all()
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!getActiveEpisode(episodeId)) return notFound(c, 'Episode not found')
  const links = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = db.select().from(schema.scenes).all()
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/props — key props linked to this episode
//   2026-09-10 review pass: 用 inArray 避免 N+1, JOIN owner_character_name + appearance_weight
//   排序: critical > major > minor (剧情重要性)
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!getActiveEpisode(episodeId)) return notFound(c, 'Episode not found')
  const links = db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId)).all()
  if (!links.length) return success(c, [])
  const weightByPropId = new Map(links.map(l => [l.propId, l.appearanceWeight]))
  const propIds = links.map(l => l.propId)
  // inArray SQL 过滤, 不再全表扫
  const propRows = db.select().from(schema.props)
    .where(inArray(schema.props.id, propIds)).all()
    .filter(p => !p.deletedAt)
  // JOIN characters 拿 owner 名字
  const ownerIds = Array.from(new Set(propRows.map(p => p.ownerCharacterId).filter(Boolean))) as number[]
  const owners = ownerIds.length
    ? db.select().from(schema.characters).where(inArray(schema.characters.id, ownerIds)).all()
    : []
  const ownerById = new Map(owners.map(c => [c.id, c.name]))
  // 排序权重: critical(3) > major(2) > minor(1)
  const weightRank: Record<string, number> = { critical: 3, major: 2, minor: 1 }
  const result = propRows
    .map(p => ({
      ...p,
      owner_character_name: p.ownerCharacterId ? ownerById.get(p.ownerCharacterId) || null : null,
      appearance_weight: weightByPropId.get(p.id) || 'minor',
    }))
    .sort((a, b) => (weightRank[b.appearance_weight!] || 0) - (weightRank[a.appearance_weight!] || 0))
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  if (!getActiveEpisode(episodeId)) return notFound(c, 'Episode not found')
  // 2026-09-10: 查询时按 storyboardNumber 去重, 同一 episode 下保留 id 最大(最新)的一条,
  // 避免反复拆解/重新生成本镜头时数据库残留重复 storyboard_number 记录, 导致
  // 前端配音列表里出现两条相同 # 编号。
  const rows = dedupeStoryboards(
    db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
      .all()
  )
  const links = db.select().from(schema.storyboardCharacters).all()
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    .map(link => link.characterId)
  const allChars = db.select().from(schema.characters).all()
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const ep = getActiveEpisode(episodeId)
  if (!ep) return notFound(c, 'Episode not found')

  const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId)).all()
  const sbs = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  const merges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, episodeId)).all()

  const charsWithVoice = chars.filter(c => c.voiceStyle)
  const charsWithSample = chars.filter(c => c.voiceSampleUrl)
  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const sbsComposed = sbs.filter(s => s.composedVideoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      assign_voices: { status: stepStatus(charsWithVoice.length === chars.length && chars.length > 0, charsWithVoice.length > 0), assigned: charsWithVoice.length, total: chars.length },
      generate_voice_samples: { status: stepStatus(charsWithSample.length === charsWithVoice.length && charsWithVoice.length > 0, charsWithSample.length > 0), completed: charsWithSample.length, total: charsWithVoice.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      compose_shots: { status: stepStatus(sbsComposed.length === sbs.length && sbs.length > 0, sbsComposed.length > 0), completed: sbsComposed.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app

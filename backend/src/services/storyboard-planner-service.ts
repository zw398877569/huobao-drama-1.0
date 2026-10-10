/**
 * Storyboard Planner 3 步 Service (V4 架构, PM msg-20261010-003)
 *
 * 替代老的 1 步 endpoint 黑盒:
 *   - 老 /storyboard_breaker/planning 内部 redirect 到这里的 runAllStepsLegacy (auto mode, 跳过 user review)
 *   - 新 /storyboard_breaker/planning/step1/2/3 三个 endpoint 走 interactive wizard mode
 *     (用户每步能调参数/改 prompt, 完成后调下一步)
 *
 * 复用 Sprint 8 V3:
 *   - 5 维 enum 强约束 (PERMANENT_TRAITS_CATEGORIES) — step2 LLM 输出 schema 强制分流
 *   - salvageImagePromptPermanent fallback — step3 写 DB 前 salvage enum 边界外字符
 *   - V3ImagePromptPermanentSchema — step2 zod 校验 + step3 拼 imagePrompt 文本
 *
 * State machine (episodes.planning_data JSON):
 *   { step1_done_at, step1_plan, step2_done_at, step2_details, step3_done_at, step3_storyboard_ids }
 *   - step1 失败 → step1_done_at 空, 重跑 step1
 *   - step2 失败 → step1_plan 保留 (不重跑), 重跑 step2
 *   - step3 失败 → step2_details 保留 (不重跑), 重跑 step3
 *
 * 老 drama 8 ep 8 planning_data NULL 兼容, 老 endpoint 走 V3 拼接路径, 0 兼容成本.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { getConfigById, getTextConfig, type AIConfig } from './ai.js'
import {
  salvageImagePromptPermanent,
  permanentToText,
  V3ImagePromptPermanentSchema,
} from './llm-schema-validator.js'

// ─── Planning Data Storage ──────────────────────────────────────────────

export interface PlanningData {
  step1_done_at?: string
  step1_plan?: ShotPlanItem[]
  step2_done_at?: string
  step2_details?: ShotDetailsItem[]
  step3_done_at?: string
  step3_storyboard_ids?: number[]
}

export interface ShotPlanItem {
  shot_number: number
  scene_id: number
  duration: number
  intent_function: string
  action: string
  character_ids?: number[]
}

export interface ShotDetailsItem {
  shot_number: number
  scene_id?: number
  character_ids?: number[]
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  duration?: number
  action?: string
  dialogue?: string
  description?: string
  result?: string
  atmosphere?: string
  intent_function?: string
  sound_effect?: string
  bgm_prompt?: string
  /** V3 zod enum 5 维结构化对象 (替代 V2 free-text permanent) */
  image_prompt_permanent?: z.infer<typeof V3ImagePromptPermanentSchema>
  image_prompt_plot_state?: string
  video_prompt_permanent?: string
  video_prompt_plot_state?: string
}

export async function getPlanningData(episodeId: number): Promise<PlanningData> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  if (!ep.planningData) return {}
  try {
    return JSON.parse(ep.planningData) as PlanningData
  } catch {
    logTaskWarn('StoryboardPlanner', 'planning-data-parse-failed', { episodeId, raw: ep.planningData?.slice(0, 100) })
    return {}
  }
}

export async function savePlanningData(episodeId: number, partial: PlanningData): Promise<void> {
  const existing = await getPlanningData(episodeId)
  const merged: PlanningData = { ...existing, ...partial }
  db.update(schema.episodes)
    .set({ planningData: JSON.stringify(merged), updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
}

// ─── Context Read (跟 readStoryboardContext tool 同源) ────────────────

interface StoryboardContext {
  episodeId: number
  dramaId: number
  script: string
  scenes: Array<{ id: number; location: string; time: string; prompt: string; image_url: string }>
  characters: Array<{
    id: number; name: string; role: string; description: string
    appearancePermanent: string; personality: string; voice_style: string
  }>
  existingStoryboards: Array<{ storyboardNumber: number; title: string }>
  targetDuration: number | null
}

export async function readStoryboardContextForPlanner(
  episodeId: number,
  dramaId: number,
): Promise<StoryboardContext> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const script = ep.scriptContent || ep.content || ''

  const charLinks = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const sceneLinks = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const linkedCharacterIds = new Set(charLinks.map(l => l.characterId))
  const linkedSceneIds = new Set(sceneLinks.map(l => l.sceneId))

  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .filter(c => !c.deletedAt)
    .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
  const scns = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, dramaId)).all()
    .filter(s => !s.deletedAt)
    .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
  const existingStoryboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()

  return {
    episodeId,
    dramaId,
    script,
    targetDuration: ep.targetDuration ?? null,
    scenes: scns.map(s => ({
      id: s.id, location: s.location, time: s.time,
      prompt: s.prompt || '', image_url: s.imageUrl || '',
    })),
    characters: chars.map(c => ({
      id: c.id, name: c.name, role: c.role || '',
      description: c.description || '',
      appearancePermanent: c.appearancePermanent || '',
      personality: c.personality || '',
      voice_style: c.voiceStyle || '',
    })),
    existingStoryboards: existingStoryboards.map(sb => ({
      storyboardNumber: sb.storyboardNumber,
      title: sb.title || '',
    })),
  }
}

// ─── LLM Call Helper (response_format=json_object) ────────────────────

async function callLLMJson<T>(
  config: AIConfig,
  systemPrompt: string,
  userPrompt: string,
  validator: z.ZodType<T>,
): Promise<T> {
  const url = config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 8192,
        extra_body: { reasoning: { enabled: false } },
      }),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (err: any) {
    throw new Error(`LLM HTTP failed: ${err?.message || String(err)}`)
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const data = await resp.json() as any
  const raw = data?.choices?.[0]?.message?.content?.trim() || ''
  if (!raw) throw new Error('LLM empty response')
  // 剥 think 块 (跟 ai.ts callTextLLMForPrompt 一致)
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { parsed = JSON.parse(m[0]) } catch {}
    }
    if (!parsed) throw new Error(`LLM response not JSON: ${cleaned.slice(0, 200)}`)
  }
  return validator.parse(parsed)
}

// ─── Step 1: shot_plan ────────────────────────────────────────────────

const INTENT_FUNCTIONS = ['铺垫', '揭露', '反转', '高潮', '余韵', '悬念', '情感爆发'] as const

const ShotPlanItemSchema = z.object({
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().positive(),
  duration: z.number().min(2).max(15),
  intent_function: z.enum(INTENT_FUNCTIONS),
  action: z.string().min(5).max(200),
  character_ids: z.array(z.number().int()).optional(),
})

const Step1Schema = z.object({
  shot_plan: z.array(ShotPlanItemSchema).min(5).max(30),
  total_duration: z.number().min(10).max(300),
  scene_distribution: z.record(z.string(), z.number()),
})

export async function runStep1(opts: {
  dramaId: number
  episodeId: number
  textConfigId?: number
  modelOverride?: string
}): Promise<z.infer<typeof Step1Schema>> {
  const { dramaId, episodeId, textConfigId, modelOverride } = opts
  logTaskProgress('StoryboardPlanner', 'step1-begin', { dramaId, episodeId })

  const ctx = await readStoryboardContextForPlanner(episodeId, dramaId)
  const config = textConfigId
    ? (getConfigById(textConfigId) || getTextConfig())
    : getTextConfig()
  const finalConfig: AIConfig = modelOverride ? { ...config, model: modelOverride } : config

  const systemPrompt = `你是资深影视分镜师 + 短剧节奏导演。
任务: 基于 ctx (script / scenes / characters / existingStoryboards / targetDuration), 规划本集所有镜头的 shot_plan。
约束:
  - scene_id 必须从 ctx.scenes 中选
  - character_ids 必须从 ctx.characters 中选
  - duration 2-15s
  - intent_function 必须是 enum: 铺垫 / 揭露 / 反转 / 高潮 / 余韵 / 悬念 / 情感爆发
  - shot_number 1..N 连续递增
  - 同一 scene 的所有镜头相邻排列 (单调性, P3 约束)
  - Σ duration 接近 targetDuration (允许 ±10%)
输出: 严格 JSON { shot_plan: [{shot_number, scene_id, duration, intent_function, action, character_ids}], total_duration: number, scene_distribution: {scene_id_str: count} }`

  const userPrompt = JSON.stringify({
    targetDuration: ctx.targetDuration ?? 100,
    ctx: {
      script: ctx.script.slice(0, 8000),
      scenes: ctx.scenes,
      characters: ctx.characters.map(c => ({
        id: c.id, name: c.name, role: c.role,
        appearancePermanent: c.appearancePermanent.slice(0, 300),
      })),
      existingStoryboards: ctx.existingStoryboards,
    },
  }, null, 2)

  const result = await callLLMJson(finalConfig, systemPrompt, userPrompt, Step1Schema)

  await savePlanningData(episodeId, {
    step1_done_at: now(),
    step1_plan: result.shot_plan,
  })
  logTaskSuccess('StoryboardPlanner', 'step1-done', {
    episodeId, shotCount: result.shot_plan.length, totalDuration: result.total_duration,
  })
  return result
}

// ─── Step 2: shot_details (V3 zod enum 强约束) ──────────────────────

const ShotDetailsItemSchema = z.object({
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().optional(),
  character_ids: z.array(z.number().int()).optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  duration: z.number().optional(),
  action: z.string().optional(),
  dialogue: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  intent_function: z.string().optional(),
  /** V3 zod enum 5 维结构化对象 — V2 free-text permanent 已废弃 */
  image_prompt_permanent: V3ImagePromptPermanentSchema.optional(),
  image_prompt_plot_state: z.string().optional(),
  video_prompt_permanent: z.string().optional(),
  video_prompt_plot_state: z.string().optional(),
})

const Step2Schema = z.object({
  shot_details: z.array(ShotDetailsItemSchema),
})

export async function runStep2(opts: {
  dramaId: number
  episodeId: number
  shotPlanOverride?: ShotPlanItem[]
  textConfigId?: number
  modelOverride?: string
}): Promise<z.infer<typeof Step2Schema>> {
  const { dramaId, episodeId, shotPlanOverride, textConfigId, modelOverride } = opts
  logTaskProgress('StoryboardPlanner', 'step2-begin', { dramaId, episodeId })

  const planningData = await getPlanningData(episodeId)
  const plan = shotPlanOverride || planningData.step1_plan
  if (!plan || !plan.length) throw new Error('No step1 plan found, run step1 first')

  const ctx = await readStoryboardContextForPlanner(episodeId, dramaId)
  const config = textConfigId
    ? (getConfigById(textConfigId) || getTextConfig())
    : getTextConfig()
  const finalConfig: AIConfig = modelOverride ? { ...config, model: modelOverride } : config

  const systemPrompt = `你是资深影视分镜师。
任务: 基于 step1_plan + ctx.scenes + ctx.characters, 输出 shot_details JSON 数组 (每个 shot 一个对象)。
V3 治本核心 (PM msg-20261010-002): image_prompt_permanent 必须是 5 维 enum 结构化对象, 严禁塞 plot_state:
  {
    "character_traits": [
      {"category": "age" | "face" | "hair" | "body" | "outfit", "value": "具体描述 ≤ 50 字"}
    ],
    "scene_aesthetic": ["氛围1", "氛围2"],
    "shot_type_ref": "全景" | "中景" | "近景" | "特写",
    "angle": "机位",
    "movement": "运镜"
  }
  - character_traits 2-10 项, category 必须严格在 5 维 enum 内 (age/face/hair/body/outfit)
  - 严禁 category 写 'clothing/accessory/eyebrows/skin_tone' 等扩展维度 (会被 zod reject, 自动 salvage 到 plot_state)
  - 严禁 character_traits[i].value 含情感/剧情描述 (例如 '深爱豆豆胜过自己' → 错误, 应该是 age/face/hair/body/outfit 永久外貌)
plot_state 段 (image_prompt_plot_state): 自由 string, 允许剧情瞬时动作/表情/物件状态。
输出: 严格 JSON { shot_details: [{shot_number, scene_id, character_ids, shot_type, angle, movement, location, time, duration, action, dialogue, description, result, atmosphere, intent_function, image_prompt_permanent, image_prompt_plot_state, video_prompt_permanent, video_prompt_plot_state}] }`

  const userPrompt = JSON.stringify({
    step1_plan: plan,
    ctx: {
      scenes: ctx.scenes,
      characters: ctx.characters.map(c => ({
        id: c.id, name: c.name, role: c.role,
        appearancePermanent: c.appearancePermanent.slice(0, 300),
      })),
    },
  }, null, 2)

  const result = await callLLMJson(finalConfig, systemPrompt, userPrompt, Step2Schema)

  await savePlanningData(episodeId, {
    step2_done_at: now(),
    step2_details: result.shot_details,
  })
  logTaskSuccess('StoryboardPlanner', 'step2-done', {
    episodeId, shotCount: result.shot_details.length,
  })
  return result
}

// ─── Step 3: persist (V4 治本: V3 zod 再校验 + DB 事务, 防 step2→step3 数据漂移) ─────────

export async function runStep3(opts: {
  dramaId: number
  episodeId: number
  shotDetailsOverride?: ShotDetailsItem[]
}): Promise<{ createdStoryboardIds: number[] }> {
  const { dramaId, episodeId, shotDetailsOverride } = opts
  logTaskProgress('StoryboardPlanner', 'step3-begin', { dramaId, episodeId })

  const planningData = await getPlanningData(episodeId)
  const details = shotDetailsOverride || planningData.step2_details
  if (!details || !details.length) throw new Error('No step2 details found, run step2 first')

  // Task B (PM msg-20261010-003 task_B): 用 V3 zod 再次校验 (防 step2→step3 之间数据被改 / wizard 模式下用户编辑过的 details override)
  //   失败 throw 出去, 不进 DB 事务, 主流程返回 4xx
  const revalidated = z.array(ShotDetailsItemSchema).safeParse(details)
  if (!revalidated.success) {
    logTaskWarn('StoryboardPlanner', 'step3-zod-revalidation-failed', {
      episodeId,
      issueCount: revalidated.error.issues.length,
      firstIssue: revalidated.error.issues[0],
    })
    throw new Error(`step3 zod 校验失败: ${revalidated.error.issues[0]?.message || 'unknown'}`)
  }
  const validatedDetails = revalidated.data

  // 准备 INSERT values (含 V3 salvage 清洗 + imagePrompt 拼接), 放进 DB 事务里
  const insertPayloads = validatedDetails.map((det) => {
    const cleaned = salvageImagePromptPermanent(det.image_prompt_permanent, {
      episodeId, shotNumber: det.shot_number,
    })
    const permanentText = cleaned.imagePromptPermanent
      ? permanentToText(cleaned.imagePromptPermanent)
      : ''
    const plotStateText = `${det.image_prompt_plot_state?.trim() || ''}${cleaned.plotState ? (det.image_prompt_plot_state ? ' | ' : '') + cleaned.plotState : ''}`
    return {
      shot_number: det.shot_number,
      insertValues: {
        episodeId,
        storyboardNumber: det.shot_number,
        title: `镜头#${det.shot_number}`,
        shotType: det.shot_type || '',
        angle: det.angle || '',
        movement: det.movement || '',
        location: det.location || '',
        time: det.time || '',
        action: det.action || '',
        dialogue: det.dialogue || '',
        description: det.description || '',
        result: det.result || '',
        atmosphere: det.atmosphere || '',
        imagePrompt: [
          permanentText,
          det.description || '',
          plotStateText,
        ].filter(Boolean).join('。'),
        videoPrompt: det.video_prompt_permanent || '',
        imagePromptPlotState: plotStateText || null,
        videoPromptPlotState: det.video_prompt_plot_state || null,
        imagePromptPermanent: cleaned.imagePromptPermanent
          ? JSON.stringify(cleaned.imagePromptPermanent)
          : null,
        sceneId: det.scene_id || null,
        duration: det.duration || 10,
        createdAt: now(),
        updatedAt: now(),
      },
      characterIds: det.character_ids || [],
    }
  })

  // Task B: DB 事务包裹 DELETE + INSERT + link. 任一 INSERT 失败回滚, episodes.planning_data.step3_done_at 不更新.
  const createdStoryboardIds: number[] = []
  let clearedCount = 0
  try {
    db.transaction((tx) => {
      // DELETE 老 storyboards + storyboard_characters (V4 schema 没 FK cascade, 手动两表清)
      const existingIds = tx.select({ id: schema.storyboards.id })
        .from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .all()
        .map(r => r.id)
      for (const id of existingIds) {
        tx.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, id)).run()
      }
      if (existingIds.length) {
        tx.delete(schema.storyboards)
          .where(eq(schema.storyboards.episodeId, episodeId)).run()
      }
      clearedCount = existingIds.length

      // INSERT 新 storyboards
      for (const payload of insertPayloads) {
        const res = tx.insert(schema.storyboards).values(payload.insertValues).run()
        const storyboardId = Number(res.lastInsertRowid)
        createdStoryboardIds.push(storyboardId)
        for (const charId of payload.characterIds) {
          tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId: charId }).run()
        }
      }
    })
  } catch (err: any) {
    // 事务已自动回滚 (better-sqlite3 throw → ROLLBACK), 这里只记日志 + 抛给上层
    logTaskWarn('StoryboardPlanner', 'step3-transaction-failed', {
      episodeId,
      clearedCount,
      payloadCount: insertPayloads.length,
      error: err?.message || String(err),
      hint: '事务已 ROLLBACK, episodes.planning_data.step3_done_at 未更新, 用户可重试 step3',
    })
    throw err
  }

  logTaskProgress('StoryboardPlanner', 'step3-cleared', { episodeId, clearedCount })
  await savePlanningData(episodeId, {
    step3_done_at: now(),
    step3_storyboard_ids: createdStoryboardIds,
  })
  logTaskSuccess('StoryboardPlanner', 'step3-done', {
    episodeId, clearedCount, createdCount: createdStoryboardIds.length,
  })
  return { createdStoryboardIds }
}

// ─── 老 endpoint redirect: runAllStepsLegacy (auto mode) ─────────────

export async function runAllStepsLegacy(opts: {
  dramaId: number
  episodeId: number
  textConfigId?: number
  modelOverride?: string
  onProgress?: (progress: { phase: string; status: string; tip?: string; [key: string]: unknown }) => void | Promise<void>
}): Promise<{ shot_plan: ShotPlanItem[]; shot_details: ShotDetailsItem[]; createdStoryboardIds: number[] }> {
  const { dramaId, episodeId, textConfigId, modelOverride, onProgress } = opts

  await onProgress?.({ phase: 'step1', status: 'running', tip: 'step1: 正在读取剧本和场景数据...' })
  const step1Result = await runStep1({ dramaId, episodeId, textConfigId, modelOverride })
  await onProgress?.({
    phase: 'step1', status: 'done',
    shotCount: step1Result.shot_plan.length,
    totalDuration: step1Result.total_duration,
  })

  await onProgress?.({ phase: 'step2', status: 'running', tip: 'step2: 正在生成每个镜头的 5 维 enum 提示词...' })
  const step2Result = await runStep2({
    dramaId, episodeId,
    shotPlanOverride: step1Result.shot_plan,
    textConfigId, modelOverride,
  })
  await onProgress?.({ phase: 'step2', status: 'done', shotCount: step2Result.shot_details.length })

  await onProgress?.({ phase: 'step3', status: 'running', tip: 'step3: 正在写入数据库...' })
  const step3Result = await runStep3({
    dramaId, episodeId,
    shotDetailsOverride: step2Result.shot_details,
  })
  await onProgress?.({ phase: 'step3', status: 'done', createdStoryboardIds: step3Result.createdStoryboardIds })

  return {
    shot_plan: step1Result.shot_plan,
    shot_details: step2Result.shot_details,
    createdStoryboardIds: step3Result.createdStoryboardIds,
  }
}

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
// Sprint 11 (PM msg-20261016-001 Task A + msg-20261016-002 R1/R2/R3):
//   V4 三步新链路接入共享模块 — 旧 agent 路径 (storyboard-tools.ts) 已改用同一份实现。
//   - ensureH3ThreePartPrompt: 补 H3 三段式 header (背景音少的根因)
//   - applyDurationPolicy: 时长体系 (因子估算 → 钩子/过渡 → Σ 收敛)
import { ensureH3ThreePartPrompt } from '../utils/h3-prompt.js'
// Sprint 16 Bug-B: 台词嵌入 (V4 planner 路径此前漏了, 跟老全量路径对齐)
import { embedDialogueInline } from '../utils/dialogue-timeline.js'
import { applyDurationPolicy } from './shot-duration.js'
import {
  salvageImagePromptPermanent,
  salvageShotPlanArray,
  permanentToText,
  V3ImagePromptPermanentSchema,
  INTENT_FUNCTIONS,
} from './llm-schema-validator.js'
import { stripReasoningBlocks } from './ai.js'

// Sprint 11 QA msg-20261016-067 Bug-D: 默认 max_tokens 32768 → 49152
//   修前: drama 13 step1 首次跑 max_tokens 触顶 (completionTokens=32768 = 上限),
//         finishReason='length' → 靠 sprint 27 的自动 retry (×2 → 65536) 救回来,
//         但首次那 6-10 分钟白烧 (用户等一轮失败才看到成功)。
//   修后: 首次就给 1.5x 预算 (32768→49152), 大幅降低首次触顶概率;
//         retry ×2 兜底保留 (触顶时 → 98304), 极端 case 仍有容错。
//   为什么选 49152 而不是直接 131072:
//     - 用户 2026-10-16 拍板"最小调整", 131072 会显著抬高单次成本且多数场景用不到;
//     - 根因是 reasoning_effort=medium 让 reasoning_tokens 占预算, 属配置问题不是上限问题
//       (真要治本应调 reasoning_effort, 但那会改变 LLM 输出质量, 不属本次修复范围)。
const DEFAULT_MAX_TOKENS = 49152

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

// ─── Model capability check (PM msg-20261012-038) ──────────────────────

/**
 * 该模型是否支持思考深度控制 (reasoning_effort).
 *
 * MiniMax 官方文档: 仅 MiniMax-M3.1-Flash-Preview 支持 output_config.effort /
 * reasoning_effort 档位 (low/medium/high/xhigh/max), 老模型 (含 MiniMax-M3) 完全不支持,
 * 且 effort=none 会返回 400.
 *
 * 不同 provider 的字段名不同: MiniMax OpenAI 兼容端点用 reasoning_effort,
 * Anthropic 端点用 output_config.effort. 本项目 callLLMJson 走 OpenAI 兼容 (/v1/chat/completions),
 * 所以只在 OpenAI 兼容协议下用 reasoning_effort.
 *
 * 2026-10-12 用户官网确认后加的条件发送, 避免给不支持的模型发参数.
 * 后续新模型支持时在这里加白名单.
 */
function supportsReasoningEffort(model: string | undefined | null): boolean {
  if (!model) return false
  const m = String(model).trim().toLowerCase()
  // 目前官方仅确认 M3.1-Flash-Preview 支持. 用 includes 容忍官方后续改版本后缀 (如 -flash-preview-20260101)
  return m.includes('m3.1-flash')
}

// ─── LLM Call Helper (response_format=json_object) ────────────────────

async function callLLMJson<T>(
  config: AIConfig,
  systemPrompt: string,
  userPrompt: string,
  validator: z.ZodType<T>,
  opts: {
    retry?: number
    maxTokens?: number
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
    ctx?: Record<string, unknown>
    /** Sprint 44 FIX-061: zod fail 后尝试 salvage 修复字段 (省 retry). 例: shot_plan action>500 → truncate */
    salvage?: (parsed: unknown) => unknown
  } = {},
): Promise<T> {
  // QA msg-20261010-006 ISSUE-020: 兼容 MiniMax-M3 (新 OpenAI 兼容 API 经常把内容放在 reasoning_content 而非 content)
  // retry 1 次 (跟 ai.ts callTextLLMForPrompt fallback 思路一致, LLM 临时不可用时 retry, 不无限循环)
  // QA msg-20261010-014 ISSUE-014 Fix 4: retry 1 → 2, LLM think 耗尽 token 概率较高, 多给一次机会
  const maxRetries = opts.retry ?? 2
  const url = config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp: Response
    try {
      // ─── 先在 fetch 外面构造 payload (statements 不能写在 object literal 里), 再传 JSON 字符串 ───
      // QA msg-20261012-038: 仅支持深度思考控制的模型才发 reasoning_effort, MiniMax-M3 (老模型) 不支持
      const payload: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        // QA msg-20261010-033 sprint 27: max_tokens 16384 → 32768 (V3 step 2 输出 ~30KB)
        // Sprint 11 Bug-D: 32768 → DEFAULT_MAX_TOKENS (49152), 降低首次触顶概率
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        extra_body: { reasoning: { enabled: false } },
      }
      if (supportsReasoningEffort(config.model)) {
        payload.reasoning_effort = opts.reasoningEffort ?? 'medium'
        logTaskProgress('LLMCall', 'reasoning-effort-applied', {
          ...opts.ctx, model: config.model, effort: opts.reasoningEffort ?? 'medium',
        })
      }
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(420_000),  // QA msg-20261012-039 Fix 1: 前后端 timeout 对齐 420s (后端 retry 累加 maxRetries=2 次, 最坏 540s; 前端单次 timeout 必须覆盖)
      })
    } catch (err: any) {
      throw new Error(`LLM HTTP failed: ${err?.message || String(err)}`)
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`LLM ${resp.status}: ${errText.slice(0, 200)}`)
    }

    const data = await resp.json() as any
    // QA msg-20261010-014 ISSUE-014 Fix 3: 专门 catch finish_reason=length (max_tokens 截断) / content_filter (敏感词被拒)
            //   之前 status=200 finish_reason=length 视为成功, JSON.parse 失败才 throw, 错误信息只显示 raw content 看不出根因
            //   现在明确报错: truncated (建议减小 max_tokens 或分多步生成) / content filter (输入有敏感词)
            const finishReason = data?.choices?.[0]?.finish_reason
            const usage = data?.usage ?? {}
            if (finishReason === 'length') {
              lastError = new Error(`LLM response truncated (max_tokens=${data?.usage?.completion_tokens ?? '?'} 触顶, LLM 还在生成 content). 建议: 减小 max_tokens + 让 LLM 输出更紧凑, 或分多步生成`)
              logTaskWarn('LLMCall', 'json-parse-truncated', {
                ...opts.ctx, attempt, model: config.model,
                finishReason, completionTokens: usage.completion_tokens,
                promptTokens: usage.prompt_tokens,
                maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
                hint: 'max_tokens 触顶, LLM 还在生成 JSON content. 看 llm-debug-resp.log 确认 reasoning_tokens 占用',
              })
              // QA msg-20261010-033 sprint 27 Fix 2: 智能 retry — finish_reason=length 还有 retry 余量时, max_tokens × 2 续写
              // Sprint 11 Bug-D: 默认提到 49152, retry 时 → 98304 (48K→96K), 极端 case 容错
              if (attempt < maxRetries) {
                const newMaxTokens = (opts.maxTokens ?? DEFAULT_MAX_TOKENS) * 2
                logTaskWarn('LLMCall', 'json-parse-truncated-retry', {
                  ...opts.ctx, attempt, oldMaxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS, newMaxTokens,
                  hint: 'finish_reason=length 触发 retry, max_tokens 自动 2x 续写, 避免再次截断',
                })
                return await callLLMJson(config, systemPrompt, userPrompt, validator, {
                  ...opts,
                  retry: maxRetries - attempt - 1,
                  maxTokens: newMaxTokens,
                })
              }
              throw lastError
            }
            if (finishReason === 'content_filter') {
              throw new Error('LLM 触发 content filter, 内容被拒. 检查输入是否含敏感词 (鲜血/武器/死亡/燃烧 等)')
            }
    const message = data?.choices?.[0]?.message || {}
    // 优先读 content, fallback 到 reasoning_content (MiniMax-M3 / DeepSeek / Anthropic thinking 等)
    const raw = (message.content ?? message.reasoning_content ?? '').trim()
    if (!raw) {
      lastError = new Error('LLM empty response (content + reasoning_content both empty)')
      logTaskWarn('LLMCall', 'json-parse-empty', {
        ...opts.ctx, attempt, model: config.model,
        choiceKeys: Object.keys(data?.choices?.[0] ?? {}),
        messageKeys: Object.keys(message),
      })
      if (attempt < maxRetries) continue
      throw lastError
    }

    // 用 stripReasoningBlocks helper (剥 3 种 think/reflection/reasoning 块, 跟 ai.ts 共用一致性)
    const cleaned = stripReasoningBlocks(raw)

    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // try extract first JSON object
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (m) {
        try { parsed = JSON.parse(m[0]) } catch {}
      }
      if (!parsed) {
        lastError = new Error(`LLM response not JSON: ${cleaned.slice(0, 200)}`)
        logTaskWarn('LLMCall', 'json-parse-failed', {
          ...opts.ctx, attempt, model: config.model,
          rawLen: raw.length, cleanedLen: cleaned.length,
          rawPreview: raw.slice(0, 200),
        })
        if (attempt < maxRetries) continue
        throw lastError
      }
    }

    let parseResult: T
    try {
      parseResult = validator.parse(parsed)
    } catch (err: any) {
      lastError = err
      const issueCount = err?.issues?.length ?? 0
      const firstIssue = err?.issues?.[0]
      logTaskWarn('LLMCall', 'zod-validation-failed', {
        ...opts.ctx, attempt, model: config.model,
        issueCount, firstIssue,
      })
      // Sprint 44 FIX-061: zod fail 后尝试 salvage 修复字段, 避免 retry 整个 response 浪费 token
      if (opts.salvage) {
        try {
          const salvaged = opts.salvage(parsed)
          const reparsed = validator.safeParse(salvaged)
          if (reparsed.success) {
            logTaskWarn('LLMCall', 'zod-salvaged-retry-succeeded', {
              ...opts.ctx, attempt, model: config.model,
              originalIssueCount: issueCount,
              hint: 'salvage 修字段后 zod 二次 pass, 节省 retry token',
            })
            return reparsed.data
          } else {
            const salvagedIssues = reparsed.error?.issues?.length ?? 0
            logTaskWarn('LLMCall', 'zod-salvage-still-failed', {
              ...opts.ctx, attempt, model: config.model,
              originalIssueCount: issueCount,
              salvagedIssueCount: salvagedIssues,
              firstSalvagedIssue: reparsed.error?.issues?.[0],
              hint: 'salvage 后 zod 仍 fail, 走原本 retry 路径',
            })
          }
        } catch (salvageErr: any) {
          logTaskWarn('LLMCall', 'zod-salvage-threw', {
            ...opts.ctx, attempt, model: config.model,
            salvageErrMsg: salvageErr?.message || String(salvageErr),
            hint: 'salvage 函数自身抛错, 走原本 retry 路径',
          })
        }
      }
      if (attempt < maxRetries) continue
      throw err
    }
    return parseResult
  }

  throw lastError ?? new Error('LLM call failed (unknown)')
}

// ─── Step 1: shot_plan ────────────────────────────────────────────────

const ShotPlanItemSchema = z.object({
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().positive(),
  duration: z.number().min(2).max(15),
  intent_function: z.enum(INTENT_FUNCTIONS),
  action: z.string().min(5).max(500),
  character_ids: z.array(z.number().int()).optional(),
})

const Step1Schema = z.object({
  // Sprint 11 QA msg-20261016-067 Bug-C: 上限 30 → 50
  //   修前: drama 13「雨夜」step1 第一次跑 zod-validation-failed code='too_big' maximum=30
  //         (LLM 生成 >30 镜), 用户手动重跑第二次 12 秒才成功 — UX 差且白烧一次 LLM。
  //   修后: 上限放宽到 50, 配合下面 prompt 强化 (明确写 ≤50 + 精简合并指引)。
  //   下限 5 不变 (少于 5 镜的剧本信息量不足, 仍应拦)。
  //   注意: VIDEO_MAX_DURATION=15 是 H3 单镜硬上限 (跟本项无关, 那是单镜时长不是镜数)。
  shot_plan: z.array(ShotPlanItemSchema).min(5).max(50),
  // Sprint 11 QA msg-20261016-067 Bug-C: 300 → 750
  //   镜数上限放到 50 后, 50 镜 × VIDEO_MAX_DURATION 15s = 750s 是理论上限。
  //   修前 total_duration max 300 会先于 shot_plan max 30 撞墙 (30×15=450 > 300),
  //   导致"镜数没超但总时长超"也被 zod fail, 且错误信息指向 total_duration 让人误判。
  total_duration: z.number().min(10).max(750),
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
  - shot_plan 数组长度 5-50 个镜头 (硬上限 50)。⚠️ 严禁超过 50 个 — 会被 zod 拒绝整轮重跑。
    剧情复杂/场景多时, 优先【合并同类镜头】(同场景同功能的连续动作合并成一镜) 而不是无脑加镜数。
    短剧单集 15-30 镜是正常密度, 超过 40 镜通常说明拆分粒度过细。
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

  const result = await callLLMJson(finalConfig, systemPrompt, userPrompt, Step1Schema, {
    ctx: { dramaId, episodeId, step: 'step1' },
    salvage: (parsed) => {
      if (!parsed || typeof parsed !== 'object') return parsed
      const obj = parsed as Record<string, unknown>
      if (Array.isArray(obj.shot_plan)) {
        const { shot_plan: salvagedPlan } = salvageShotPlanArray(obj.shot_plan, { episodeId })
        return { ...obj, shot_plan: salvagedPlan }
      }
      return parsed
    },
  })

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
  // Sprint 11 Task A (PM msg-20261016-001): H3 声音两列 — V4 重构时遗落, 导致 19/19 video_prompt
  //   缺三段式 header, H3 拿不到声音指令自由发挥 → 13/19 镜接近静音 (-45~-52dB)。
  //   旧路径 agents/index.ts:580-588 已有既有措辞, 这里沿用同口径。
  /** 环境底噪 + diegetic 音效 (画面内可听的声音)。无则写 'N/A' */
  sound_effect: z.string().optional(),
  /** 该镜配乐描述: 配器 + 速度 + 节奏 + 动态变化。禁止抽象情绪词。无则写 'N/A' */
  bgm_prompt: z.string().optional(),
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
    -- ⚠️ character_traits[].category 必须是 age/face/hair/body/outfit 这 5 个值之一,
    --   严禁 clothing/accessory/eyebrows/skin_tone 等扩展维度
    --   (非法值会被挪到 plot_state, 该描述不会出现在 permanent 段),
    "scene_aesthetic": ["氛围1", "氛围2"],
    "shot_type_ref": "全景" | "中景" | "近景" | "特写",
      -- ⚠️ shot_type_ref 必须是这 4 个值之一, 严禁 "中近景"/"中全景" 等复合值 (非法值会触发 salvage fallback 到 "中景", 但会增加 retry 风险)
    "angle": "机位",
    "movement": "运镜"
  }
  - 2026-10-13 sprint 44 FIX-057 C 方案 (c) prompt 强化: character_traits 至少 1 项 (推荐 2-5 项, 至少 2 个不同维度: age/face/hair/body/outfit 选 ≥ 2 个), 严禁输出空数组, 严禁 0 项
  - character_traits 2-10 项 (推荐 2-5), category 必须严格在 5 维 enum 内 (age/face/hair/body/outfit)
  - 严禁 category 写 'clothing/accessory/eyebrows/skin_tone' 等扩展维度 (会被 zod reject, 自动 salvage 到 plot_state)
  - 严禁 character_traits[i].value 含情感/剧情描述 (例如 '深爱豆豆胜过自己' → 错误, 应该是 age/face/hair/body/outfit 永久外貌)
  - 严禁 character_traits[i].value 含摄影指令 (如 '中景平视'/'固定机位' → 错误, 这些在 shot_type_ref/angle/movement 字段)
  - 字段分工: 瞬时动作/表情/对话 写 action + image_prompt_plot_state; 物理外貌(年龄/脸/发型/身材/服装) 写 character_traits; 场景氛围 写 scene_aesthetic; 摄影指令 写 shot_type_ref/angle/movement — 三块内容 vs 一块摄影, 不要混
- 2026-10-13 sprint 44 FIX-056-VIDEO-PROMPT-FUSION: video_prompt 字段分工 (跟 image_prompt 完全对称)
  - video_prompt_permanent 写运镜+机位+环境(运镜词汇/景别/光线, 不要塞剧情动作/对话/表情) — 这部分是摄影指令
  - video_prompt_plot_state 写本镜剧情瞬时动作/表情/对话/物件状态 (跟 image_prompt_plot_state 字段分工一致)
  - 后端拼接: videoPrompt = permanent + description + plot_state 三段, 跟 imagePrompt 拼接方式一致
  - 严禁把剧情动作塞到 video_prompt_permanent (后端拼不出剧情, 视频提示词没剧情); 严禁把摄影指令塞到 video_prompt_plot_state (冗余, 跟 permanent 重复)
- Sprint 15 (PM msg-20261020-075): 对白嵌入 video_prompt (口型同步的文字侧前提)
  - dialogue 字段里的每一句【角色台词】都必须按时间顺序写进 video_prompt_plot_state, 不能省略
  - 格式: <角色动作>，开口:'<对白原文>' — 台词原文照抄 dialogue 字段, 不要改写/概括/翻译
  - ⚠️ 旁白 (isNarrator 的段) 【不要】写进 video_prompt —— 旁白是画外音, 画面里没人张嘴;
    写进去会让视频模型误以为要动嘴, 反而破坏口型同步
  - 多角色多轮对白按 dialogue 字段里的出现顺序
  - ⚠️ 台词念完的时长不要超过本镜 duration, 说不完的镜头把台词写短一点
    (超时会在 flow-log 的 VideoTask/dialogue-exceeds-duration 里报出来)
  - 说明: 后端还有一层代码兜底 (按 tts_segments 实测每段音频时长自动拼时间轴),
    本条是让 LLM 输出的动作描述跟台词时序更契合, 两者互补。
    即使本条没完全生效, 口型同步也不会彻底失效 —— 代码兜底仍然会把台词+时间轴拼进去。
- Sprint 11 Task A (PM msg-20261016-001): sound_effect / bgm_prompt 必填 (无内容写 'N/A')
  - sound_effect: 该镜【画面内可听的声音】= 环境底噪 (雨声/风声/室内嗡鸣/街道车流) + diegetic 音效 (脚步声/门响/器物碰撞/角色喘息)
  - bgm_prompt: 该镜【配乐】= 配器 (钢琴/弦乐/电子/鼓组) + 速度 (缓慢/中速/急促) + 节奏 (稳定/渐进/骤变) + 动态变化 (渐强/渐弱/静默后爆发)
  - ⚠️ 严禁用抽象情绪词 (如 "悲伤的感觉"/"紧张氛围") — H3 拿到抽象词会自由发挥, 产生不可控音频
  - ⚠️ sound_effect 与 bgm_prompt 是两类不同声音, 不要混写 (前者画内, 后者画外配乐)
  - 后端拼接: videoPrompt = permanent + description + plot_state 三段, 再由 ensureH3ThreePartPrompt
    补 "Overall soundscape:" (取 sound_effect) + "Non-diegetic music:" (取 bgm_prompt) 两段 header
  - 背景: V4 重构时这两字段遗落, episode 12 的 19/19 video_prompt 缺三段式 header,
    H3 拿不到声音指令自由发挥 → 13/19 镜接近静音 (-45~-52dB)
plot_state 段 (image_prompt_plot_state): 自由 string, 允许剧情瞬时动作/表情/物件状态。
输出: 严格 JSON { shot_details: [{shot_number, scene_id, character_ids, shot_type, angle, movement, location, time, duration, action, dialogue, description, result, atmosphere, intent_function, image_prompt_permanent, image_prompt_plot_state, video_prompt_permanent, video_prompt_plot_state, sound_effect, bgm_prompt}] }`

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

  const result = await callLLMJson(finalConfig, systemPrompt, userPrompt, Step2Schema, {
    ctx: { dramaId, episodeId, step: 'step2' },
    // Sprint 44 FIX-061 follow-up: step 2 同样接 salvage hook, 跟 step 1 套路复用
    //   zod fail 多是 character_traits 空数组 → 复用 salvageImagePromptPermanent 补 placeholder
    //   character_ids 过滤非 int 元素 (salvageImagePromptPermanent 不处理 character_ids, 单独 inline)
    salvage: (parsed) => {
      if (!parsed || typeof parsed !== 'object') return parsed
      const obj = parsed as Record<string, unknown>
      if (!Array.isArray(obj.shot_details)) return parsed
      const salvagedDetails = obj.shot_details.map((det: any, i: number) => {
        if (!det || typeof det !== 'object') return det
        const detCopy: Record<string, unknown> = { ...det }
        if (Array.isArray(detCopy.character_ids)) {
          detCopy.character_ids = (detCopy.character_ids as unknown[]).filter(
            (n) => typeof n === 'number' && Number.isInteger(n),
          )
        }
        if (detCopy.image_prompt_permanent) {
          const salvaged = salvageImagePromptPermanent(detCopy.image_prompt_permanent, { episodeId, shotNumber: i + 1 })
          detCopy.image_prompt_permanent = salvaged.imagePromptPermanent ?? undefined
          if (salvaged.plotState) {
            const prev = typeof detCopy.image_prompt_plot_state === 'string' ? detCopy.image_prompt_plot_state : ''
            detCopy.image_prompt_plot_state = [prev, salvaged.plotState].filter(Boolean).join(' | ')
          }
        }
        return detCopy
      })
      return { ...obj, shot_details: salvagedDetails }
    },
  })

  // QA msg-20261012-039 Fix 2.2: 治本不让 shot_type_ref (或 5 维) 非法值污染 planning_data.
  //   Step2Schema 已放宽 shot_type_ref 为 z.string().optional(), 这里用 salvageImagePromptPermanent 兜底:
  //   - character_traits category 不在 5 维 enum → 移到 description + log warn
  //   - shot_type_ref 不在 SHOT_TYPE_REFS → fallback '中景' + log warn
  //   - 其他非法 value (超 50 字) → 截断
  //   避免 zod reject + retry 整个 LLM 118s 浪费 (sprint 39 dispatch 案例)
  for (const det of result.shot_details) {
    if (!det.image_prompt_permanent) continue
    const salvaged = salvageImagePromptPermanent(det.image_prompt_permanent, { episodeId, shotNumber: det.shot_number })
    // salvage 返回 { imagePromptPermanent: T | null, plotState: string }, null 表示 LLM 输出完全无效; 这里我们保留 null 让下游知道
    det.image_prompt_permanent = salvaged.imagePromptPermanent ?? undefined
    // QA msg-20261012-040 Fix 1: 回填 plotState — salvage 从 character_traits 移出来的非法 category
    //   (如 category='clothing' value='红色连衣裙') 和超 10 条溢出项都在这里, 不回填就永久丢失。
    //   step3 再次 salvage 时 image_prompt_permanent 已干净, cleaned.plotState 必然为空, 救不回来。
    if (salvaged.plotState) {
      det.image_prompt_plot_state = [det.image_prompt_plot_state, salvaged.plotState].filter(Boolean).join(' | ')
    }
  }

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

  // ── Sprint 11 R1/R2/R3 (PM msg-20261016-002): 时长体系接入 V4 新链路 ──
  //   修前: validatedDetails.map 直接用 det.duration (LLM 自由给值) 落库,
  //         19 镜全是 4/5/6s 匀速短镜头 (episode 12 实测 Σ=92s vs 旧链路 episode 3 Σ=327s),
  //         五因子估算 / 钩子保护 / 场景过渡 / Σ 收敛 全部失效 — 这是"AI 味""平"的直接原因。
  //   修后: applyDurationPolicy 统一入口, 顺序跟旧 agent 路径 (storyboard-tools.ts) 完全一致:
  //     阶段 1 (逐镜 R1+R3): 五因子估算 → 场景首镜 +0.5s → clamp [VIDEO_MIN=4, VIDEO_MAX=15]
  //     阶段 2 (整集 R2):     Σ 收敛到自动 target, 钩子镜豁免 + 非钩子镜不低于 4s
  //   VIDEO_MAX=15 是 H3 平台硬上限 (用户 2026-10-16 拍板 D2), 严禁放宽。
  const convergedTotalDuration = applyDurationPolicy(episodeId, validatedDetails)
  logTaskProgress('StoryboardPlanner', 'duration-policy-applied', {
    episodeId,
    shotCount: validatedDetails.length,
    convergedTotal: convergedTotalDuration,
    durationRange: {
      min: Math.min(...validatedDetails.map(d => d.duration ?? 0)),
      max: Math.max(...validatedDetails.map(d => d.duration ?? 0)),
    },
  })

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
        // 2026-10-13 sprint 44 FIX-056-VIDEO-PROMPT-FUSION (QA msg-20261013-056 P0):
        //   跟 imagePrompt 拼接方式一致 (permanent + description + plot_state 三段拼接),
        //   041 派单只改了 image_prompt_permanent 内部字段排序 (permanentToText), 没覆盖 video_prompt 拼接.
        //   之前 videoPrompt 只取 video_prompt_permanent, plot_state 字段存 db 但没拼, 视频提示词没剧情.
        // Sprint 11 Task A (PM msg-20261016-001): 三段式兜底 + 声音两列落库
        //   ensureH3ThreePartPrompt 补 "Overall soundscape:" + "Non-diegetic music:" 两段 header,
        //   内容分别取 sound_effect / bgm_prompt (缺失时填 'N/A')。
        //   修前: V4 新链路不调本函数, 19/19 video_prompt 缺三段式 → H3 自由发挥 → 13/19 镜静音。
        // Sprint 16 Bug-B (PM msg-20261020-072): 本路径也漏了台词嵌入。
        //   全量拆解的老路径 (storyboard-tools.ts saveStoryboards:1010) 一直有 dialogueInline,
        //   V4 planner 这条链没有 —— video_prompt 里只有动作没有台词, H3 不知道谁张嘴。
        //   embedDialogueInline 内部带「已有 开口: 就跳过」保护: Step2 prompt (sprint-15-a)
        //   已经要求 LLM 自己把台词写进 video_prompt_plot_state, LLM 照做了就不会重复嵌。
        videoPrompt: embedDialogueInline(
          ensureH3ThreePartPrompt(
            [
              det.video_prompt_permanent || '',
              det.description || '',
              det.video_prompt_plot_state || '',
            ].filter(Boolean).join('。'),
            det.sound_effect,
            det.bgm_prompt,
          ),
          det.dialogue,
        ),
        imagePromptPlotState: plotStateText || null,
        videoPromptPlotState: det.video_prompt_plot_state || null,
        // Sprint 11 Task A: H3 声音两列落库 (下游消费路径 — Task F 本期不做真实音频生成,
        //   这两列进 video_prompt 由 H3 生成音频本身就是消费路径)
        soundEffect: det.sound_effect?.trim() || null,
        bgmPrompt: det.bgm_prompt?.trim() || null,
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

// ─── Get Planning State (PM msg-20261010-027 Part B) ──────────────────────
//   V4 wizard 重进 modal 时, 从 episodes.planning_data 恢复 step1/step2/step3 进度
//   不需要重跑 LLM, 直接读 backend 中间态 JSON
export async function getPlanningState(opts: {
  dramaId: number
  episodeId: number
}): Promise<{
  step1_plan: ShotPlanItem[] | null
  step2_details: ShotDetailsItem[] | null
  step3_storyboard_ids: number[] | null
  current_step: 0 | 1 | 2 | 3
}> {
  logTaskProgress('StoryboardPlanner', 'state-fetch-begin', { dramaId: opts.dramaId, episodeId: opts.episodeId })
  const pd = await getPlanningData(opts.episodeId)
  // 推断当前进度: step3 done > step2 done > step1 done > 0
  const currentStep: 0 | 1 | 2 | 3 =
    pd.step3_done_at ? 3 :
    pd.step2_done_at ? 2 :
    pd.step1_done_at ? 1 : 0
  logTaskSuccess('StoryboardPlanner', 'state-fetch-done', {
    dramaId: opts.dramaId, episodeId: opts.episodeId,
    currentStep,
    hasStep1: !!pd.step1_plan, hasStep2: !!pd.step2_details, hasStep3: !!pd.step3_storyboard_ids,
  })
  return {
    step1_plan: pd.step1_plan ?? null,
    step2_details: pd.step2_details ?? null,
    step3_storyboard_ids: pd.step3_storyboard_ids ?? null,
    current_step: currentStep,
  }
}

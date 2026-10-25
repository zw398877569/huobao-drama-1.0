/**
 * Sprint 19 (PM msg-20261025-082) —— 分镜拆解的 4 个 zod schema。
 *
 * ⚠️ 从 storyboard-planner-service.ts 【原样搬过来】(逐字符不变)。
 *   搬的原因: 模板接口要能独立覆盖 schema, 而 general.ts 要是 import planner-service
 *   的 schema, planner-service 又要 import 模板 → 循环依赖。
 *   planner-service 改成从这里 import, 行为不变。
 */
import { z } from 'zod'
import { V3ImagePromptPermanentSchema, INTENT_FUNCTIONS } from '../services/llm-schema-validator.js'

export const ShotPlanItemSchema = z.object({
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().positive(),
  duration: z.number().min(2).max(15),
  intent_function: z.enum(INTENT_FUNCTIONS),
  action: z.string().min(5).max(500),
  character_ids: z.array(z.number().int()).optional(),
})

export const Step1Schema = z.object({
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

export const ShotDetailsItemSchema = z.object({
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

export const Step2Schema = z.object({
  shot_details: z.array(ShotDetailsItemSchema),
})

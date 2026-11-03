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
  // ★ Sprint 33 T1 (PM msg-20261103-140): 过渡镜标记 —— 【step1 的输出】。
  //   step2 不需要再输出这两个字段 (step3 按 shot_number 从 step1_plan 反查回填)。
  //   · is_transition: 该镜是不是过渡镜 (一个镜头内完成状态切换的桥)
  //   · transition_kind: space (跨 scene 空间切换) / character_entry (同 scene 人物入场)
  is_transition: z.boolean().optional(),
  transition_kind: z.enum(['space', 'character_entry']).optional(),
})

export const Step1Schema = z.object({
  // ★ Sprint 33 T2 (PM msg-20261103-140): 数组长度【不再直接限 5-50】——
  //   过渡镜不参与主体预算, zod 的 .max(50)/.min(5) 检的是【数组长度】,
  //   表达不了『非过渡镜计数 ≤ 50 / ≥ 5』→ 改成下面的 superRefine 按【主体镜】判定。
  //   (上限 50 的由来: Sprint 11 QA msg-20261016-067 Bug-C, 30 → 50;
  //    下限 5 的原意: 少于 5 镜的剧本信息量不足 —— 两条都保留, 只是口径换成主体镜。)
  shot_plan: z.array(ShotPlanItemSchema),
  //   total_duration = 成片真实总长 (主体 Σ + 过渡镜 Σ) → 不再卡 max(750);
  //   750 的上限改在 superRefine 里用【主体 Σ】判定 (见下)。
  //   (原来 300 → 750 的由来: Sprint 11 QA msg-20261016-067 Bug-C ——
  //    50 镜 × VIDEO_MAX_DURATION 15s = 750s 是理论上限;
  //    VIDEO_MAX_DURATION=15 是 H3 单镜硬上限, 跟本项无关。)
  total_duration: z.number().min(10),
  scene_distribution: z.record(z.string(), z.number()),
}).superRefine((val, ctx) => {
  // ★ 主体 = 不是过渡镜的镜头 (is_transition 不为 true)
  const main = val.shot_plan.filter(s => s.is_transition !== true)
  const transitionCount = val.shot_plan.length - main.length
  if (main.length > 50) {
    ctx.addIssue({
      code: 'custom',
      path: ['shot_plan'],
      message: `主体镜头 ${main.length} 个 > 上限 50 (过渡镜 ${transitionCount} 个不计入预算) — 会被 zod 拒绝整轮重跑`,
    })
  }
  // ★ 下限也按主体口径: 3 个主体镜 + 2 个过渡镜 = 数组 5 个能过数组长度, 但主体只有 3 镜,
  //   违反『少于 5 镜信息量不足』的原意 → 必须拦住。
  if (main.length < 5) {
    ctx.addIssue({
      code: 'custom',
      path: ['shot_plan'],
      message: `主体镜头只有 ${main.length} 个 < 下限 5 (过渡镜 ${transitionCount} 个不计入) — 少于 5 镜信息量不足`,
    })
  }
  const mainSum = main.reduce((a, s) => a + (Number(s.duration) || 0), 0)
  if (mainSum > 750) {
    ctx.addIssue({
      code: 'custom',
      path: ['total_duration'],
      message: `主体镜头总时长 ${mainSum}s > 上限 750s (过渡镜 ${transitionCount} 个不计入)`,
    })
  }
})

/**
 * 文本字段: 接受 string, 也接受 string[] (LLM 偶尔把多角色台词/多段描述输出成数组)。
 *
 * Sprint 22 回归实测 (2026-10-25 drama 15 ep15 step2):
 *   LLM 把 18 个 shot_details 的 dialogue 全输出成了数组 → zod 报
 *   'expected string, received array' ×18 → salvage 救不回来 → 整个 step2 走重试 (一次 5~6 分钟)。
 *
 * ⚠️ 这个 schema 只用于【校验】, 不会作为 response_format 发给 LLM —— 所以放宽它
 *   不会改变 LLM 看到的要求, 只是让偶发的数组输出不再把整轮拆解打挂。
 *   transform 把数组 join('\n') 成字符串 → 下游 (落库/时间轴/注入块) 拿到的永远是 string。
 */
const textOrLines = z.union([z.string(), z.array(z.string())]).transform((v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : v,
)

export const ShotDetailsItemSchema = z.object({
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().optional(),
  character_ids: z.array(z.number().int()).optional(),
  shot_type: textOrLines.optional(),
  angle: textOrLines.optional(),
  movement: textOrLines.optional(),
  location: textOrLines.optional(),
  time: textOrLines.optional(),
  duration: z.number().optional(),
  action: textOrLines.optional(),
  dialogue: textOrLines.optional(),
  description: textOrLines.optional(),
  result: textOrLines.optional(),
  atmosphere: textOrLines.optional(),
  intent_function: textOrLines.optional(),
  /** V3 zod enum 5 维结构化对象 — V2 free-text permanent 已废弃 */
  image_prompt_permanent: V3ImagePromptPermanentSchema.optional(),
  image_prompt_plot_state: textOrLines.optional(),
  video_prompt_permanent: textOrLines.optional(),
  video_prompt_plot_state: textOrLines.optional(),
  // Sprint 11 Task A (PM msg-20261016-001): H3 声音两列 — V4 重构时遗落, 导致 19/19 video_prompt
  //   缺三段式 header, H3 拿不到声音指令自由发挥 → 13/19 镜接近静音 (-45~-52dB)。
  //   旧路径 agents/index.ts:580-588 已有既有措辞, 这里沿用同口径。
  /** 环境底噪 + diegetic 音效 (画面内可听的声音)。无则写 'N/A' */
  sound_effect: textOrLines.optional(),
  /** 该镜配乐描述: 配器 + 速度 + 节奏 + 动态变化。禁止抽象情绪词。无则写 'N/A' */
  bgm_prompt: textOrLines.optional(),
})

export const Step2Schema = z.object({
  shot_details: z.array(ShotDetailsItemSchema),
})

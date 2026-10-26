/**
 * Sprint 19 (PM msg-20261025-082) —— 分镜拆解 prompt 模板抽象层。
 *
 * 为什么要这层: 用户 2026-10-25 提出「现有分镜拆解不要动, 新加一个分支 —— 选 H3 模板时按
 * 官方提示词模板生成, 选默认保持现有逻辑不变」。H3 官方模板跟现在的差别不只是 prompt 文本,
 * 是【输出结构】也不同 (官方是 subject_definitions / summary / retention_analysis /
 * detailed_description / overall_soundscape / non_diegetic_music 六段, 我们是 permanent +
 * description + plot_state 三段拼接), 所以模板必须同时包:
 *   ① step1/step2 的 prompt 文本 + 输出 schema
 *   ② Step3 的 prompt 组装规则 (assemble)
 *   ③ 生成期的注入/清洗 (generation)
 *
 * ⚠️ 本单是【纯重构】: general 模板的行为跟重构前逐字段一致, 不加功能不改输出。
 *    Sprint 20 在此基础上加 H3 模板 (前端选择器也放 Sprint 20)。
 *
 * 通用逻辑【不进模板】(PM 的 critical_split):
 *   DB 事务落库 / applyDurationPolicy 时长体系 / dialogue 规范化 (Sprint 18) /
 *   salvageImagePromptPermanent / permanentToText / storyboard_characters 关联
 *   —— 搬进模板的话, Sprint 20 加 H3 模板时通用逻辑就会有两份, 以后改一处漏一处。
 */
import { z } from 'zod'
import { V3ImagePromptPermanentSchema, type SalvageResult } from '../services/llm-schema-validator.js'
// ★ Sprint 24 fix_1: 翻译契约由模板提供 (类型定义在 ai.ts —— 那是翻译器的地盘)。
//   用 `import type` → 编译期擦除, 不会引入运行时依赖 (prompt-templates 不依赖 services/ai.js)。
import type { VideoTranslateContract } from '../services/ai.js'

// ─── 数据结构 (原 storyboard-planner-service.ts, 搬过来避免循环依赖) ─────────

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
  image_prompt_permanent?: z.infer<typeof V3ImagePromptPermanentSchema> | null
  image_prompt_plot_state?: string
  video_prompt_permanent?: string
  video_prompt_plot_state?: string
  // ── Sprint 23 Task A: H3 官方四段 (general 模板不用, 但 assemble 的入参类型要能带) ──
  subject_definitions?: string
  detailed_description?: string
  overall_soundscape?: string
  non_diegetic_music?: string
}

// ─── 模板接口 ────────────────────────────────────────────────────────────

/** 本镜涉及的角色 (character_ids 已恢复后的结果) */
export interface TemplateCharacter {
  id: number
  name: string
  /** characters.appearance_permanent (跟角色立绘同源) */
  appearance: string
  /** characters.personality (老路径"气质"维) */
  personality: string
  /** characters.role */
  role: string
}

/** assemble 的输入 —— 通用层算好的东西传进来, 模板只管组装 */
export interface AssembleInput {
  /** Step2 输出的一个镜头 */
  shot: ShotDetailsItem
  /** 同场景上一镜 (承接前镜用); 第一镜 / 跨场景时为 null */
  prevShot: ShotDetailsItem | null
  /** 规范化后的 dialogue (通用层算好) */
  dialogue: string
  /** 本镜生效的角色 */
  characters: TemplateCharacter[]
  /** salvageImagePromptPermanent 的结果 (通用层算好) */
  cleanedPermanent: SalvageResult
}

/** assemble 的输出 —— 直接进 DB 的那几个 prompt 字段 */
export interface AssembleOutput {
  imagePrompt: string
  videoPrompt: string
  imagePromptPlotState: string | null
  videoPromptPlotState: string | null
}

/** 平台实际收到的参考图形态 (video-generation 层从 adapter 的 body 判断) */
export type ReferenceImageMode =
  /** Ref2V: body.ref_image_0 有值 → prompt 里可以用 [Picture 1] */
  | 'ref2v-picture-1'
  /** FL2V: body.first_frame 有值 → 没有 Picture 编号 */
  | 'fl2v-first-frame'
  /** 没有参考图 */
  | 'none'

export interface GenerationInjectInput {
  /** 翻译完成、注入之前的最终 prompt */
  prompt: string
  referenceImageMode: ReferenceImageMode
  // ── Sprint 23 Task C (PM msg-20261027-095): H3 模板的生成期注入需要这些 ──
  /** 本镜 storyboard id (取 tts_segments / 角色关联用) */
  storyboardId?: number | null
  /** 本镜所属 episode id (Speaker ID / <Subject N> 编号按 episode 内角色固定序号分配) */
  episodeId?: number | null
  /** 本镜的配音分段 (H3 的 <d>[Chinese]原文</d> 对白块来源; 台词原文一字不改) */
  ttsSegments?: Array<{
    speaker?: string
    text?: string
    isNarrator?: boolean
    voice?: string
  }> | null
  /** 上一镜的收尾状态 (同场景上一镜的 result) —— H3 模板的"承接上一镜"注入用 */
  previousResult?: string | null
  /** 本 episode 的角色 (按 characters.id 升序 = <Subject N> / (Sx) 的编号顺序) */
  characters?: Array<{
    id: number
    name: string
    appearancePermanent?: string
    personality?: string
    role?: string
  }> | null
}

export interface GenerationCleanupInput {
  prompt: string
}

export interface GenerationCleanupOutput {
  prompt: string
  removedAbstract: string[]
  removedTransition: string[]
  ipHits: string[]
}

export interface PromptTemplate {
  id: string
  name: string
  description?: string
  /** Step1: shot_plan 规划 */
  step1: {
    systemPrompt: string
    schema: z.ZodTypeAny
  }
  /** Step2: shot_details 生成 */
  step2: {
    systemPrompt: string
    schema: z.ZodTypeAny
    /**
     * 单个 shot_details 的 item schema (即 step2.schema 里 shot_details 数组的元素类型)。
     *
     * ★ Sprint 23 fix_1 (PM msg-20261026-100): step3 的 revalidate 必须用【模板自己的】item schema,
     *   不能硬编码 general 的 ShotDetailsItemSchema ——
     *   z.object() 默认 strip 未声明的 key, general 的 schema 没声明 H3 的 4 个专有字段
     *   (subject_definitions / detailed_description / overall_soundscape / non_diegetic_music)
     *   → revalidate 时被剥掉 → assembleH3 拿到 undefined → 18 镜的 video_prompt 全是空壳 (95 字符)。
     *   暴露这个出口后, 加新模板不用改 service 层 (保持 sprint-19 的抽象层设计)。
     */
    //   类型定成 z.ZodType<ShotDetailsItem> (不是 ZodTypeAny) —— 否则 z.array() 的输出是 unknown[],
    //   step3 下游 (det.xxx) 全变成 unknown, 一片类型错误。
    itemSchema: z.ZodType<ShotDetailsItem, unknown>
  }
  /** Step3: 从 shot_details 组装 image_prompt / video_prompt */
  assemble(input: AssembleInput): AssembleOutput
  /**
   * 组装后的产物自检 (可选; 不实现 = 不校验, 保持 general 行为不变)。
   *
   * 返回一段错误说明 = 这一镜的产物有问题 (例如 H3 四段全空) → step3 应该直接失败,
   * 而不是静默落库一份空 prompt 等到出片阶段才发现。
   */
  validateAssembled?(input: AssembleInput, output: AssembleOutput): string | null
  /** 生成期 (翻译之后、发平台之前) 的行为 —— Sprint 20 的 H3 模板要在这里关掉 general 的注入 */
  generation: {
    /**
     * 是否注入 Sprint 15/16 的台词时间轴 (<n>0-3.9秒：角色开口:'…'</n>)。
     * ⚠️ H3 官方模板必须关掉 —— 官方用 <d>[Chinese]…</d>, 两套对白标记同时给 H3 会冲突。
     */
    useDialogueTimeline: boolean
    /** 生成期注入 (Sprint 17 的首帧锚点); 返回 null = 不注入 */
    inject(input: GenerationInjectInput): string | null
    /** 生成期清洗 (Sprint 17 的抽象词/拼接指令/IP) */
    cleanup(input: GenerationCleanupInput): GenerationCleanupOutput
    /**
     * 视频 prompt 的翻译契约 (可选)。
     *
     * ★ Sprint 24 fix_1 (PM msg-20261026-102): 翻译器原来硬编码 general 的三段式
     *   ("Integrated multimodal description:" / "Overall soundscape:" / "Non-diegetic music:")
     *   → H3 模板的官方四段每次翻译都被重排成三段 → injectH3 找不到 'detailed_description:' 段
     *   → 对白块/首帧锚点/承接句全部兜底追加到 prompt 末尾 (H3 官方格式等于没送达模型)。
     *
     * 不填 = general 的默认行为 (三段式 + Sprint 16 的描述/时间轴对齐) —— 逐字不变。
     * H3 填一份自己的 (保留官方四段 + 不做时间轴对齐)。
     */
    videoTranslate?: VideoTranslateContract
  }
}

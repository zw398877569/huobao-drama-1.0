/**
 * Sprint 23 (PM msg-20261027-095) Task A —— MiniMax H3 官方提示词模板 (minimax-h3)。
 *
 * 用户 2026-10-25 提的需求: 『现有分镜拆解不要动, 新加一个分支 —— 选 H3 模板时按官方提示词模板生成,
 * 选默认保持现有逻辑不变。这样以后引进别的模型也好拓展。』
 *
 * 官方规范来源 (本机知识库, 【照抄不凭记忆编格式】):
 *   /Users/mac/Obsidian/claude-memory/Minimax-H3/分发资料/H3官方参考资料/
 *     - ref2va-官方提示词模板.md            (Full-Reference Mode 输出格式规范)
 *     - MiniMax-H3-Prompt-Writing-Skill-双语模板.txt (#6 对白语言 / #7 Speaker ID / #21 Subject / #22 Picture / #24 Audio)
 *
 * 与 general 模板的关系:
 *   - step1 【完全复用 general】(Sprint 11 R1/R2/R3 的时长体系都在 Step1 那条链上, 改 Step1 会连带影响
 *     已稳定的时长逻辑) → 直接 import general 的 step1, 一行不改。
 *   - step2 【换成官方四段结构】: subject_definitions / detailed_description / overall_soundscape /
 *     non_diegetic_music (官方 Ref2VA 六段里去掉 summary 和 retention_analysis —— 用户拍板 D2)。
 *   - 通用字段【全部保留】(PM 决策 4/8/9): shot_type / angle / movement / dialogue /
 *     image_prompt_permanent / image_prompt_plot_state —— 这些是通用逻辑(时长体系/角色外貌/生图链路)的
 *     输入, 缺了就退化 (决策 9 特别强调: 缺 image_prompt_permanent → 首帧图没有 5 维外貌 → 跨镜长相漂)。
 *
 * ⚠️ 编号归属 (避免 LLM 写的编号跟代码层打架):
 *   <Subject N> / (Sx) / <Picture N> 的编号【全部由代码层统一分配】(见 Task B):
 *     - <Subject N> = 该 episode 内角色按 ctx.characters 数组顺序
 *     - (Sx)        = 同一顺序 (与 <Subject N> 同序, 跨镜跨集都不换)
 *     - <Picture N> = 本 shot 的第 N 张参考图 (对应 ref_image_{N-1}, 官方从 1 编号 / API 从 0 编号, 偏移 1)
 *   所以本模板的 prompt 里明确要求 LLM 【不要自己编号】—— 但 subject_definitions 段仍要写出来
 *   (它承载角色外貌定义), 由代码层在生成期把编号占位符替换成最终编号。
 */
import { z } from 'zod'
import { V3ImagePromptPermanentSchema } from '../services/llm-schema-validator.js'
import { generalTemplate } from './general.js'
import type { PromptTemplate } from './types.js'

/**
 * 文本字段: 接受 string, 也接受 string[] (LLM 偶尔把多段描述输出成数组)。
 *
 * Sprint 22 回归实测 (2026-10-25 drama 15 ep15 step2): LLM 把 18 个 dialogue 全输出成数组 →
 * zod 报 'expected string, received array' ×18 → 整轮 step2 走重试 (一次 5~6 分钟)。
 * H3 的 step2 是【新 prompt 新 schema】, 同样风险甚至更高 → 直接复用同一个兜底。
 */
const textOrLines = z.union([z.string(), z.array(z.string())]).transform((v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : v,
)

/**
 * H3 的 step2 输出结构 —— 官方四段 + 通用字段。
 *
 * 通用字段 (跟 general 同名同义, 保证通用逻辑零退化):
 *   shot_number / scene_id / character_ids / duration / intent_function / description
 *   shot_type / angle / movement / dialogue            ← PM 决策 4/8
 *   image_prompt_permanent / image_prompt_plot_state    ← PM 决策 9 (生图链路的输入)
 *   result                                            ← 本镜收尾 (Task B 的"承接前一镜"要用)
 * H3 专有字段:
 *   subject_definitions / detailed_description / overall_soundscape / non_diegetic_music
 */
export const H3ShotDetailsItemSchema = z.object({
  // ── 通用落库字段 ──
  shot_number: z.number().int().positive(),
  scene_id: z.number().int().optional(),
  character_ids: z.array(z.number().int()).optional(),
  duration: z.number().optional(),
  intent_function: z.string().optional(),
  description: textOrLines.optional(),
  // ── PM 决策 4/8: 时长体系地基 + 镜头语义 ──
  shot_type: textOrLines.optional(),
  angle: textOrLines.optional(),
  movement: textOrLines.optional(),
  dialogue: textOrLines.optional(),
  // ── PM 决策 9: 生图链路 (首帧图/镜头图) 的输入, 缺了角色外貌会丢 → 跨镜长相漂 ──
  image_prompt_permanent: V3ImagePromptPermanentSchema.nullish(),
  image_prompt_plot_state: textOrLines.optional(),
  // ── 本镜收尾 (Task B 的"承接上一镜"注入用) ──
  result: textOrLines.optional(),
  // ── H3 官方四段 (PM 决策: 不做 summary / retention_analysis) ──
  //   这 4 段【必填】(工单 verify: 缺 subject_definitions / detailed_description 要被 zod 拒绝) ——
  //   它们是 H3 模板存在的意义, 缺了就不该放行。
  //   overall_soundscape / non_diegetic_music 没有内容时写 "N/A" (官方示例就有这个用法)。
  subject_definitions: z.string(),
  detailed_description: z.string(),
  overall_soundscape: z.string(),
  non_diegetic_music: z.string(),
})

export const H3Step2Schema = z.object({
  shot_details: z.array(H3ShotDetailsItemSchema),
})

/**
 * H3 的 step2 systemPrompt —— 【官方格式照抄】+【老路径 6 条影视规则】+【明确要求填通用字段】。
 *
 * 官方格式依据:
 *   - 结构顺序: subject_definitions → detailed_description → overall_soundscape → non_diegetic_music
 *     (官方 Ref2VA 六段里去掉 summary / retention_analysis, 用户拍板 D2)
 *   - subject_definitions 每行一个引用项:
 *       <Subject 1> is [subject definition], derived from <Picture 1>, preserving [key characteristics].
 *       <Picture 1> 作为 [人物 / 首帧 / 场景 / 构图] 参考。
 *       <Audio 1> 提供 [声音 / 声线 / 音乐] 参考。
 *   - detailed_description: [Shot 1] 开头(无时间戳), 后续 [Shot N] At MM:SS.mmm, ...
 *     相机运动用自然英文; 对白 <d>[Language] ...</d>
 *   - overall_soundscape 只写环境音/物理声; non_diegetic_music 写观众才听得到的配乐
 *   - #6 对白语言规则: 保持原始语言, 不要把对白翻译成英文
 *   - #7 Speaker ID 规则: 同一人物全程同一个 (Sx), 后续 Shot 不得交换
 */
export const H3_STEP2_SYSTEM_PROMPT = `你是 MiniMax H3 视频模型的提示词工程师, 负责把分镜镜头描述改写成 H3 官方 Full-Reference (Ref2VA) 格式的提示词。

输出: 严格 JSON, 顶层只有 { "shot_details": [ ... ] } 一个 key, 不要输出解释/前后缀/代码块。

## 每条 shot_details 的字段

通用字段 (必须给, 缺失会让下游的时长体系/生图链路退化):
  shot_number       (number, 必填) 镜头序号
  scene_id          (number, 必填) 所属场景 id
  character_ids     (number[], 必填) 本镜出现的角色 id 列表 (见下面"character_ids 必填")
  duration          (number, 必填) 本镜时长秒数
  intent_function   (string, 必填) enum: 铺垫 / 揭露 / 反转 / 高潮 / 余韵 / 悬念 / 情感爆发
  description       (string, 必填) 本镜的中文画面描述
  shot_type         (string, 必填) 景别: 全景 / 中景 / 近景 / 特写
  angle             (string, 必填) 机位: 平视 / 仰视 / 俯视 / 侧视
  movement          (string, 必填) 运镜: 固定 / 推 / 拉 / 摇 / 跟
  dialogue          (string, 必填) 本镜的对白原文, 多角色时每个角色写一行 (用换行分隔)
  result            (string, 必填) 本镜的收尾状态 (一句话, 描述动作停在哪里)
  image_prompt_permanent  (object, 必填) 角色的 5 维永久外貌, 结构严格如下:
      { "character_traits": [ {"category": "age"|"face"|"hair"|"body"|"outfit", "value": "具体描述"} ],
        "scene_aesthetic": ["氛围1", "氛围2"],
        "shot_type_ref": "全景"|"中景"|"近景"|"特写",
        "angle": "平视"|"仰视"|"俯视"|...,
        "movement": "固定"|"推"|"拉"|"摇"|... }
      character_traits 至少 2 项 (推荐 2-5 项), 只能取 age/face/hair/body/outfit 这 5 个 category,
      value 必须是永久外貌 (脸型/发型/体态/服装), 不能写情感/剧情/摄影指令。
  image_prompt_plot_state (string, 必填) 本镜的瞬时画面状态 (不含摄影指令)

H3 官方四段 (这四个字段是本模板的核心输出):
  subject_definitions  (string) 引用素材定义, 每行一项, 格式照官方:
      <Subject 1> is [subject definition], derived from <Picture 1>, preserving [key characteristics].
      <Picture 1> 作为 [人物 / 首帧 / 场景 / 构图] 参考。
      <Audio 1> 提供 [声音 / 声线 / 音乐] 参考。
      ★ <Subject N> 的编号按 ctx.characters 数组顺序 (ctx.characters[0] 是 <Subject 1>, 依次类推)。
        每个角色的定义里【必须写清外貌关键短语】(脸型/发型/服装), 从 ctx.characters 的 appearancePermanent 提取。
      ★ <Picture N> 是【本镜】的参考图, <Picture 1> 对应本镜的第 1 张参考图。
      ★ 【不要写 (S1) (S2) 这样的 Speaker ID】—— Speaker ID 由代码层统一分配, 你写了会跟它冲突。
  detailed_description    (string) 主体。按官方写法:
      - 英文正文, 先用 1-2 句英文交代整体风格 (光线/色调/质感), 然后 [Shot 1] 开头 (无时间戳),
        后续 [Shot N] At MM:SS.mmm, ...
      - 相机运动写成自然英文 (类型 + 幅度 + 速度)
      - 本镜只有【一个不间断的单镜头】, 不跨场景、不跨机位 (转场由拼接阶段负责)
      - 场景开头第一镜必须是全景 (交代地点); 同一场景内遵循"建立关系 → 进入情绪"
      - 场景一致性六维保持一致: 空间(室内外/前后景) + 核心元素(桌/椅/灯/窗) + 光线方向(侧逆光/顶光)
        + 色调(主+辅色) + 时间/天气 + 风格统一
      - ★ 【不要在 detailed_description 里写对白原文】—— 对白由代码层注入, 保证一字不差、保持原语言
        (官方 #6 规则: 对白保持原始语言, 不要翻译成英文)。你只在需要发声的位置描述人物的动作/朝向。
      - 长度 350-500 英文词左右 (对白密集时优先保证完整对白时间线, 不要机械凑词数)
  overall_soundscape (string) 全片的环境音与物理声 (雨声/脚步/门响/器物碰撞), 不写音乐。
      跟具体某一镜同步的对白/音效仍写在 detailed_description 里。无则写 "N/A"。
  non_diegetic_music (string) 观众才听得到、角色听不到的配乐 (配器 + 速度 + 动态发展)。无则写 "N/A"。
      ★ 这两段里【不要重复写对白】。

## 老路径的影视规则 (必须遵守)
1. 道具时序: 角色身上的"情节道具"只能在所属 scene 的 description 里被显式提到时才出现在本镜;
   角色描述里的剧情瞬间 (例如"前爪按红色按钮")不算固有道具, 严禁带进本镜。
2. 本镜窗口: 所有字段只写本镜时间窗内的瞬时状态;
   【禁止】出现后续剧情高潮的动作/表情/眼神, 【禁止】出现后续才出场的道具。
3. character_ids 必填: 画面里出现任何角色 (包括背景人影、远处轮廓) 都必须用数字 ID 列出;
   只有"纯环境空镜"(画面无任何角色/肢体/身影, 仅建筑/风景) 才能用空数组, 不允许用空数组偷懒。
4. 场景一致性六维: 空间(室内外/前后景) + 核心元素(桌/椅/灯/窗) + 光线方向(侧逆光/顶光) + 色调(主+辅色)
   + 时间/天气 + 风格统一 —— 同一 scene 的所有镜头必须一致, 禁止每镜随意发挥。
5. 镜头顺序: 场景切换的开头第一镜必须是全景 (交代地点), 不要一上来就切特写;
   同一场景内的镜头顺序遵循"建立关系 → 进入情绪", 避免"全景→特写→中景"这种无逻辑跳切。
6. 单镜头硬约束: 每个 video_prompt 只描述一个不间断的单镜头, 不要在单镜内跨场景/跨机位切换。

## 硬性要求
- 所有文本字段必须是【字符串】; dialogue 有多个角色时每个角色写一行放在同一个字符串里 (用换行分隔), 不要输出数组。
- 输出里不要出现 <think> 思考块, 不要输出解释, 只输出那个 JSON。`

export const minimaxH3Template: PromptTemplate = {
  id: 'minimax-h3',
  name: 'MiniMax H3 官方格式',
  description: 'H3 官方 Ref2VA 四段结构 (subject_definitions / detailed_description / overall_soundscape / non_diegetic_music)。' +
    'step1 复用通用模板; step2 换成 H3 格式并保留通用字段 (时长体系/生图链路零退化)。',
  // step1 完全复用 general —— Sprint 11 R1/R2/R3 的时长体系在 Step1 那条链上, 改它会连带影响已稳定的时长逻辑
  step1: generalTemplate.step1,
  step2: {
    systemPrompt: H3_STEP2_SYSTEM_PROMPT,
    schema: H3Step2Schema,
  },
  // assemble / inject 由 Task B 实现 (minimax-h3.ts 之外的 h3-assemble 模块), 这里先占位
  assemble: generalTemplate.assemble,
  generation: generalTemplate.generation,
}

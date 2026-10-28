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
import { logTaskWarn } from '../utils/task-logger.js'
import { V3ImagePromptPermanentSchema, permanentToText } from '../services/llm-schema-validator.js'
import { generalTemplate } from './general.js'
import type {
  AssembleInput,
  AssembleOutput,
  GenerationInjectInput,
  PromptTemplate,
} from './types.js'

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
  //   ★ Sprint 23 fix_2 (PM msg-20261026-100): 这 4 段也走 textOrLines 兜底 (必填版, 不加 .optional())。
  //   实测 (drama 16 ep16): LLM 把 non_diegetic_music 输出成数组 → zod hard reject →
  //   整轮 step2 重试 2 次 (4分13秒 + 2分37秒 + 2分09秒 = 9 分钟) → 前端 420s 超时误报失败。
  //   通用字段当时带了兜底, 这 4 个专有字段漏了 (95daef2 的 commit message 里写过这个风险)。
  subject_definitions: textOrLines,
  detailed_description: textOrLines,
  overall_soundscape: textOrLines,
  non_diegetic_music: textOrLines,
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
      ★ 反向也要一致: dialogue 里的每一句, 都要在 detailed_description 里有对应的说话动作, 顺序一致
  result            (string, 必填) 本镜的收尾状态 (一句话, 描述动作停在哪里)
      ★ 【必须用英文写】—— 它会被代码层注入到 H3 的英文 detailed_description 段里。
        写成中文会被 H3 当成台词直接念出来 (实测 2026-10-26 drama 16 ep16 sb#7:
        音频里把中文收尾状态原样念了出来)。
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
      <Subject 1> is [subject definition], derived from the opening frame, preserving [key characteristics].
      ★ ★ FL2V (首尾帧) 模式的语义 —— 【不要】用 Ref2V 的 <Picture N> 指代人物:
          本镜的参考素材只有【开场帧 + 结束帧】两张, 不存在"人物参考图 N";
          人物身份直接用 the opening frame / the closing frame 指代。
          (实测 2026-10-27: 62 处 <Picture N> 全是 Ref2V 句式 —— 编号在 FL2V 里指的就是首/尾帧,
           编号本身没错位, 但换成直白的 the opening frame 更明确, 模型不用去猜"图1是哪张")。
      <Audio 1> 提供 [声音 / 声线 / 音乐] 参考。
      ★ <Subject N> 的编号按 ctx.characters 数组顺序 (ctx.characters[0] 是 <Subject 1>, 依次类推)。
        每个角色的定义里【必须写清外貌关键短语】(脸型/发型/服装), 从 ctx.characters 的 appearancePermanent 提取。
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
      - ★ 【说话动作必须与 dialogue 逐句对应】—— 你在正文里写某人说话/开口/回答/回应时,
        必须在本镜 dialogue 里找到对应的那句台词 (谁说哪句就写哪句的动作, 顺序一致)。
        【禁止】写没有对应台词的说话动作 (例如台词里没有回答, 就不要写 "moves his lips to answer")。
        没有台词的角色不要描述他开口说话 —— H3 会给"某人说话"的动作自动配语音, 自己补话。
      - ★ 【这是视频, 不是图片】—— 禁止把视频写成静态画面:
          禁用 "the image" / "the picture" / "the frame" / "the visual treatment is ..." 这类静态措辞,
          也不要写 "the image uses ..." / "... dominates the image" 这种描述【一张图】的句式;
          改用视频时态: "The shot opens on ..." / "The camera drifts ..." / "She steps forward, then pauses ..."
          (实测 2026-10-27: ep17 的 detailed_description 里出现 4 次 "the image" (如
           "Cold blue-grey rain dominates the image" / "The image uses cold blue-grey storm light")
           → 视频模型把镜头当静帧 → 成片像定格, 不动)
      - ★ 【屏幕/招牌/纸面上的文字: 只写【画面】, 不写【文字内容】】——
          画面里有手机屏 / 招牌 / 纸质文本时, 只描述画面本身
          (手部动作、屏幕冷光、拇指位置、屏幕过曝或反光、屏幕上模糊的色块),
          让观众感到"他在看订单备注"就够了, 【不要】要求观众能读出内容;
          【禁止】出现 clearly presents / clearly displays / legibly shows / 清晰显示 / 文字清晰可读 这类措辞。
          (渲染可读小字是生图/视频模型的固有短板, 提示词越要求清晰, 成片里越是乱码;
           而同一份提示词的限制项又写着 No text → 自相矛盾。2026-10-28 实测: ep19 镜3
           的 detailed_description 要求"清晰显示订单备注" → 成片手机屏上全是乱码)
      - 长度 350-500 英文词左右 (对白密集时优先保证完整对白时间线, 不要机械凑词数)
  overall_soundscape (string) 全片的环境音与物理声 (雨声/脚步/门响/器物碰撞), 不写音乐。
      跟具体某一镜同步的对白/音效仍写在 detailed_description 里。无则写 "N/A"。
      ★ 【只写环境音/物理声】—— 不要写配乐; 【严禁】把镜头指令/动作描述/构图说明写进这一段
        (camera / shot / framing / take / cut 这些属于 detailed_description)。
  non_diegetic_music (string) 观众才听得到、角色听不到的配乐 (配器 + 速度 + 动态发展)。无则写 "N/A"。
      ★ 【只写配乐】(器乐/速度/节奏/动态变化); 【严禁】把镜头指令、动作描述、构图说明写进这一段
        (它们属于 detailed_description) —— LLM 会把这两段当垃圾桶 (实测: 配乐段末尾混进了
        "Keep the initial frame's composition consistent..." 这种镜头指令)。
      ★ 这两段里【不要重复写对白】。

## 老路径的影视规则 (必须遵守)
1. 道具时序: 角色身上的"情节道具"只能在所属 scene 的 description 里被显式提到时才出现在本镜;
   角色描述里的剧情瞬间 (例如"前爪按红色按钮")不算固有道具, 严禁带进本镜。
2. 本镜窗口: 所有字段只写本镜时间窗内的瞬时状态;
   【禁止】出现后续剧情高潮的动作/表情/眼神, 【禁止】出现后续才出场的道具。
3. ★ 动作不跨镜头边界 (轴5.6, Sprint 28 新增):
   一个【连续动作】(走进画面/走出画面/转身/拿起放下/开门/上楼) 必须完整落在【一个】storyboard 内,
   【严禁】把一个连续动作拆到相邻两个镜头 (前半镜写"林达冒雨登上五楼", 后半镜写"林达已站在楼道里")。
   视频模型只能靠淡入/闪现硬接 → 用户看到的是"人物凭空出现" (2026-10-28 用户实测反馈)。
   要表现"走过来"这个过程, 就【单独给一个镜头】装下它。
   ★ 与轴5.5 本镜窗口的区别: 轴5.5 管的是【不要写本镜窗口之外的状态】(防 plot_state 泄露),
     本条管的是【动作的归属】—— 一个动作不能被拆到两个镜头。
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

// ─── H3 的 assemble: 官方四段 ───────────────────────────────────────────────

/**
 * H3 的 video_prompt 组装 —— 官方四段, 顺序固定:
 *   subject_definitions → detailed_description → overall_soundscape → non_diegetic_music
 * (官方 Ref2VA 六段里的 summary / retention_analysis 用户拍板不做 —— D2)
 *
 * image_prompt 【保持 general 的做法】(工单 B 明确要求): 生图走 nano-banana 那条链,
 * 不该被 H3 模板影响 —— 决策 9 保留 image_prompt_permanent 就是为了这个。
 */
function assembleH3(input: AssembleInput): AssembleOutput {
  const { shot, cleanedPermanent } = input
  const permanentText = cleanedPermanent.imagePromptPermanent
    ? permanentToText(cleanedPermanent.imagePromptPermanent)
    : ''
  const plotStateText = `${shot.image_prompt_plot_state?.trim() || ''}${cleanedPermanent.plotState ? (shot.image_prompt_plot_state ? ' | ' : '') + cleanedPermanent.plotState : ''}`
  const imagePrompt = [permanentText, shot.description || '', plotStateText].filter(Boolean).join('。')

  const videoPrompt = [
    `subject_definitions:\n${(shot.subject_definitions || '').trim()}`,
    `detailed_description:\n${(shot.detailed_description || '').trim()}`,
    `overall_soundscape:\n${(shot.overall_soundscape || 'N/A').trim()}`,
    `non_diegetic_music:\n${(shot.non_diegetic_music || 'N/A').trim()}`,
  ].join('\n\n')

  return {
    imagePrompt,
    videoPrompt,
    imagePromptPlotState: plotStateText || null,
    videoPromptPlotState: shot.video_prompt_plot_state || null,
  }
}

/**
 * ★ Sprint 23 fix_4 (PM msg-20261026-100): 组装后自检 —— 四段全空就直接失败, 别静默落库一份空 prompt。
 *
 * 背景: 这次 H3 四段全空 (18 镜 video_prompt 长度全是 95) 整个过程【没有任何一条日志告警】,
 *   排查只能靠 QA 逐镜比对长度才发现。step3 一旦产出空壳 prompt, 要等到出片阶段才暴露。
 *
 * overall_soundscape / non_diegetic_music 允许写 "N/A" (官方示例的用法), 但不允许是空字符串。
 */
function validateH3Assembled(input: AssembleInput, output: AssembleOutput): string | null {
  const missing: string[] = []
  for (const name of H3_SECTION_NAMES) {
    // 产物侧检查 (video_prompt 是真正要落库的那份): 段标题后面必须有正文
    const m = new RegExp(`^${name}:\\n(.+)$`, 'm').exec(output.videoPrompt || '')
    if (!m || !m[1].trim()) missing.push(name)
  }
  if (!missing.length) return null
  // 再回溯到源字段, 给出更准确的报错 (是 LLM 没产出, 还是组装时丢了)
  const shot = input.shot as unknown as Record<string, unknown>
  const sourceMissing = H3_SECTION_NAMES.filter((n) => !String(shot[n] || '').trim())
  return sourceMissing.length
    ? `H3 四段缺失: ${sourceMissing.join(', ')} —— 这一镜的 video_prompt 是空壳, 不该落库`
    : `H3 产物自检失败: video_prompt 的 ${missing.join(', ')} 段没有正文 (组装结果异常)`
}

// ─── H3 的生成期注入: Subject 绑定 / Speaker ID / 对白 / 限制项 ───────────────

/**
 * 官方限制项 —— 【有台词的镜】用这套 (Ref2VA 官方原版写法)。
 * 出处: 来源说明.txt:41-42 "官方原版提示词的限制项标准写法: No text, subtitles, logos or watermarks of any kind"
 */
const H3_CONSTRAINTS =
  'No text, subtitles, logos or watermarks of any kind, single continuous shot without cuts, ' +
  'maintain spatial continuity, avoid character deformation and identity drift.'

/**
 * 官方限制项 —— 【无台词的镜】用这套 (T2V 官方原版写法, 多一句 'no dialogue')。
 * 出处: 04-API版-文生视频T2V-极地飞行.txt:8 结尾 "No text, no logos, no dialogue."
 *
 * ★ Sprint 24 fix_2 (PM msg-20261026-109): 官方要靠【一整句 'no dialogue'】才压得住自发声
 *   (说明问题在"有没有明确禁止发声", 不在引号)。
 *   无台词的镜 H3 没有 <d> 块可依据, 最容易自己补话 (107 里 'moves his lips to answer' 就是这种症状)。
 */
const H3_CONSTRAINTS_NO_DIALOGUE =
  'No text, subtitles, logos or watermarks of any kind, no dialogue, single continuous shot without cuts, ' +
  'maintain spatial continuity, avoid character deformation and identity drift.'

/** 首帧锚点 —— 沿用 Sprint 17 的同一句, 但放进 detailed_description 内部 */
const H3_OPENING_ANCHOR =
  "opening frame matches [Picture 1]; continues from previous shot's tail composition"

/**
 * 对白原文 → 官方要求的标点形态。
 * 官方: "Standardize punctuation to the basic written marks needed to express the sentence,
 * such as ',', '.', '?', and '!'; remove repeated tildes, emoji, bullets, and repeated or
 * decorative punctuation." —— 台词内容一个字不改, 只清装饰符。
 */
export function normalizeDialogueForH3(text: string): string {
  let t = String(text || '').trim()
  if (!t) return ''
  t = t.replace(/[“”‘’「」『』"]/g, '')            // 中文引号
  t = t.replace(/[…]{2,}|\.{4,}/g, '...')              // 连续省略号 → 单个
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')  // emoji
  t = t.replace(/\s+/g, ' ').trim()
  if (t && !/[.?!。！？…]$/.test(t)) t += '.'
  return t
}

/**
 * H3 的四个段名 —— 段边界【只认这四个】。
 *
 * ★ Sprint 23 追加 P2 (PM msg-20261026-099): 原来用通用的 "英文词+冒号" 模式找下一段,
 *   detailed_description 正文里出现 "Note: xxx" / "camera moves left: xxx" 这种
 *   【空行 + 英文短语 + 冒号】就会被误判成下一段 → 对白块/承接句插到错误位置。
 */
const H3_SECTION_NAMES = ['subject_definitions', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']
const H3_NEXT_SECTION_RE = new RegExp(`\\n\\n(?=(?:${H3_SECTION_NAMES.join('|')})\\s*:)`, 'i')

/**
 * 在某个段 (subject_definitions / detailed_description / ...) 的【开头】插一段文本。
 * 段格式是我们自己拼的 (段标题独占一行, 段之间空行), 所以定位是可靠的。
 */
function prependToSection(prompt: string, section: string, block: string): string {
  const re = new RegExp(`(^|\\n)(${section}\\s*:)`, 'i')
  const m = re.exec(prompt)
  if (!m) {
    // ★ Sprint 24 fix_2 (PM msg-20261026-102): 定位失败【不能静默】——
    //   之前这里直接兜底追加到 prompt 末尾, 没有任何日志 → 以为 H3 格式生效了, 实际全堆在末尾。
    //   最常见触发原因: 翻译器把 H3 四段重排成了 general 三段 (已由 videoTranslate 契约修掉),
    //   但翻译器不保证 100% 听话 → 这里留一道告警。
    logTaskWarn('PromptTemplate', 'h3-section-not-found', {
      section,
      action: 'append-to-prompt-end',
      promptHead: prompt.slice(0, 200),
      hint: '找不到 H3 段标题 —— 注入内容已追加到 prompt 末尾 (不是段内)。检查翻译器是否重排了段名。',
    })
    return `${prompt.trimEnd()}\n\n${block}`
  }
  const at = m.index + m[0].length
  return `${prompt.slice(0, at)}\n${block}${prompt.slice(at)}`
}

/** 在某个段的【末尾】插一段文本 */
function appendToSection(prompt: string, section: string, block: string): string {
  const re = new RegExp(`(^|\\n)(${section}\\s*:)`, 'i')
  const m = re.exec(prompt)
  if (!m) {
    // ★ Sprint 24 fix_2: 同 prependToSection —— 定位失败要留痕, 不能静默
    logTaskWarn('PromptTemplate', 'h3-section-not-found', {
      section,
      action: 'append-to-prompt-end',
      promptHead: prompt.slice(0, 200),
      hint: '找不到 H3 段标题 —— 注入内容已追加到 prompt 末尾 (不是段内)。检查翻译器是否重排了段名。',
    })
    return `${prompt.trimEnd()}\n\n${block}`
  }
  const bodyStart = m.index + m[0].length
  const rest = prompt.slice(bodyStart)
  const nextSec = H3_NEXT_SECTION_RE.exec(rest)
  const bodyEnd = nextSec ? bodyStart + nextSec.index : prompt.length
  const body = prompt.slice(bodyStart, bodyEnd).trimEnd()
  return `${prompt.slice(0, bodyStart)}\n${body}\n\n${block}${prompt.slice(bodyEnd)}`
}

/**
 * H3 的生成期注入。
 *
 * 做什么 (工单 B):
 *   ① <Subject N> 绑定: 角色 → <Subject N>, 编号 = characters 数组下标 + 1
 *      (characters 已按 characters.id 升序 —— 跟 <Subject N> / (Sx) 的编号顺序一致, 跨镜跨集都不换)
 *   ② (Sx) Speaker ID: 跟 <Subject N> 同序 (官方 #7: 同一人物全程同一个 Speaker ID)
 *   ③ 对白块: 从 tts_segments 生成 `<Subject N> (Sx) says, <d>[Chinese]台词原文</d>`
 *      —— 台词【一字不改】(官方: preserve the exact source words and original language)
 *   ④ 首帧锚点: 放进 detailed_description 内部 (不追加到末尾)
 *   ⑤ 承接上一镜 result: 放进 detailed_description
 *   ⑥ 限制项: 独立末段
 *
 * ⚠️ 对白是【代码层】注入的 (官方要求 preserve the exact source words) —— LLM 写的话会被改写。
 * ⚠️ 这个 hook 在【翻译之后】跑 (video-generation.ts), 所以中文台词肯定不会被翻。
 */
function injectH3(input: GenerationInjectInput): string | null {
  const { prompt, referenceImageMode, ttsSegments, characters } = input
  if (!prompt) return null
  let out = prompt

  // ① 首帧锚点 (官方 §5.3: the shot begins from <Picture 1> —— 这里用 Sprint 17 的同一句)
  if (referenceImageMode === 'ref2v-picture-1' || referenceImageMode === 'fl2v-first-frame') {
    out = prependToSection(out, 'detailed_description', H3_OPENING_ANCHOR)
  }

  // ② 对白块 (从 tts_segments; 台词原文一字不改)
  const charList = characters || []
  // ★ Sprint 23 追加 P2 (PM msg-20261026-099): 精确匹配失败时按"去掉括号/空格后的规范化名"再匹配一次。
  //   关键是不管怎么匹配, 同一角色名必须映射到【同一个编号】—— 否则跨镜 Speaker ID 会乱
  //   (官方 #7: 同一人物在整个视频中必须始终使用同一个 Speaker ID)。
  const normalizeName = (s: string): string =>
    String(s || '').replace(/[（(].*?[)）]/g, '').replace(/[\s·・]/g, '').trim()
  const subjectIndexOf = (name: string): number => {
    const n = (name || '').trim()
    if (!n) return 0
    const exact = charList.findIndex((c) => c.name === n)
    if (exact >= 0) return exact + 1
    const nn = normalizeName(n)
    if (!nn) return 0
    const loose = charList.findIndex((c) => normalizeName(c.name) === nn)
    return loose >= 0 ? loose + 1 : 0
  }
  const dialogueLines: string[] = []
  for (const seg of ttsSegments || []) {
    const text = normalizeDialogueForH3(seg.text || '')
    if (!text) continue
    const idx = subjectIndexOf(seg.speaker || '')
    // 匹配上 → 官方格式 `<Subject N> (Sx) says, <d>…</d>`;
    // 匹配不上 → 官方 §5.4 的降级写法 "a stable voice description followed by (Sx)" 的简化版
    //   (这里直接用角色名当 voice 描述; 没有可分配的编号就不硬造一个, 免得跨镜编号乱)
    const who = idx > 0 ? `<Subject ${idx}> (S${idx})` : `(${seg.speaker || 'the speaker'})`
    dialogueLines.push(`${who} says, <d>[Chinese]${text}</d>`)
  }
  if (dialogueLines.length) {
    out = appendToSection(out, 'detailed_description', dialogueLines.join(' '))
  }

  // ③ 承接上一镜 result (放进 detailed_description)
  const prev = (input.previousResult || '').trim()
  if (prev) {
    // ★ Sprint 24 fix_3 (PM msg-20261026-107): 去掉【裸引号】——
    //   H3 把【引号里的内容】当成角色要说的话 → 承接句是【画面状态描述】, 被原样念出来
    //   (实测 drama 16 ep16 sb#7 video id=193: 音频里念出了中文收尾状态)。
    //   官方规范里也没有"用引号包叙述文字"的写法 → 引号是我们自创的、H3 会误读的信号。
    //   防呆: normalizeDialogueForH3 已经剥掉中英文引号, 这里再兜一层 (残留引号一律不能进 prompt)。
    const prevText = normalizeDialogueForH3(prev).replace(/[“”‘’「」『』"]/g, '').trim()
    // ★ Sprint 24 fix_1 (PM msg-20261026-109): 处理后仍含非 ASCII → 【不注入承接句】(降级)。
    //   理由: 107 拆掉了【引号】这个信号, 但"一段没有 <d> 包裹、没有引号的中文叙述"
    //   本身就是 H3 的发声信号 —— 官方 T2V 结尾要靠整句 "No text, no logos, no dialogue."
    //   才压得住自发声, 说明关键在【有没有明确禁止发声】, 不在引号。
    //   承接句是【锦上添花】的画面连续性提示, 不注入只少一条上下文;
    //   被当台词念出来是实打实的成片污染 (要重生成 + 配音重做, 用户白等一轮)。
    //   ⚠️ 不改成"把中文翻译成英文再注入": injectH3 是同步纯函数, 那里没有翻译器;
    //      硬塞一次 LLM 调用会给每镜加延迟和成本, 收益只是"多一条可选上下文"。
    //   ★ fix_1 (step2 prompt 要求 result 写英文) 生效时走不到这个分支 → 纯兜底, 不影响正常路径。
    if (/[^\x00-\x7F]/.test(prevText)) {
      // ★ Sprint 24 fix_5 (保留): warn —— fix_1 只是 prompt 约束, 不是 100% 保证。
      //   不 warn 的话, 这个问题只能靠逐字比对最终 prompt 才能发现 (上次就是这样)。
      logTaskWarn('PromptTemplate', 'h3-continuity-not-english', {
        storyboardId: input.storyboardId,
        prevPreview: prevText.slice(0, 120),
        hint: '承接上一镜的内容不是英文 —— 已跳过注入承接句 (降级), 避免 H3 把画面状态当台词念出来; 检查 step2 的 result 字段 (要求写英文)',
      })
    } else {
      // 结尾标点只补一次 (prev 自带句号时别叠成 "..")
      const prevTail = /[.。!?！？…]$/.test(prevText) ? prevText : `${prevText}.`
      out = appendToSection(out, 'detailed_description',
        `Continues from the closing state of the previous shot: ${prevTail}`)
    }
  }

  // ④ 限制项 (独立末段)
  //   ★ Sprint 24 fix_2 (PM msg-20261026-109): 按【本镜有没有台词】动态选官方两套写法。
  //   ⚠️ 有台词的镜【绝对不能】加 'no dialogue' —— 会把真台词也压掉, 比现在更糟。
  const constraints = dialogueLines.length ? H3_CONSTRAINTS : H3_CONSTRAINTS_NO_DIALOGUE
  out = `${out.trimEnd()}\n\n${constraints}`
  return out
}

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
    // ★ Sprint 23 fix_1: step3 revalidate 用这个 —— 否则 zod 会把 H3 的 4 个专有字段 strip 掉。
    itemSchema: H3ShotDetailsItemSchema,
  },
  assemble: assembleH3,
  // ★ Sprint 23 fix_4: 四段全空 → step3 直接失败 (别静默落库空 prompt)
  validateAssembled: validateH3Assembled,
  generation: {
    // 官方用 <d>[Chinese]…</d>, 不能跟 general 的 <n>0-3.9秒：开口:'…'</n> 同时给 H3 (语义冲突)
    useDialogueTimeline: false,
    // ★ Sprint 24 fix_1: H3 的翻译契约 —— 翻译器必须原样保留官方四段 (不加 '### ' 前缀),
    //   并且不做 general 的时间轴对齐 (H3 没有 <n> 时间轴)。
    //   背景: 翻译器原来硬编码 general 的三段式 → H3 四段每次都被重排
    //   (实测 2026-10-26 16:56 drama 16 ep16 sb#7: 翻译后 3131 字符, 四个 H3 段名一个都不在)
    //   → injectH3 定位不到段 → 注入内容全部堆到 prompt 末尾。
    videoTranslate: {
      sectionHeaders: ['subject_definitions:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'],
      preserveTags: ['<Subject N>', '<Picture N>'],
      alignSpeakingSchedule: false,
    },
    inject: injectH3,
    // 清洗沿用 general 的 (抽象词/切黑指令/IP) —— 跟模板无关, 是安全网
    cleanup: generalTemplate.generation.cleanup,
  },
}

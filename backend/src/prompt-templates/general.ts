/**
 * Sprint 19 (PM msg-20261025-082) —— general 模板。
 *
 * ⚠️ 本文件是【纯搬家】: 下面的两个 systemPrompt 字符串和 assemble() 的组装逻辑,
 *   都是从 storyboard-planner-service.ts 【逐字符原样搬过来】的, 一行逻辑都没改。
 *   验收方式: 重构前后把两段 prompt 从源码里导出来做 diff, 必须为空
 *   (golden 基线见 handoff DEV_to_PM_msg-20261025-0xx.json)。
 *
 * 为什么 prompt 文本也要进模板:
 *   Sprint 20 的 H3 模板跟现在的差别不只是组装规则, step1/step2 的【输出结构】就不同
 *   (官方是 subject_definitions / summary / retention_analysis / detailed_description 六段),
 *   所以 prompt 文本 + schema + assemble 三样必须绑在一个模板里, 缺一样都切不开。
 */
import { ensureH3ThreePartPrompt } from '../utils/h3-prompt.js'
import { embedDialogueInline } from '../utils/dialogue-timeline.js'
import { cleanupVideoPrompt } from '../utils/prompt-cleanup.js'
import {
  OPENING_FRAME_ANCHOR,
  buildAppearanceBlock,
  buildContinuityBlock,
  buildResultBlock,
  ensureIntegratedHeader,
  getRhythmFormula,
  insertAtIntegratedStart,
  insertIntoIntegratedSection,
} from '../utils/storyboard-rules.js'
import { permanentToText } from '../services/llm-schema-validator.js'
import { Step1Schema, Step2Schema, ShotDetailsItemSchema } from './schemas.js'
import type { AssembleInput, AssembleOutput, PromptTemplate } from './types.js'

// ─── Step1 prompt (原 storyboard-planner-service.ts runStep1, 逐字符搬过来) ────
export const GENERAL_STEP1_SYSTEM_PROMPT = `你是资深影视分镜师 + 短剧节奏导演。
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

// ─── Step2 prompt (原 storyboard-planner-service.ts runStep2, 逐字符搬过来) ────
export const GENERAL_STEP2_SYSTEM_PROMPT = `你是资深影视分镜师。
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
- Sprint 17 (PM msg-20261021-076) Task D: V4 重构时丢失的 5 条影视规则 —— 补回, 违反 = 镜头作废
  ① 镜头顺序铁律 (老路径 二): 场景切换的开头第一镜必须是全景(交代地点), 不要一上来就切特写;
     同一场景内的镜头顺序遵循"建立关系 → 进入情绪"; 避免"全景→特写→中景"这种无逻辑跳切
  ② 单镜头硬约束 (老路径 四.1): 每个 video_prompt 必须描述"仅限一个不间断的单镜头",
     不要在单个 storyboard 内跨场景/跨机位切换 (转场交给拼接阶段)
  ③ 场景一致性 6 维 (老路径 六): 空间(室内外/前后景) + 核心元素(桌/椅/灯/窗) + 光线方向(侧逆光/顶光)
     + 色调(主+辅色) + 时间/天气 + 风格统一; 同一 scene_id 下所有镜头的 atmosphere 关键词
     必须从这 6 维派生, 禁止每镜随意发挥
  ④ 时间戳分段 (老路径 四.4): 本镜【无 dialogue】时, video_prompt_plot_state 按动作顺序分段写,
     每段用 <n>起-止秒：内容</n> 形式 (不闭合, 项目规范), 每段约 3 秒, 连续不间断, 总时长对齐本镜 duration
     ⚠️ 本镜【有 dialogue】时严禁自己写带时间码的段落 —— 台词时间轴由后端按配音音频自动生成,
     你只按动作顺序写动作, 否则两套时间码会重叠打架
  ⑤ 禁止混写 (老路径 十): 禁止把 action + result + dialogue 混在一句话 (分开填三个字段)
     ⚠️ 所有文本字段 (action / dialogue / description / result / atmosphere / sound_effect / bgm_prompt)
        必须是【字符串】, 一个字段一个字符串. dialogue 有多个角色时, 把每个角色写成一行,
        全部放在同一个字符串里 (用换行分隔), 【不要输出数组】.
  ⑥ 5D 摄影参数 (老路径 七): video_prompt_permanent 必须写全 5 维, 每维各选一项, 用英文术语:
     景别 ECU/CU/MS/MLS/WS + 焦距 24mm/35mm/50mm/85mm + 运镜 static/slow dolly in/dolly out/
     pan left/pan right/handheld/tilt up/tilt down + 景深 shallow f/1.8/standard f/4/deep f/8 +
     视角 eye-level/low angle/high angle/dutch tilt/over-shoulder/POV
     例: "MS 50mm, eye-level, slow dolly in, shallow f/1.8" —— 缺维度 H3 会自己补, 画面失控
  ★ 文字只写画面不写内容 (Sprint 28 新增, PM msg-20261028-130): 画面里有手机屏/招牌/纸质文本时,
    只描述画面本身 (手部动作、屏幕冷光、拇指位置、屏幕过曝/反光、模糊的色块),
    让观众感到"他在看订单备注"就够了, 【不要】要求观众能读出内容;
    【禁止】出现 clearly presents / clearly displays / legibly shows / 清晰显示 / 文字清晰可读 这类措辞
    (渲染可读小字是生图/视频模型的固有短板, 提示词越要求清晰, 成片里越是乱码;
     而同一份提示词的限制项又写着 No text → 自相矛盾)
- Sprint 17 (PM msg-20261021-076) Task F: 补回老 storyboard_planner 的规则 (V4 重构时丢失)
  ★ 道具时序 (轴5): 角色身上的"情节道具"只能在所属 scene 的 description 里被显式提到时, 才能在本镜出现;
    character.description 里描述的情节瞬间 (例如"前爪按红色按钮"这种特定剧情动作/物体) 不算"角色固有道具",
    首镜 frame/正文严禁默认带入; 违反 = 剧情时序错乱, 观众看不懂为什么某镜有某物
  ★ 本镜窗口 (轴5.5): shot.action / description / result / atmosphere / dialogue 必须严格只描述本镜
    [start_time, end_time] 时间窗口内的瞬时状态; 禁止包含 (a) 后续剧情高潮时刻的动作/表情/眼神
    (例: 开场镜严禁写"复活后眼睛放光、嘴角咧开露出诡异笑意" —— 那是后续高潮镜的状态)
    (b) 后续剧情才出现的道具 (例: 开场镜严禁写"爪子飞快按动按钮" —— 按钮是后续高潮镜才出现的)
    (c) 角色 appearance 里夹杂的"剧情态瞬间"; 强制: 想象本镜只占 X 秒, 只写这 X 秒内的瞬时状态
  ★ 动作不跨镜头边界 (轴5.6, Sprint 28 新增):
    一个【连续动作】(走进画面/走出画面/转身/拿起放下/开门/上楼) 必须完整落在【一个】storyboard 内,
    【严禁】把一个连续动作拆到相邻两个镜头 (前半镜写"林达冒雨登上五楼", 后半镜写"林达已站在楼道里")。
    视频模型只能靠淡入/闪现硬接 → 用户看到的是"人物凭空出现" (2026-10-28 用户实测反馈)。
    要表现"走过来"这个过程, 就【单独给一个镜头】装下它。
    ★ 与轴5.5 本镜窗口的区别: 轴5.5 管的是【不要写本镜窗口之外的状态】(防 plot_state 泄露),
      本条管的是【动作的归属】—— 一个动作不能被拆到两个镜头。
  ★ character_ids 必填: 画面里出现任何角色 (包括背景人影、远处轮廓), character_ids 必须用数字 ID 列出;
    仅"纯环境空镜"(画面无任何角色/肢体/身影, 仅建筑/风景) 才能用空数组, 不允许用空数组偷懒
  ★ 情绪景别 (轴2): 情绪越强 → 景别越近 + 运镜越慢 (ECU > CU > MS > MLS > WS)
  ★ 节奏控制 (轴3): 动静结合, 关键处制造停顿 —— 不要"全程加速", 用停顿/慢推替代连切
plot_state 段 (image_prompt_plot_state): 自由 string, 允许剧情瞬时动作/表情/物件状态。
输出: 严格 JSON { shot_details: [{shot_number, scene_id, character_ids, shot_type, angle, movement, location, time, duration, action, dialogue, description, result, atmosphere, intent_function, image_prompt_permanent, image_prompt_plot_state, video_prompt_permanent, video_prompt_plot_state, sound_effect, bgm_prompt}] }`

/**
 * Step3 的 prompt 组装 —— 从 storyboard-planner-service.ts 的 runStep3 逐字搬过来。
 *
 * 通用层 (planner-service) 负责算好这些再传进来:
 *   - cleanedPermanent (salvageImagePromptPermanent 的结果)
 *   - characters     (character_ids 恢复 + 角色表查询之后的结果)
 *   - dialogue       (Sprint 18 的多角色规范化结果)
 *   - prevShot       (同场景上一镜; 跨场景/第一镜为 null)
 */
function assembleGeneral(input: AssembleInput): AssembleOutput {
  const { shot, prevShot, dialogue, characters, cleanedPermanent } = input

  const permanentText = cleanedPermanent.imagePromptPermanent
    ? permanentToText(cleanedPermanent.imagePromptPermanent)
    : ''
  const plotStateText = `${shot.image_prompt_plot_state?.trim() || ''}${cleanedPermanent.plotState ? (shot.image_prompt_plot_state ? ' | ' : '') + cleanedPermanent.plotState : ''}`

  // Sprint 17 Task A/B/C: 角色外貌 / 承接上一镜 / 本镜收尾 / 戏型节奏 4 个注入块
  const appearanceBlock = buildAppearanceBlock(characters)
  const prevResult = prevShot && prevShot.scene_id === shot.scene_id ? prevShot.result : ''
  const continuityBlock = buildContinuityBlock(prevResult)
  const resultBlock = buildResultBlock(shot.result)
  const rhythmFormula = getRhythmFormula(shot.intent_function)
  const injectedBlocks = [appearanceBlock, continuityBlock, resultBlock, rhythmFormula?.zh || ''].filter(Boolean).join('\n')

  const imagePrompt = [
    permanentText,
    shot.description || '',
    plotStateText,
  ].filter(Boolean).join('。')

  let videoPromptText = ensureIntegratedHeader(
    ensureH3ThreePartPrompt(
      [
        shot.video_prompt_permanent || '',
        shot.description || '',
        shot.video_prompt_plot_state || '',
      ].filter(Boolean).join('。'),
      shot.sound_effect,
      shot.bgm_prompt,
    ),
  )
  if (injectedBlocks) {
    videoPromptText = insertIntoIntegratedSection(videoPromptText, injectedBlocks)
  }

  return {
    imagePrompt,
    videoPrompt: embedDialogueInline(videoPromptText, dialogue),
    imagePromptPlotState: plotStateText || null,
    videoPromptPlotState: shot.video_prompt_plot_state || null,
  }
}

export const generalTemplate: PromptTemplate = {
  id: 'general',
  name: '通用模板（现有分镜拆解逻辑）',
  description: '默认模板 —— 输出结构跟重构前逐字段一致。Sprint 20 会在此基础上加 H3 官方模板。',
  step1: {
    systemPrompt: GENERAL_STEP1_SYSTEM_PROMPT,
    schema: Step1Schema,
  },
  step2: {
    systemPrompt: GENERAL_STEP2_SYSTEM_PROMPT,
    schema: Step2Schema,
    // ★ Sprint 23 fix_1: step3 revalidate 用这个 —— 跟重构前逐字等价 (就是同一个 schema 对象), general 零回归。
    itemSchema: ShotDetailsItemSchema,
  },
  assemble: assembleGeneral,
  generation: {
    // Sprint 15/16 的台词时间轴 —— general 开着 (行为不变)
    useDialogueTimeline: true,
    // Sprint 17 Task B 的首帧锚点 —— 只有平台真收到参考图才注入
    //
    // ★ Sprint 23 Task B: 契约统一为【返回完整 prompt】——
    //   Sprint 17 这里是返回"要插入的片段", 由 video-generation 插到开头;
    //   但 H3 模板要注入多处 (首帧锚点 / 对白块 / 承接上一镜 / 限制项), 片段契约表达不了。
    //   general 的【行为不变】: 同一句锚点, 同样插在开头, 只是由模板自己完成插入。
    inject(input) {
      let anchor: string | null = null
      if (input.referenceImageMode === 'ref2v-picture-1') anchor = OPENING_FRAME_ANCHOR
      else if (input.referenceImageMode === 'fl2v-first-frame') {
        anchor = 'the opening frame continues the composition of the given first frame'
      }
      if (!anchor) return input.prompt
      return insertAtIntegratedStart(input.prompt, anchor)
    },
    // Sprint 17 Task E 的代码层清洗
    cleanup(input) {
      const r = cleanupVideoPrompt(input.prompt)
      return {
        prompt: r.text,
        removedAbstract: r.removedAbstract,
        removedTransition: r.removedTransition,
        ipHits: r.ipHits,
      }
    },
  },
}

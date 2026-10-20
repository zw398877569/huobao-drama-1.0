/**
 * Sprint 17 (PM msg-20261021-076) —— V4 三步重构丢失的影视规则, 集中在本文件。
 *
 * 背景: V4 planner (services/storyboard-planner-service.ts) 替换了老的两个 agent
 *   (agents/index.ts 的 storyboard_breaker L487-663 + storyboard_planner L1025-1277),
 *   老 agent 的 17 条影视规则有 12 条没被搬过来, 全部丢失。本文件把「规则本身」抽出来,
 *   让 planner-service (拆解期注入) 和 video-generation (生成期注入/清洗) 共用同一份实现。
 *
 * ⚠️ 本文件只放【纯函数 + 常量】, 不查 DB、不打日志 —— 好测、好复用、好 review。
 *    需要 DB / 日志的胶水代码在 service 层。
 */

// ─── Task C: 8 种戏型节奏公式 ───────────────────────────────────────────────

/**
 * 老路径 (agents/index.ts:523-534) 的 8 种戏型节奏公式:
 *
 *   心动戏 → 慢，眼神/细节要停留
 *   对峙戏 → 前慢后快，关键台词后停顿 + 切反应镜头
 *   反转戏 → 铺垫稳，证据出现要快，关键证据可慢动作
 *   悬疑戏 → 前慢，中间给细节，反应镜头要停顿
 *   惊悚戏 → 前面放慢，惊吓瞬间极快
 *   喜剧戏 → 包袱出现后必须有反应镜头停顿
 *   线索戏 → 前 3 秒先讲重点，步骤清楚
 *   动作戏 → 先交代空间，再快切动作
 *
 * 老路径是【按 scene_intention.function】选的, 新路径的 intent_function 词表完全不同
 * (7 值: 铺垫/揭露/反转/高潮/余韵/悬念/情感爆发), 没有 心动/惊悚/喜剧/动作 这 4 个对应值。
 * 下面用 PM 提议的映射做默认值 (PM msg-20261021-076 Task C: "映射要写进 handoff 让 PM 审"),
 * 8 戏型里没有对应 intent_function 的 (惊悚/喜剧/动作) 暂时用不上。
 *
 * ⚠️ 待 PM 确认: 揭露→对峙戏 / 余韵→心动戏 这两条是 PM 的提议, 不是唯一合理解释。
 *    改这里之前先看 handoff DEV_to_PM_msg-20261021-xxx.json 里的映射表说明。
 */
export const RHYTHM_FORMULAS: Record<string, { zh: string; en: string }> = {
  // 线索戏 → 铺垫
  '铺垫': {
    zh: '节奏: 铺垫戏 —— 前 3 秒先讲重点, 步骤清楚, 不急着推进',
    en: 'Pacing: setup — lead with the key point in the first 3 seconds, keep each step clearly readable, do not rush ahead.',
  },
  // 对峙戏 → 揭露
  '揭露': {
    zh: '节奏: 对峙戏 —— 前慢后快, 关键台词后停顿一下, 留反应镜头的余地',
    en: 'Pacing: confrontation — start slow, accelerate after the key line, then hold a brief pause that leaves room for a reaction beat.',
  },
  // 反转戏 → 反转
  '反转': {
    zh: '节奏: 反转戏 —— 铺垫稳, 证据出现要快, 关键证据可以慢动作',
    en: 'Pacing: reversal — keep the setup steady, let the evidence arrive fast, and allow slow motion on the decisive piece of evidence.',
  },
  // 对峙戏 → 高潮
  '高潮': {
    zh: '节奏: 高潮对峙 —— 前慢后快, 关键台词后停顿 + 切反应镜头',
    en: 'Pacing: climax confrontation — start slow, accelerate into the clash, pause after the key line and cut to the reaction.',
  },
  // 悬疑戏 → 悬念
  '悬念': {
    zh: '节奏: 悬疑戏 —— 前慢, 中间给细节, 反应镜头要停顿',
    en: 'Pacing: suspense — go slow up front, dwell on the telling detail in the middle, and hold still on the reaction shot.',
  },
  // 心动戏 → 情感爆发
  '情感爆发': {
    zh: '节奏: 情感爆发 —— 慢, 眼神和细节要停留, 让情绪自己上来',
    en: 'Pacing: emotional peak — go slow, let the eyes and fine details linger, and let the feeling build on its own.',
  },
  // 心动戏 → 余韵
  '余韵': {
    zh: '节奏: 余韵 —— 慢下来, 眼神和细节要停留, 收在情绪上',
    en: 'Pacing: afterglow — slow down, let the eyes and fine details linger, and settle the shot on the emotion.',
  },
}

/** 取某个 intent_function 的节奏公式 (zh + en), 没有对应 → null */
export function getRhythmFormula(intentFunction: string | null | undefined): { zh: string; en: string } | null {
  if (!intentFunction) return null
  return RHYTHM_FORMULAS[intentFunction] ?? null
}

// ─── Task A: 角色外貌 ────────────────────────────────────────────────────────

/**
 * plot_state 污染关键词 —— 出现在 characters.appearance_permanent 里就是「剧情瞬时状态」,
 * 不是永久外貌, 注入 video_prompt 会让开场镜提前出现高潮画面 (用户 2026-10-09 报过的 bug)。
 *
 * 跟 agents/tools/extract-tools.ts:172 的禁含清单同源, 另补了几个常见变体。
 */
const PLOT_STATE_PATTERNS: RegExp[] = [
  /plot_state/i,
  /反转|狂笑|按下按钮|按动按钮|后期突变|诡异|死亡|灵宠|血契/,
  /咧嘴|狞笑|瞳孔放光|眼睛放光|复活|变异|暴走|发狂/,
  /掏出|举起刀|挥舞|扑向|撕咬|倒地|吐血|流血/,
]

/** 判断一段文本是否含 plot_state 污染 */
export function hasPlotStatePollution(text: string | null | undefined): boolean {
  if (!text) return false
  return PLOT_STATE_PATTERNS.some((re) => re.test(text))
}

/**
 * 把 characters.appearance_permanent 解析成「只含永久外貌」的短语列表。
 *
 * appearance_permanent 的实际格式 (agents/tools/extract-tools.ts:225-231 拼装):
 *   "age: 76岁左右 | face: 面部皱纹明显 | hair: 花白头发 | body: 佝偻瘦弱身形 | outfit: 深色棉袄"
 *   尾部可能跟 " / [plot_state_fallback]: <剧情描述>" —— 这段必须去掉。
 *
 * 返回: ["面部皱纹明显", "花白头发", ...] (已去掉 category 前缀, 已剔除污染段)
 */
export function parseAppearanceTraits(appearancePermanent: string | null | undefined): string[] {
  const raw = (appearancePermanent || '').trim()
  if (!raw) return []

  const traits: string[] = []
  // appearance_permanent 的分隔符有两种 (agents/tools/extract-tools.ts:225-231 的拼装格式):
  //   " | "  → 维度之间 / 服装项之间
  //   " / "  → 维度组之间 + 尾部 [plot_state_fallback]
  // 两种都要切开, 否则 "age: 30岁 / [plot_state_fallback]: xxx" 会被整段当成污染丢掉,
  // 把合法的 age 一起丢了。
  const parts = raw.split('|').flatMap((p) => p.split(/\s+\/\s+/))
  for (const part of parts) {
    const seg = part.trim()
    if (!seg) continue
    // [plot_state_fallback] 整段丢掉
    if (/plot_state/i.test(seg)) continue
    // 去掉 "age: " / "face: " 这种 category 前缀
    const withoutCat = seg.replace(/^[a-zA-Z_]+\s*[:：]\s*/, '').trim()
    if (!withoutCat) continue
    // 污染段整条丢掉 (宁可少注入, 也不能把剧情态塞进 video_prompt)
    if (hasPlotStatePollution(withoutCat)) continue
    traits.push(withoutCat.replace(/[、，,;；]\s*$/, '').trim())
  }
  return traits.filter(Boolean)
}

/**
 * 拼一个角色的外貌短语 —— PM 指定的格式:
 *   王秀兰(面部皱纹明显,眼窝深陷,花白头发,佝偻瘦弱身形,深色棉袄,性格: 克制)
 *
 * @param appearancePermanent characters.appearance_permanent
 * @param personality         characters.personality (老路径「气质」维, V3 治本后 personality 字段没进 video_prompt, 本单补上)
 * @param role                characters.role (外貌全空时的最后兜底)
 */
export function formatCharacterAppearance(
  appearancePermanent: string | null | undefined,
  personality?: string | null,
  role?: string | null,
): string {
  const traits = parseAppearanceTraits(appearancePermanent)
  const parts: string[] = [...traits]
  const p = (personality || '').trim()
  if (p && !hasPlotStatePollution(p)) parts.push(`性格:${p}`)
  if (parts.length === 0) {
    const r = (role || '').trim()
    return r ? `角色:${r}` : ''
  }
  return parts.join(',')
}

/** 拼整镜的角色外观 block —— 注入 video_prompt 的【描述段】 */
export function buildAppearanceBlock(
  entries: Array<{ name: string; appearance: string; personality?: string | null; role?: string | null }>,
): string {
  const lines: string[] = []
  for (const e of entries) {
    const appearance = formatCharacterAppearance(e.appearance, e.personality, e.role)
    if (!appearance) continue
    lines.push(`${e.name}(${appearance})`)
  }
  if (lines.length === 0) return ''
  // 用 "——" 而不是 ":" —— 翻译器的 system prompt 里有一条 "strip speaker name prefix (X: before the line)"
  //   的规则, 标签后面用冒号有被当成"角色名:台词"前缀误删的风险, 破折号没这个歧义。
  return `角色外观(跨镜头保持一致) —— ${lines.join('; ')}`
}

// ─── Task B: 承接上一镜 ──────────────────────────────────────────────────────

/**
 * 承接上一镜的收尾状态 (老路径 四.3: 本镜的 result 会成为下一镜的隐含起点)。
 *
 * ⚠️ 上一镜的 result 本身可能含 plot_state 污染 —— 用跟 Task A 同样的清洗策略。
 */
export function buildContinuityBlock(previousResult: string | null | undefined): string {
  const raw = (previousResult || '').trim()
  if (!raw) return ''
  if (hasPlotStatePollution(raw)) return ''
  return `承接上一镜: 从「${raw}」的收尾状态起幅, 人物位置/视线/道具状态保持连续`
}

/** 生成期注入用的英文首帧锚点 (老路径原文, 不能被翻译器改写 → 翻译后注入) */
/**
 * 本镜收尾状态 (老路径 七 "末帧收尾: 本镜末尾明确 result 字段, 告诉模型动作在哪里收住")。
 *
 * 跟 buildContinuityBlock 是一对: 本镜的 result 既是本镜的收尾, 也是下一镜的起点。
 */
export function buildResultBlock(result: string | null | undefined): string {
  const raw = (result || '').trim()
  if (!raw) return ''
  if (hasPlotStatePollution(raw)) return ''
  return `本镜收尾: 动作收在「${raw}」`
}

export const OPENING_FRAME_ANCHOR =
  'opening frame matches [Picture 1]; continues from previous shot\'s tail composition'

// ─── Task F①: 道具时序 ───────────────────────────────────────────────────────

/**
 * 常见「情节道具」词表 —— 用于检查道具是否在【场景还没提到它】的镜头里提前出现。
 *
 * ⚠️ 词表不全, 只做 warn 不做拦截 (PM Task F 明确要求)。
 * 词表刻意保守: 只收「剧情里需要被显式提到才合理」的东西 (按钮/刀/信/照片…),
 * 不收桌椅门窗这类场景基础元素 (它们本来就该每个场景都在)。
 */
export const PROP_LEXICON: string[] = [
  '按钮', '遥控器', '钥匙', '门禁卡', '密码', '手机', '电话', '手机屏',
  '刀', '剑', '枪', '绳子', '绳索', '剪刀', '针', '药', '药瓶', '针剂', '创可贴', '纱布',
  '照片', '相片', '合影', '信', '信封', '遗嘱', '合同', '文件', '本子', '笔记本', '日记', '账单',
  '镜子', '梳子', '口红', '戒指', '项链', '耳环', '手链', '手表', '钱包',
  '杯子', '茶杯', '咖啡杯', '碗', '筷子', '叉子', '刀叉', '酒瓶', '啤酒', '牛奶', '汤碗',
  '盒子', '礼盒', '箱子', '行李箱', '背包', '包', '袋子', '手提袋',
  '伞', '手电筒', '打火机', '蜡烛', '灯', '台灯', '闹钟', '钟表', '挂钟',
  '花', '花束', '玫瑰', '项链', '狗', '猫', '鸟', '宠物',
  '车', '汽车', '摩托车', '自行车', '火车', '飞机', '船',
  '玩具', '积木', '气球', '蛋糕', '酒', '棋子', '扑克', '照片墙',
]

/**
 * 在文本里找「出现了但不该在这时候出现」的道具。
 *
 * @param text              本镜的 description / image_prompt / video_prompt
 * @param sceneDescription  所属 scene 的 description (道具在这里被提到才算合法)
 * @param earlierTexts      同场景【前面】镜头已经出现过的文本 (前面引入过的道具后续镜头可以继续用)
 * @returns 命中的道具词
 */
export function findLeakedProps(
  text: string | null | undefined,
  sceneDescription: string | null | undefined,
  earlierTexts: Array<string | null | undefined> = [],
): string[] {
  const hay = (text || '')
  if (!hay) return []
  const legal = `${sceneDescription || ''}\n${earlierTexts.join('\n')}`
  const hits: string[] = []
  for (const prop of PROP_LEXICON) {
    if (!hay.includes(prop)) continue
    if (legal.includes(prop)) continue
    hits.push(prop)
  }
  return hits
}

// ─── 通用: 往 H3 三段式 prompt 的【描述段】插文本 ────────────────────────────

/**
 * 往 H3 三段式 prompt 的描述段末尾插一段文本。
 *
 * ⚠️ 不能 append 到 prompt 末尾 —— 末尾是 Non-diegetic music 段, 东西掉进去 H3 会理解错
 *   (Sprint 15 调研踩过的坑, dialogue-timeline.ts:263 insertIntoIntegrated 同理)。
 *
 * 为什么不复用 dialogue-timeline.ts 里的 insertIntoIntegrated:
 *   PM msg-20261021-076 scope.do_not_touch 明确写了「utils/dialogue-timeline.ts 本单不改」。
 *   这里复制一份同语义的实现, 等价但不耦合。
 */
export function insertIntoIntegratedSection(prompt: string, text: string): string {
  const block = (text || '').trim()
  if (!block) return prompt
  const headerRe = /^[ \t]*(?:overall[\s_-]+soundscape|non[\s_-]+diegetic[\s_-]+music)[\s_-]*:/im
  const m = headerRe.exec(prompt)
  if (m && m.index != null) {
    const head = prompt.slice(0, m.index).trimEnd()
    const tail = prompt.slice(m.index)
    return `${head}\n\n${block}\n\n${tail}`
  }
  return `${prompt.trimEnd()}\n\n${block}`
}

/** H3 三段式的第一段 header —— V4 planner 拼的 video_prompt 缺这一段 (老路径是 LLM 自己写的) */
export const INTEGRATED_HEADER = 'Integrated multimodal description:'

/**
 * 确保 prompt 顶部有 "Integrated multimodal description:" header。
 *
 * V4 planner 的 video_prompt = permanent + description + plot_state 三段拼,
 * 只有 ensureH3ThreePartPrompt 补的后两段 header, 第一段没有 (老路径 LLM 自己会写)。
 * 补上以后 H3 三段式结构完整, 翻译器也能认得 (它的 system prompt 明确要求保留这三个 header),
 * 顺便给生成期的首帧锚点一个稳定的插入位置。
 */
export function ensureIntegratedHeader(prompt: string): string {
  const p = (prompt || '').trim()
  if (!p) return p
  if (/^\s*integrated[\s_-]+multimodal[\s_-]+description\s*:/i.test(p)) return p
  return `${INTEGRATED_HEADER}\n${p}`
}

/** 往【描述段的开头】插一段文本 (首帧锚点用) */
export function insertAtIntegratedStart(prompt: string, text: string): string {
  const block = (text || '').trim()
  if (!block) return prompt
  const headerRe = /^([ \t]*integrated[\s_-]+multimodal[\s_-]+description[ \t]*:[ \t]*\n?)/im
  const m = headerRe.exec(prompt)
  if (m && m.index != null) {
    const head = prompt.slice(0, m.index + m[0].length)
    const tail = prompt.slice(m.index + m[0].length).trimStart()
    return `${head}${block}\n${tail}`.trimEnd()
  }
  return `${block}\n${prompt.trimStart()}`
}

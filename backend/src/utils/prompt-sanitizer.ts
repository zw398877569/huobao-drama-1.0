/**
 * 图片生成 prompt 无害化改写器
 *
 * 背景: 上游图像生成 API(Agnes 等)对中文 prompt 里的"中毒/受伤/武器/血腥/师徒暧昧/濒死"
 * 等关键词非常敏感,经常误杀为 content_policy_violation。单纯加一个静态 safety suffix
 * 只能压下来一部分 case,真正的解法是在出栈前对 prompt 做一次"视觉化改写"。
 *
 * 策略:
 *   1. 优先调用文本 LLM,把 prompt 改写成中性视觉画面
 *   2. LLM 调用失败/超时时,fallback 到本地关键词替换
 *   3. 最后统一追加 DEFAULT_IMAGE_SAFETY_SUFFIX,做一次正向艺术化框架
 *   4. suffix 重复追加检测,避免越拼越长
 *
 * 整个函数永不抛出,任何异常都会被吞掉并降级到下一档,确保生图流程不被打断。
 */
import { getActiveConfig, getTextChatCompletionsUrl } from '../services/ai.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { logTaskError, logTaskProgress, logTaskWarn } from './task-logger.js'
import { DEFAULT_IMAGE_SAFETY_SUFFIX } from '../services/image-generation.js'
import { stripReasoningBlocks, hasNonEnglishChars } from '../services/ai.js'

// 2026-10-17 Sprint 045 QA msg-20261017-069: 8s → 30s
//   修前: LLM_TIMEOUT_MS = 8_000, MiniMax 官方 API (id=18, M3 / M3.1-Flash-Preview)
//         每次都精确 8.0s 超时 → llm-rewrite-throw ×2 → fallback-to-local,
//         中文 prompt 改写失效, step 5/6/7/9/10 全部降级用英文本地 prompt (视觉一致性受损)。
//   证据 (flow-log 2026-10-17 trace e602cf37):
//         05:08:37.214 llm-rewrite-start (inputLen 1995)
//         05:08:45.255 llm-rewrite-throw attempt=1  ← 8.041s, 正好是旧 timeout
//         05:08:45.285 llm-rewrite-retry (delay 8590ms)
//         05:09:01.904 llm-rewrite-throw attempt=2  ← 又 8s
//         05:09:01.926 sanitizer-llm-failed-twice → fallback-to-local
//   对照组: 同日 id=17 (chatfire) 401 只花 1.9s (05:03:12.157 → 05:03:14.104)
//         → 网络和端点都通, 纯粹是 8s 砍掉了推理模型的思考时间。
//   排查过但排除的其他候选 (QA 工单列的 A/C/D/E):
//         A endpoint 路径: getTextChatCompletionsUrl 拼 api.minimaxi.com/v1/chat/completions,
//           OpenAI 兼容路径正确, 请求正常发出 (不是 4xx);
//         C inputLen 太大: 1995 字符远未达限制;
//         D 网速慢: 401 对照组只要 1.9s;
//         E 模型不兼容: 请求能发出说明协议兼容, 只是响应慢于 8s。
//   取值: 用户 2026-10-17 拍板"改大点无所谓, 宁可等满也不要提前 fallback 降级"。
//     sanitizer 失败 → fallback-to-local 用英文本地 prompt, 会让 step 5/6/7/9/10 全部视觉降级,
//     这个代价远大于多等一会儿, 所以 timeout 给得宽松。
//   最坏总耗时: 180s (attempt1) + ~10s (retry delay 5-10s 随机) + 180s (attempt2) = 370s ≈ 6.2min。
//     这个上限只在 LLM 彻底不可用时才会走到 (正常 M3 实测 8-16s, attempt1 就成功);
//     走到最坏情况时也等价于"等了 6 分钟才 fallback", 但用户宁可等也不要视觉降级。
//   无副作用: sanitizeImagePrompt 是 async 且不持有任何锁/连接, 每个调用独立,
//     并发多路 (批量生成角色图) 互不影响, 只是各自最多等 180s。
const LLM_TIMEOUT_MS = 180_000

// 本地兜底:命中规则 → 中性视觉表达
const FALLBACK_REPLACEMENTS = [
  [/因[^,。.;；]{1,12}而滚烫如炭/g, '面部泛着柔和的红润光晕'],
  [/毒气攻心[^,。.;；]*[,。.;；]?/g, '面部泛着柔和的红润光晕,'],
  [/滚烫如炭/g, '红润光晕'],
  [/中毒/g, '体力透支'],
  [/濒死/g, '虚弱'],
  [/奄奄一息/g, '安静地闭目休息'],
  [/昏迷不醒/g, '安静地闭目养神'],
  [/呼吸轻如羽毛/g, '呼吸轻柔'],
  [/身体虚弱/g, '姿态柔弱'],
  [/刀光剑影/g, '光影交错'],
  [/血肉模糊/g, '画面朦胧'],
  [/鲜血[^,。.;；]{0,6}/g, '红色光晕'],
  [/伤口[^,。.;；]{0,6}/g, '痕迹'],
  [/中刀[^,。.;；]{0,6}/g, '身形微颤'],
  [/肌肤之亲/g, '近景特写'],
  [/师徒暧昧/g, '角色互动'],
  [/衣衫不整/g, '衣摆微动'],
  [/自尽/g, '凝望远方的神情'],
  [/身亡/g, '静立'],
  [/尸体/g, '静坐的身影'],
  [/白骨/g, '远山轮廓'],
  // 新增:更多武器类(全部映射到"光柱"或"道具")
  [/匕首/g, '道具'],
  [/短刀/g, '道具'],
  [/长枪/g, '道具'],
  [/大刀/g, '道具'],
  [/弯刀/g, '道具'],
  [/双刀/g, '道具'],
  [/弩弓|弓箭|长弓/g, '道具'],
  [/暗器/g, '小物件'],
  [/飞镖/g, '小物件'],
  [/枪口|枪管|枪身/g, '光影'],
  [/子弹|弹丸|弹头/g, '光点'],
  [/刀刃|刀尖|刀柄/g, '道具'],
  [/剑柄|剑格|剑锷/g, '道具'],
  [/斧钺|战斧|巨斧/g, '道具'],
  [/长矛|戟|戈|镗/g, '道具'],
  [/鞭|软鞭|铁鞭/g, '绳索'],
  [/锤|战锤|铁锤/g, '重物'],
  [/杖|法杖|权杖/g, '手杖'],
  // 新增:更多暴力/攻击动词
  [/劈砍|砍杀|猛砍/g, '挥动'],
  [/刺穿|捅入|扎入/g, '触碰'],
  [/斩断|劈碎|击碎/g, '断裂'],
  [/撕裂|撕碎|扯裂/g, '散开'],
  [/粉碎|崩碎|震碎/g, '碎裂'],
  [/轰击|重击|猛击/g, '冲击'],
  [/殴打|狠揍|狂殴/g, '推搡'],
  [/碾压|践踏|踩踏/g, '经过'],
  [/灼烧|焚烧|炙烤/g, '受热'],
  [/腐蚀|侵蚀|溶化/g, '消退'],
  [/吞噬|吞没|吸入/g, '笼罩'],
  [/绞杀|勒毙|闷杀/g, '束缚'],
  [/刺杀|暗杀|狙杀/g, '靠近'],
  [/屠戮|屠杀|剿灭/g, '离去'],
  // 新增:更多血液/伤口相关
  [/喷涌|涌出|迸溅/g, '泛起'],
  [/流淌|滴落|渗出/g, '湿润'],
  [/汩汩|潺潺|淅沥/g, '流动'],
  [/伤口裂开|伤口绽开/g, '痕迹显现'],
  [/皮开肉绽|骨肉分离/g, '伤痕累累'],
  [/断肢|残臂|断腿|断脚/g, '残缺'],
  [/内脏|脏腑|五腑六脏/g, '体内'],
  [/脑浆|颅骨碎裂/g, '头部受伤'],
  [/脊椎|脊髓|脊柱断裂/g, '背部受伤'],
  [/心脏破裂|心肺俱碎/g, '胸口重伤'],
  [/大动脉|血管爆裂|血脉喷张/g, '血脉贲张'],
  [/血雾|血雨|血潮|血浪/g, '红色雾气'],
  [/血花绽放|血花飞溅|血花四溅/g, '红色光点'],
  // 新增:更多死亡/消失相关
  [/陨落|灰飞烟灭|魂飞魄散/g, '消散'],
  [/化作飞灰|化为尘土|化为乌有/g, '消失不见'],
  [/烟消云散|随风而去|随风飘散/g, '远去'],
  [/香消玉殒|红颜薄命/g, '悄然离去'],
  [/一命呜呼|呜呼哀哉|撒手人寰/g, '离开人世'],
  [/寿终正寝|驾鹤西去|羽化登仙/g, '安然离世'],
  [/横死|惨死|暴毙|猝死/g, '意外离世'],
  [/自刎|自缢|自焚|投河|跳崖/g, '做出决绝举动'],
  [/殉情|殉葬|陪葬/g, '追随而去'],
  [/尸骨无存|化为飞灰|灰飞烟灭/g, '彻底消散'],
  // 新增:更多燃烧/火焰相关
  [/烈焰|烈火|熊熊大火|冲天火光/g, '强烈的光效'],
  [/火海|火墙|火浪|火龙/g, '大片光效'],
  [/火光|焰光|烈焰光芒/g, '温暖的光效'],
  [/灼热|炽热|高温|滚滚热浪/g, '强烈的热感'],
  [/黑烟|浓烟|滚滚黑烟|乌烟瘴气/g, '烟雾'],
  [/灰烬|余烬|焦痕|焦黑|碳化/g, '痕迹'],
  [/爆炸|炸裂|轰然巨响|震耳欲聋/g, '强烈冲击波'],
  [/炸弹|手雷|地雷|火箭|导弹|炮火|炮击|轰炸/g, '远程攻击'],
  [/火光冲天|烈焰腾空|烈焰升腾/g, '光效强烈'],
  // 新增:更多情绪/氛围敏感词
  [/绝望|崩溃|疯狂|癫狂|嗜血|暴怒|狂怒|愤怒/g, '情绪激烈'],
  [/恐惧|惊恐|战栗|颤栗|毛骨悚然|不寒而栗/g, '紧张'],
  [/阴森|诡异|恐怖|惊悚|骇人|毛骨悚然/g, '氛围凝重'],
  [/狰狞|扭曲|扭曲变形|面目狰狞|青面獠牙/g, '表情扭曲'],
  [/鬼魅|幽灵|厉鬼|冤魂|孤魂野鬼/g, '神秘身影'],
  [/妖魔|妖邪|魔物|邪祟|鬼怪|妖精/g, '神秘角色'],
  [/诅咒|咒语|封印|禁术|邪术|降头/g, '神秘力量'],
  [/炼狱|地狱|十八层地狱|无间地狱|九幽之地/g, '阴森环境'],
  [/尸山血海|血流成河|千里无鸡鸣/g, '惨烈战场'],
  [/万箭齐发|箭雨|漫天箭矢|万箭穿心/g, '密集投射物'],
  [/千军万马|铁骑|百万雄师|千军万马|千军万马踏破/g, '大军压境'],
  [/血洗|屠城|灭门|满门抄斩|株连九族/g, '大规模冲突'],
  // 复合短语(必须先匹配,否则单词规则会破坏语义) ===
  [/残阳如血/g, '暮色斜阳'],
  [/残阳如丹/g, '暮色斜阳'],
  [/血色夕阳/g, '暮色夕阳'],
  [/染成血色/g, '染成深红'],
  [/杀机四伏/g, '氛围凝重'],
  [/肃杀压抑/g, '氛围凝重'],
  [/氛围肃杀/g, '氛围凝重'],
  [/正邪对峙/g, '人物对峙'],
  [/武林高手/g, '人物'],
  [/刀光剑影/g, '光影交错'],
  [/血肉模糊/g, '画面朦胧'],
  // === 武器类(全部映射到"光柱",直接抹掉武器语义) ===
  [/剑身/g, '光柱'],
  [/剑刃/g, '光柱'],
  [/长剑/g, '光柱'],
  [/短剑/g, '光柱'],
  [/刀锋/g, '光柱'],
  [/刀光/g, '光柱'],
  [/剑光/g, '光柱'],
  [/兵器/g, '道具'],
  [/武功/g, '动作'],
  // === 高敏单词(逐个替换) ===
  [/高手/g, '人物'],
  [/对决/g, '对视'],
  [/杀气/g, '气场'],
  [/搏杀|拼杀|厮杀/g, '对峙'],
  [/比武|过招/g, '对视'],
  [/残阳/g, '暮色'],
  [/血色/g, '绯红'],
  [/杀机/g, '氛围'],
  [/邪气/g, '冷峻'],
  [/邪派/g, '人物'],
  [/萧杀/g, '沉郁'],
  [/肃杀/g, '沉郁'],
  [/残忍/g, '冷峻'],
  [/凄厉/g, '苍凉'],
  [/哀嚎/g, '低吟'],
  [/残月/g, '月色'],
  [/死寂/g, '静谧'],
  // === 燃烧类 ===
  [/燃烧的[一-龥]/g, '柔和的'],
  [/燃烧/g, '浮起'],
  [/燃起/g, '浮起'],
  [/致命一击/g, '蓄势一击'],
  // === 最后做宽泛的视觉词收敛 ===
  [/剑影/g, '光影'],
]

const SUFFIX_MARKERS = ['cinematic still', 'artistic composition', 'dramatic tension']

function hasSafetySuffix(prompt) {
  return SUFFIX_MARKERS.every(marker => prompt.includes(marker))
}

function applySafetySuffix(prompt) {
  const trimmed = prompt.replace(/[,\s]+$/, '')
  if (hasSafetySuffix(trimmed)) return trimmed
  return trimmed + DEFAULT_IMAGE_SAFETY_SUFFIX
}

function sanitizeImagePromptLocal(rawPrompt) {
  let out = rawPrompt
  for (const [pattern, replacement] of FALLBACK_REPLACEMENTS) {
    out = out.replace(pattern, replacement)
  }
  out = out.replace(/[,]{2,}/g, ', ').replace(/\s{2,}/g, ' ')
  return out.trim()
}

/**
 * 生图 prompt 的用途类型 —— Sprint 21 (QA msg-20261025-085)
 *
 * 为什么需要: sanitizer 原来对【所有】生图 prompt 一视同仁 ——
 *   ① SYSTEM_INSTRUCTION 规则 E 无差别让 LLM 追加 'cinematic still, dramatic tension, artistic composition'
 *   ② 规则 F 卡 240 字符 → 长模板被压缩, 短描述被【扩写】凑数
 *   结果: 场景图被编出人物 (LLM 把场景陈设"冒热气的面碗"翻成 'steaming noodles',
 *   生图模型读成"有人在吃面"), 角色设定稿的背景约束被挤掉 → 模型自由发挥成户外院子。
 *
 * 按 kind 分支之后, LLM 知道自己在写什么类型的画面, 约束也能落到正确的语义上。
 */
export type ImagePromptKind = 'character' | 'scene' | 'prop' | 'shot' | 'grid'

/**
 * 各 kind 的 LLM 分支规则 (拼在 SYSTEM_INSTRUCTION 末尾)。
 *
 * ⚠️ prop / shot / grid 暂不加规则 —— QA msg-20261025-085 fix_3 说"先调查不要直接改",
 *   等 dev 给影响面结论再决定是否升级为单。character / scene 是 fix_1 / fix_2 的 P0/P1 范围。
 */
const KIND_INSTRUCTIONS: Record<ImagePromptKind, string[]> = {
  scene: [
    'H. 这是一条【纯场景/环境】描述: 输出里【绝对不能出现人物、角色、人影、剪影、面孔、手脚、身体部位】.',
    '   只描述空间结构/光线/材质/陈设. 陈设用【静物】措辞 (例: a bowl of noodles on the old wooden table),',
    '   不要用暗示"有人正在使用/正在吃/刚坐过"的措辞 (热气腾腾刚出锅、吃了一半、椅子被拉开 等) ——',
    '   生图模型会把这些读成"画面里有人". 也不要为了凑字数编造人物活动.',
  ],
  character: [
    'H. 这是一条【角色设定稿】描述: 背景必须是【中性纯色/渐变影棚背景】,',
    '   不得出现任何环境元素 (房间/街道/院子/灯笼/盆栽/家具/窗景).',
    '   元素优先级: 角色本人外貌/年龄/体态/服装 > 中性背景 > 版式说明;',
    '   长度不够时先砍版式说明, 背景约束和角色外貌不能砍.',
  ],
  prop: [],
  shot: [],
  grid: [],
}

/**
 * 各 kind 在【LLM 之后】追加的硬约束 (不会被 LLM 洗掉)。
 *
 * ⚠️ prop / shot / grid 暂不加 —— 同上, fix_3 先调查。
 */
const KIND_CONSTRAINTS: Record<ImagePromptKind, string> = {
  scene: ', empty environment, no people, no characters, no human figures, no silhouettes, no human body parts, no one sitting or standing, architecture and furnishings only, no human activity',
  character: ', plain neutral seamless studio backdrop, even soft lighting, no environment, no room, no street, no outdoor scenery, no furniture in background, character sheet presentation',
  prop: '',
  shot: '',
  grid: '',
}

/** 追加 kind 硬约束 (幂等 —— 已有就不重复追加) */
export function applyKindConstraint(prompt: string, kind: ImagePromptKind): string {
  const constraint = KIND_CONSTRAINTS[kind]
  if (!constraint) return prompt
  const trimmed = String(prompt || '').replace(/[,\s]+$/, '')
  // 幂等判据 (Sprint 21 follow-up, QA msg-20261025-087): 用【完整约束串】判重。
  //
  // ⚠️ 修前用的是 constraint.split(',')[1] (第一个内容短语):
  //   scene     → 'empty environment'
  //   character → 'plain neutral seamless studio backdrop'
  //   这两个都是 LLM 很可能自己写出来的词 —— 一旦命中, 整条硬约束被误判成"已加过"而跳过,
  //   丢掉的正好是 fix_1/fix_2 的核心 (no people 全家桶 / no street / no outdoor scenery /
  //   no furniture in background / character sheet presentation) → fix_1/fix_2 静默失效,
  //   表现为"这次好了下次又跑偏", 不报错不 fallback, 极难查。
  //
  // 为什么不用"特征短语"判据 (QA 的 fix_A): 特征短语仍有可能被 LLM 写出来 → 还是同一类假跳过。
  //   重复几个词无害, 整条约束消失有害 → 宁可重复, 不能漏。
  //   (QA 的 fix_C = 完整串 + 特征短语两条一起上, 特征短语那半仍留着假跳过风险, 故未采用)
  if (trimmed.includes(constraint.trim())) return trimmed
  return trimmed + constraint
}

const SYSTEM_INSTRUCTION_BASE = [
  '你是一名视觉概念设计师,任务是把"可能触发图像生成 API 内容审核"的描述',
  '改写成"中性、电影感、更容易被图像 API 接受"的视觉画面。',
  '',
  '硬性改写规则(必须严格遵守):',
  'A. 直接抹掉所有"武侠/打斗/武器"语义:剑、剑身、剑刃、刀、长剑、刀锋、剑光、刀光、兵器、武林、',
  '   杀气、杀气腾腾、比武、过招、对决、搏斗、残阳如丹 等必须替换或删除。',
  '   剑 → 光柱/光影;刀光剑影 → 光影交错;高手 → 人物;对决 → 静立对视;',
  '   残阳如丹 → 暮色斜阳。',
  'B. 燃烧/燃烧的XX / 燃起 / 火焰 → 浮起的光晕 / 温暖的光晕 / 柔和的光晕。',
  'C. 血色 / 鲜血 / 血红 / 染血 → 深红 / 绯红。',
  'D. 中毒 / 受伤 / 武器 / 血腥 / 死亡 / 师徒暧昧 / 昏迷 / 濒死 / 窒息 / 自尽 全部要中性化,',
  '   例如:昏迷不醒→安静地闭目养神;毒气攻心、肤色滚烫→面部泛着柔和的红润光晕;刀光剑影→光影交错。',
  'E. 末尾追加 ", cinematic still, dramatic tension, artistic composition"。',
  'F. Output IN ENGLISH, comma-separated short phrases, max 240 chars.',
  'G. Do NOT output explanations, prefixes, quotes, or markdown code blocks. Do NOT output <think> thinking blocks. Output only the rewritten prompt string.',
  // 2026-09-25 PM msg-20260924-006 (Q5 task_A): 加显式指令, 防 MiniMax-M3 中转站禁不掉 thinking block 时输出空
  'IMPORTANT: Output ONLY the rewritten prompt string. NO thinking, NO explanation, NO analysis. Even if thinking block is forced, the FINAL ANSWER must be a complete rewritten prompt.',
]

/** 按 kind 拼 system prompt —— 基础安全规则 + 该 kind 的语义分支规则 */
function buildSystemInstruction(kind: ImagePromptKind): string {
  const extra = KIND_INSTRUCTIONS[kind] || []
  return [...SYSTEM_INSTRUCTION_BASE, ...extra].join('\n')
}

function extractPromptFromLLM(raw) {
  if (!raw) return null
  let text = raw.trim()

  // 1) 剥掉推理模型的思考块 — 复用 ai.ts 公共 stripReasoningBlocks,
  //    跟 translateImagePromptToEnglish / translateVideoPromptToEnglish 同源 (避免一处防护一处漏)
  text = stripReasoningBlocks(text)

  // 2) 剥掉 markdown 代码块包裹
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')

  // 3) 挑"最长且主要含中文"的段落(去掉英文思考/元评论行)
  const paragraphs = text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => {
      // 必须至少含 8 个中文字符,且中文占比 >= 30%
      const cn = (p.match(/[一-龥]/g) || []).length
      if (cn < 8) return false
      return cn / p.length >= 0.3
    })
  if (paragraphs.length === 0) {
    // 模型没有输出中文段落(可能是只分析了英文/只给了思考过程), 退回所有段落拼接兜底
    const all = text.split(/\n+/).map(p => p.trim()).filter(Boolean).join('，')
    return all || null
  }
  // 取最长那段(模型真正给出的改写通常是最长的中文段)
  text = paragraphs.reduce((a, b) => b.length > a.length ? b : a, '')

  // 4) 剥常见前缀和引号
  text = text.replace(/^(改写后的?\s*prompt\s*[:：]\s*|prompt\s*[:：]\s*|output\s*[:：]\s*|final\s*answer\s*[:：]\s*)/i, '')
  text = text.replace(/^["「『]+|["」』]+$/g, '')

  // 5) 必须含中文,否则说明模型只输出了免责声明/英文思考
  if (!/[一-龥]/.test(text)) return null
  if (text.length > 600) text = text.slice(0, 600)
  return text.trim()
}

/**
 * 英文版 LLM 输出提取器 — 跟 extractPromptFromLLM 配套, 用于 rawPrompt 是英文的场景。
 *
 * 为什么需要拆版本:
 *   - SYSTEM_INSTRUCTION F 现在要求 sanitize LLM 输出英文 (commit 199f04e 改的)
 *   - 旧 extractPromptFromLLM 步骤 3/5 是中文专用过滤, 处理英文 LLM 输出会因「找不到中文字符」
 *     直接返回 null → sanitizeImagePromptLLM fallback null → 走本地正则路径
 *   - 本地正则 FALLBACK_REPLACEMENTS 全是中文模式 (剑/刀/燃烧...), 对英文敏感词(blood/weapon/fire)
 *     改不掉 → 上游 API 可能 content_policy_violation
 *   - 拆英文版后, 英文 prompt 能真正用上 LLM 智能改写; 中文版保留给未来扩展 (万一 F 改回输出中文)
 *
 * 行为差异 (相对中文版):
 *   - 去掉「≥8 中文字符 + 占比 ≥30%」过滤 (英文 LLM 输出没有中文字符)
 *   - 去掉「!/[一-龥]/.test(text) 必须含中文」检查
 *   - 元评论前缀识别按英文 pattern (Note/Output/Prompt/Here/Final/Rewritten 等)
 *   - 引号剥离改英文双引号 (中文版覆盖了「」『』, 英文版只覆盖 "")
 */
function extractPromptFromLLMEnglish(raw: string) {
  if (!raw) return null
  let text = stripReasoningBlocks(raw.trim())

  // 剥掉 markdown 代码块包裹 (跟中文版一致)
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')

  // 英文版：挑最长非元评论段落
  // 启发式：英文 LLM 偶尔会输出 "Note: ..." / "Output: ..." / "Here's the rewritten prompt:"
  // 这类元评论行, 长度短且有特殊前缀, 用 pattern 过滤掉
  const paragraphs = text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) return null

  const META_COMMENT_PREFIX = /^(Note|Output|Result|Prompt|Here|Translation|Final|Rewritten|Reworded)\s*[:：]/i
  const candidates = paragraphs.filter(p => !META_COMMENT_PREFIX.test(p))
  // 候选池: 有非元评论段落就用, 否则兜底用所有段落 (模型可能整段都是元评论)
  const pool = candidates.length > 0 ? candidates : paragraphs
  // 取最长那段
  text = pool.reduce((a, b) => b.length > a.length ? b : a, '')

  // 剥常见前缀 (英文版不复用中文版的「改写后的」/「final answer」等中文 pattern, 用英文版等价物)
  text = text.replace(/^(rewritten\s+prompt\s*[:：]\s*|prompt\s*[:：]\s*|output\s*[:：]\s*|final\s+answer\s*[:：]\s*)/i, '')
  // 剥首尾双引号 (英文版只覆盖 ", 中文版覆盖了「」『』中文引号)
  text = text.replace(/^["]+|["]+$/g, '')

  // 英文 token 密度低, 长度上限从 600 字提到 800 (200 字 ≈ 100-130 英文 token)
  if (text.length > 800) text = text.slice(0, 800)
  return text.trim()
}

// 检测 LLM 改写后是否仍有 agnes 容易拒掉的关键词
function containsResidualPolicyRisk(text) {
  // 武器/武侠 + 暴力/燃烧类,任一命中即认为有残留风险
  return /(?:杀气|血色|尸体|鲜血|搏杀|拼杀|厮杀|燃烧|燃起|残阳如血|残阳如丹|血色夕阳|杀机|邪气|萧杀|肃杀|比武|过招|剑身|剑刃|刀锋|长剑|短剑|刀光|剑光|兵器|武功|高手|对决|致命一击|残忍.{0,2}对待|凄厉|哀嚎|死亡.{0,2}威胁|白骨|死寂|残月|武林|匕首|长枪|大刀|弯刀|暗器|飞镖|枪口|子弹|刀刃|斧钺|长矛|战斧|火海|爆炸|炸弹|手雷|导弹|炮火|炮击|毁灭|屠戮|屠杀|剿灭|吞噬|绞杀|刺杀|暗杀|狙杀|血雾|血雨|血潮|血浪|血花|喷涌|涌出|迸溅|流淌|滴落|渗出|皮开肉绽|骨断筋折|心脏破裂|大动脉|万箭齐发|箭雨|漫天箭矢|血洗|屠城|灭门|绝望|崩溃|疯狂|癫狂|嗜血|暴怒|狂怒|愤怒|恐惧|惊恐|战栗|阴森|诡异|恐怖|惊悚|狰狞|扭曲|鬼魅|幽灵|厉鬼|妖魔|妖邪|魔物|邪祟|诅咒|咒语|封印|炼狱|地狱|尸山血海|血流成成河|千军万马|铁骑|陨落|灰飞烟灭|魂飞魄散|化作飞灰|香消玉殒|红颜薄命|一命呜呼|横死|惨死|暴毙|自刎|自缢|自焚|殉情|殉葬|陪葬|尸骨无存|断肢|残臂|内脏|脏腑|脑浆|颅骨|脊椎|脊髓|万箭穿心|焦痕|碳化|黑烟|浓烟|滚滚黑烟|灼热|炽热|高温|滚滚热浪|烈焰|烈火|冲天火光|火墙|火浪|火龙|火光|焰光|炸裂|轰然巨响|震耳欲聋|绝望|崩溃|疯狂|癫狂|嗜血|暴怒|狂怒|愤怒|恐惧|惊恐|战栗|阴森|诡异|恐怖|惊悚|狰狞|扭曲|鬼魅|幽灵|厉鬼|妖魔|妖邪|魔物|邪祟|诅咒|咒语|封印|炼狱|地狱|尸山血海|血流成河|千军万马|铁骑|陨落|灰飞烟灭|魂飞魄散|香消玉殒|红颜薄命|一命呜呼|横死|惨死|暴毙|自刎|自缢|自焚|殉情|殉葬|陪葬|尸骨无存|断肢|残臂|内脏|脏腑|脑浆|颅骨|脊椎|脊髓|万箭穿心|焦痕|碳化|黑烟|浓烟|灼热|炽热|高温|烈焰|烈火|冲天火光|火墙|火浪|火龙|火光|焰光|炸裂|轰然巨响|震耳欲聋|绝望|崩溃|疯狂|癫狂|嗜血|暴怒|狂怒|愤怒|恐惧|惊恐|战栗|阴森|诡异|恐怖|惊悚|狰狞|扭曲|鬼魅|幽灵|厉鬼|妖魔|妖邪|魔物|邪祟|诅咒|咒语|封印|炼狱|地狱|尸山血海|血流成河|千军万马|铁骑|陨落|灰飞烟灭|魂飞魄散|香消玉殒|红颜薄命|一命呜呼|横死|惨死|暴毙|自刎|自缢|自焚|殉情|殉葬|陪葬|尸骨无存|断肢|残臂|内脏|脏腑|脑浆|颅骨|脊椎|脊髓|万箭穿心|焦痕|碳化|黑烟|浓烟|灼热|炽热|高温|烈焰|烈火|冲天火光|火墙|火浪|火龙|火光|焰光|炸裂|轰然巨响|震耳欲聋)/.test(text)
}

// 2026-09-25 PM msg-20260924-006 (Q5) — sanitizeImagePromptLLM 重构:
//   - task_A: max_tokens 400 → 1500 (MiniMax-M3 thinking 占用, 400 不够)
//   - task_B: 优先用 'sanitizer' 专用配置 (deepseek-chat 不输出 thinking block), 没配才回退 'text'
//   - task_C: retry 1 次 + 失败 ≥2 次记 'sanitizer-llm-failed-twice' warn
//   - 2026-10-12 sprint 43 FIX-1: retry 之间加 5-10s 随机 sleep, 避免 M3 同步限速 (之前是立刻 retry 必失败)
//
// 重构成 attemptSanitizerLLM helper + 外层 retry loop — 避免原 try-catch 内部 return null 中断 retry
async function attemptSanitizerLLM(url: string, config: any, rawPrompt: string, configSource: string, attempt: number, systemPrompt?: string) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        // 2026-10-25 Sprint 20 (QA msg-20261025-083) fix_1: 3000 → 8192 (跟 services/ai.ts
        //   翻译链路 PROMPT_TRANSLATION_MAX_TOKENS 对齐)。
        //   实测 (llm-debug-resp.log, 同一个 endpoint 同一个 system prompt):
        //     2026-10-19T08:01:22  finish_reason=stop  completion=2439 reasoning=2383 content=252  ✅
        //     2026-10-19T08:02:52  finish_reason=stop  completion=2870 reasoning=2819 content=??  ✅
        //     2026-10-25T07:46:50  finish_reason=length completion=3000 reasoning=2999 content=0    ❌
        //     2026-10-25T07:47:28  finish_reason=length completion=3000 reasoning=2999 content=9569 (全是 <think>, 剥完仍空) ❌
        //   M3 的 thinking 常态 2400-3000 token, 3000 一点正文余量都没有 → content 恒空 → 一直 fallback-to-local。
        //   历史: 400 → 1500 (2026-09-25) → 3000 (2026-10-12 sprint 43) → 8192 (本次)
        max_tokens: 8192,
        messages: [
          { role: 'system', content: systemPrompt || buildSystemInstruction('shot') },
          { role: 'user', content: `原文 prompt:\n<<<${rawPrompt}>>>` },
        ],
        // MiniMax-M3 等推理模型默认输出 thinking 块, 禁用以避免污染改写结果
        extra_body: { reasoning: { enabled: false } },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      logTaskWarn('PromptSanitizer', 'llm-rewrite-http-error', {
        attempt,
        status: resp.status,
        body: errText.slice(0, 240),
      })
      return { outcome: 'hard-fail' }
    }
    const data = await resp.json()
    const choice0 = data?.choices?.[0] || {}
    const llmContent = choice0?.message?.content
    const reasoningContent = typeof choice0?.message?.reasoning_content === 'string'
      ? choice0.message.reasoning_content : ''
    const extractedRaw = typeof llmContent === 'string' ? llmContent : ''
    const rewritten = hasNonEnglishChars(rawPrompt)
      ? extractPromptFromLLM(extractedRaw)
      : extractPromptFromLLMEnglish(extractedRaw)
    if (!rewritten) {
      logTaskWarn('PromptSanitizer', 'llm-rewrite-empty', {
        attempt,
        configSource,
        provider: config.provider,
        // Sprint 20 fix_3: 把"为什么空"直接写进日志 —— 之前只有 rawPreview='' 看不出是被
        //   max_tokens 截断 (finish_reason=length) 还是真的空。
        //   这次定位靠的就是 llm-debug-resp.log 里的 usage/reasoning_tokens, flow log 里没有。
        finishReason: choice0?.finish_reason || '',
        hasReasoningContent: reasoningContent.length > 0,
        reasoningLen: reasoningContent.length,
        completionTokens: data?.usage?.completion_tokens ?? null,
        reasoningTokens: data?.usage?.reasoning_tokens ?? null,
        maxTokens: 8192,
        rawPreview: extractedRaw.slice(0, 400),
      })
      return { outcome: 'retryable-empty' }
    }
    logTaskProgress('PromptSanitizer', 'llm-rewrite-success', {
      attempt,
      configSource,
      provider: config.provider,
      inLen: rawPrompt.length,
      outLen: rewritten.length,
      rewritten,
    })
    const polished = sanitizeImagePromptLocal(rewritten)
    if (polished !== rewritten) {
      logTaskProgress('PromptSanitizer', 'llm-output-polished', {
        attempt,
        provider: config.provider,
        before: rewritten.slice(0, 60),
        after: polished.slice(0, 60),
      })
    }
    if (containsResidualPolicyRisk(polished)) {
      logTaskWarn('PromptSanitizer', 'llm-output-still-risky', {
        attempt,
        provider: config.provider,
        preview: polished.slice(0, 80),
      })
      return { outcome: 'retryable-empty' }
    }
    return { outcome: 'success', polished }
  } catch (err) {
    // 2026-09-28 QA msg-20260925-004 ISSUE-012 (P2): timeout 是 transient (网络/M3 服务端慢) 应 retry,
    //   只有真硬错 (auth / 4xx-5xx 持续失败) 才 hard-fail. 修前所有 throw 都吞成 hard-fail,
    //   inputLen > 1000 prompt 第一次 timeout 后立刻 fallback, retry 没触发.
    const e: any = err  // TS catch 默认 unknown, any 简化属性访问
    const isTimeout = e?.name === 'AbortError'
      || e?.message?.includes('aborted due to timeout')
      || e?.code === 'ABORT_ERR'
    logTaskWarn('PromptSanitizer', 'llm-rewrite-throw', {
      attempt,
      configSource,
      error: e?.message || String(err),
      errName: e?.name,
      isTimeout,
      // 2026-10-17 Sprint 045: 把 timeout 设定值和 inputLen 带进日志, 下次排查不用再猜是"模型慢"还是"配置小"
      timeoutMs: LLM_TIMEOUT_MS,
      inputLen: rawPrompt.length,
    })
    return { outcome: isTimeout ? 'retryable-empty' : 'hard-fail' }
  }
}

/**
 * Sprint 20 (QA msg-20261025-082) P0: 生图去敏的【请求级候选配置链】。
 *
 * 修前只有【配置级】回退 (没配 'sanitizer' 才用 'text'), 同一个配置失败就直接
 * fallback-to-local —— 跟翻译链路 (services/ai.ts resolvePromptLLMConfigCandidates,
 * sprint-16 f413db0 改的) 不一样, 那边快模型失败会自动换 text 配置。
 *
 * 事故 (drama 15 林达 characterId=44, 2026-10-25 id=286): sanitizer 配置 id=18 是
 * MiniMax-M3.1-Flash-Preview, inputLen≈2042 时 thinking 吃光预算返回空正文 →
 * empty×2 → fallback-to-local → 本地 prompt 原样带着 face-archive 的古风脸型词
 * (danfeng phoenix eyes / bean-paste shade / silver hairpin) → 画风从写实概念设计稿
 * 变成动画线稿设定稿。
 *
 * ⚠️ 向后兼容: 没配 sanitizer 配置的老环境, 候选链 = 只有 text, 行为跟修前一致。
 */
export function resolveSanitizerConfigCandidates(): Array<{ config: any; source: 'sanitizer' | 'text' }> {
  const out: Array<{ config: any; source: 'sanitizer' | 'text' }> = []
  // ⚠️ 这里【不用 silent】: 保留原来"没配 sanitizer 配置"的 warn 行为
  const fast = getActiveConfig('sanitizer')
  if (fast?.apiKey && fast?.model) out.push({ config: fast, source: 'sanitizer' })
  const text = getActiveConfig('text')
  if (text?.apiKey && text?.model) {
    // 同一个配置别放两遍 (sanitizer 和 text 可能配了同一个)
    if (!out.some(c => c.config.model === text.model && c.config.baseUrl === text.baseUrl)) {
      out.push({ config: text, source: 'text' })
    }
  }
  return out
}

export interface SanitizerCandidateFailure {
  source: string
  provider?: string
  model?: string
  attempt?: number
  reason: string
}

/**
 * 跑候选链 —— 第一个成功的候选就用它; 全失败才返回 ok=false (由调用方 fallback-to-local)。
 *
 * 抽成独立函数 + 注入 attempt, 是为了让 QA 要求的 3 组用例
 * (快模型成功 / 快模型空→text 兜底 / 全失败) 能直接跑单测 (不用真的调 LLM)。
 */
export async function runSanitizerCandidates(
  rawPrompt: string,
  candidates: Array<{ config: any; source: string }>,
  attempt: (url: string, config: any, prompt: string, source: string, attemptNo: number, systemPrompt?: string) => Promise<{ outcome: string; polished?: string }>,
  opts?: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; systemPrompt?: string },
): Promise<{ ok: boolean; text?: string; failures: SanitizerCandidateFailure[] }> {
  const MAX_ATTEMPTS = opts?.maxAttempts ?? 2
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const failures: SanitizerCandidateFailure[] = []

  for (let ci = 0; ci < candidates.length; ci++) {
    const { config, source } = candidates[ci]
    if (!config?.apiKey || !config?.model) {
      failures.push({ source, reason: 'config-incomplete' })
      continue
    }
    const url = getTextChatCompletionsUrl(config)
    logTaskProgress('PromptSanitizer', 'llm-rewrite-start', {
      configSource: source,
      provider: config.provider,
      model: config.model,
      inputLen: rawPrompt.length,
      candidateIndex: ci + 1,
      candidateCount: candidates.length,
    })

    for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
      const result = await attempt(url, config, rawPrompt, source, attemptNo, opts?.systemPrompt)
      if (result.outcome === 'success') return { ok: true, text: result.polished, failures }
      if (result.outcome === 'hard-fail') {
        failures.push({ source, provider: config.provider, model: config.model, attempt: attemptNo, reason: 'hard-fail' })
        break  // 硬错换下一个候选 (auth / 4xx 之类, 同配置重试也没用)
      }
      if (attemptNo < MAX_ATTEMPTS) {
        // 2026-10-12 sprint 43 FIX-1 (QA msg-20261012-043): M3 同步限速, retry 之间加 5-10s 随机延迟
        const retryDelayMs = 5000 + Math.floor(Math.random() * 5000)
        logTaskProgress('PromptSanitizer', 'llm-rewrite-retry', { attempt: attemptNo, configSource: source, retryDelayMs })
        await sleep(retryDelayMs)
        continue
      }
      failures.push({ source, provider: config.provider, model: config.model, attempt: attemptNo, reason: 'empty-after-retries' })
    }

    logTaskWarn('PromptSanitizer', 'sanitizer-llm-failed-twice', {
      configSource: source,
      provider: config.provider,
      model: config.model,
      inputLen: rawPrompt.length,
      hint: '该候选配置连续失败, 换下一个候选 (sanitizer → text); 全失败才走本地兜底',
    })
  }

  logTaskWarn('PromptSanitizer', 'all-configs-failed', {
    failures,
    candidates: candidates.map(c => c.source),
    hint: '所有候选配置的 LLM 改写都没成功, 本次走本地 sanitize 兜底 (prompt 原样保留) —— 注意: 原样保留会把 face-archive 词带进 prompt',
  })
  return { ok: false, failures }
}

async function sanitizeImagePromptLLM(rawPrompt, kind: ImagePromptKind = 'shot') {
  const candidates = resolveSanitizerConfigCandidates()
  if (!candidates.length) {
    logTaskWarn('PromptSanitizer', 'no-text-config', { reason: 'no active sanitizer/text AI config' })
    return null
  }
  const result = await runSanitizerCandidates(rawPrompt, candidates, attemptSanitizerLLM, {
    systemPrompt: buildSystemInstruction(kind),
  })
  return result.ok ? (result.text as string) : null
}
/**
 * 图片生成 prompt 无害化改写主入口。
 *
 * - 优先 LLM 视觉化改写(用 text provider)
 * - LLM 失败时本地关键词兜底
 * - 末尾追加艺术化 suffix(若已含则不重复)
 * - 任何异常都被吞掉,保证生图链路不被打断
 */
/**
 * face-archive 参考块 —— 【风格参考: 鹅蛋脸 (Oval Face): oval face, danfeng phoenix eyes...】
 *
 * Sprint 20 (QA msg-20261025-082) P1: 本地兜底路径必须把它去掉。
 *
 * 背景: LLM 改写成功时, 它会把脸型【融进角色描述】("square face, warm eyes, wet black hair"),
 *   档案里的古风描述 (丹凤眼/豆沙唇/银簪) 会被洗掉 —— 实测 2026-10-19 id=262 就是这样,
 *   出来的是写实概念设计稿。
 *   但 LLM 改写失败走本地兜底时, 这段【原样透传】进生图 prompt —— 生图模型会字面执行它,
 *   于是 "danfeng phoenix eyes / bean-paste shade / silver hairpin" 真的画成了古风脸型,
 *   画风也从写实概念设计稿跑成古风线稿 (实测 2026-10-25 id=286)。
 *
 * 角色自己的 5 维外貌 (age/face/hair/body/outfit) 本来就在 prompt 里 (characters.ts 拼的),
 *   去掉档案块不会丢角色一致性 —— 丢的只是"额外的一份脸型参考"。
 */
const FACE_ARCHIVE_BLOCK_RE = /【风格参考:[^】]*】/g

/**
 * 角色形象模板尾部的画风词 —— 'detailed illustration, professional character art'
 *
 * Sprint 20 (QA msg-20261025-083) fix_2: LLM 改写失败走本地兜底时, 这句会把生图模型
 * 往【插画/设定稿】方向带 (实测 2026-10-25 id=287 出的是 FLAT VECTOR / 纯白背景平涂的
 * 动画线稿设定稿, 不是写实概念设计稿)。
 *
 * ⚠️ 只剥这两个【具体短语】, 不剥裸的 'illustration' —— 场景图/道具图的 prompt 里
 *   'illustration' 可能是用户明确要的插画风格, 剥了会改错意图。
 * ⚠️ 只在【本地兜底路径】剥: LLM 改写成功时, 画风词本来就该由 LLM 按上下文决定。
 */
const ILLUSTRATED_STYLE_PHRASES = [
  'detailed illustration',
  'professional character art',
  'illustration, professional',
]

export function stripIllustratedStyleTokens(prompt: string): { text: string; removed: string[] } {
  const src = String(prompt || '')
  if (!src) return { text: src, removed: [] }
  const removed: string[] = []
  let text = src
  for (const phrase of ILLUSTRATED_STYLE_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    if (!re.test(text)) continue
    removed.push(phrase)
    text = text.replace(re, '');
  }
  // 剥完留下的悬挂逗号/空格
  text = text
    .replace(/[ \t]*,\s*(?=,)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*,\s*$/g, '')
    .trim()
  return { text, removed }
}

export function stripFaceArchiveTokens(prompt: string): { text: string; removed: number } {
  const src = String(prompt || '')
  if (!src) return { text: src, removed: 0 }
  let removed = 0
  const text = src.replace(FACE_ARCHIVE_BLOCK_RE, () => { removed++; return '' })
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*,\s*,\s*/g, ', ').trim(), removed }
}

export async function sanitizeImagePrompt(rawPrompt, opts?: { kind?: ImagePromptKind }) {
  const kind = opts?.kind || 'shot'
  try {
    const llmResult = await sanitizeImagePromptLLM(rawPrompt, kind)
    if (llmResult) {
      // Sprint 21: LLM 之后追加 kind 硬约束 (场景空场景 / 角色中性背景) —— 放 LLM 后面不会被洗掉
      return applySafetySuffix(applyKindConstraint(llmResult, kind))
    }
    logTaskWarn('PromptSanitizer', 'fallback-to-local', { reason: 'LLM rewrite unavailable' })
  } catch (err) {
    logTaskError('PromptSanitizer', 'llm-threw', { error: err?.message || String(err) })
  }
  // Sprint 20 P1: 本地兜底时去掉 face-archive 参考块 (见 stripFaceArchiveTokens 的注释)
  const stripped = stripFaceArchiveTokens(sanitizeImagePromptLocal(rawPrompt))
  if (stripped.removed > 0) {
    logTaskWarn('PromptSanitizer', 'face-archive-tokens-stripped-on-fallback', {
      removed: stripped.removed,
      hint: 'LLM 改写失败走本地兜底, face-archive 参考块已去掉 —— 原样透传会让生图模型字面执行档案里的古风脸型词 (丹凤眼/豆沙唇/银簪), 画风跑偏',
    })
  }
  // Sprint 20 fix_2: 再剥掉模板尾部的插画风词 (fallback 路径专用)
  const deIllustrated = stripIllustratedStyleTokens(stripped.text)
  if (deIllustrated.removed.length > 0) {
    logTaskWarn('PromptSanitizer', 'illustrated-style-tokens-stripped-on-fallback', {
      removed: deIllustrated.removed,
      hint: 'LLM 改写失败走本地兜底, 模板尾部的 detailed illustration / professional character art 已去掉 —— 这两句会把画风带成插画/设定稿',
    })
  }
  return applySafetySuffix(applyKindConstraint(deIllustrated.text, kind))
}

/**
 * 更激进的本地替换策略，用于 API 返回 content_policy_violation 时的重试。
 * 在原有 FALLBACK_REPLACEMENTS 基础上追加更广泛的规则，并对未匹配的
 * 通用敏感词做占位符处理。
 */
export function sanitizeImagePromptAggressive(rawPrompt) {
  let out = sanitizeImagePromptLocal(rawPrompt)
  // 第二轮: 对剩余的高危通用词做占位符处理
  out = out.replace(/[一-龥]{2,4}(?:中毒|受伤|武器|血腥|死亡|自杀|谋杀|暗杀|屠杀|虐杀|凌迟|抽筋|剥皮|挖心|剜目|割喉|斩首|碎尸|分尸|焚尸|煮尸|腌尸|泡尸|喂狗|喂狼|喂蛇|喂鱼)/g, '受到<画面>')
  out = out.replace(/[一-龥]{2,4}(?:剑客|刀客|刺客|杀手|刺客|忍者|武林人士|江湖人士)/g, '人物')
  out = out.replace(/[一-龥]{2,4}(?:流血|出血|见血|滴血|冒血|渗血|喷血|淌血|浴血|泣血|血淋淋)/g, '泛红')
  out = out.replace(/[一-龥]{2,4}(?:火海|火墙|火浪|火龙|火焰|火光|焰光|烈焰|烈火|烽火|战火|硝烟|炮火)/g, '光效')
  out = out.replace(/[一-龥]{2,4}(?:爆炸|爆破|炸裂|轰鸣|巨响|震动|冲击)/g, '冲击波')
  out = out.replace(/[一-龥]{2,4}(?:鬼怪|妖魔|精灵|妖精|妖怪|魔物|邪祟|邪灵|恶鬼|厉鬼|冤魂|孤魂|野鬼|阴魂)/g, '神秘角色')
  out = out.replace(/[一-龥]{2,4}(?:诅咒|咒语|法术|魔法|妖术|邪术|降头|蛊毒|毒术|毒术)/g, '神秘力量')
  out = out.replace(/[一-龥]{2,4}(?:地狱|炼狱|深渊|冥界|阴间|鬼域|魔界|妖界|仙境|天堂)/g, '特殊环境')
  out = out.replace(/[一-龥]{2,4}(?:断肢|残臂|断腿|断脚|碎骨|骨折|骨裂|骨断|筋断|脉断|血崩|血喷|血涌|血溢|血溅)/g, '严重受伤')
  out = out.replace(/[一-龥]{2,4}(?:内脏|脏腑|五腑六脏|心肝脾肺肾|五脏六腑|脑浆|颅骨)/g, '体内组织')
  out = out.replace(/[一-龥]{2,4}(?:血雾|血雨|血潮|血浪|血花|血沫|血珠|血滴|血点|血斑|血痕|血迹|血印)/g, '红色雾气')
  out = out.replace(/[一-龥]{2,4}(?:喷涌|涌出|迸溅|流淌|滴落|渗出|汩汩|潺潺|淅沥|蜿蜒|盘旋|缠绕|翻滚)/g, '流动')
  out = out.replace(/[一-龥]{2,4}(?:焦痕|碳化|灰烬|余烬|焦黑|烧焦|烤焦|熏黑|灼伤|烫伤|烧伤|灼痛|刺痛|剧痛|钻心)/g, '痕迹')
  // 第三轮: 通用安全后缀(确保一定存在)
  return applySafetySuffix(out)
}

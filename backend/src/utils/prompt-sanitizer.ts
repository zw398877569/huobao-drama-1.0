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
import { getActiveConfig } from '../services/ai.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { logTaskError, logTaskProgress, logTaskWarn } from './task-logger.js'
import { DEFAULT_IMAGE_SAFETY_SUFFIX } from '../services/image-generation.js'

const LLM_TIMEOUT_MS = 8_000

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
  // LLM 改写后仍可能漏掉的视觉化高敏词
  // 顺序:先做最具体的复合短语,再做单词替换,避免规则互相破坏
  // === 复合短语(必须先匹配,否则单词规则会破坏语义) ===
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

const SUFFIX_MARKERS = ['电影剧照', '艺术化构图', '戏剧张力']

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

const SYSTEM_INSTRUCTION = [
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
  'E. 末尾追加 ", 电影剧照, 戏剧张力, 艺术化构图"。',
  'F. 输出中文,逗号分隔短句,总长不超过 240 字。',
  'G. 严禁输出任何解释、前缀、引号、markdown 代码块,严禁输出 <think> 思考块,只输出改写后的 prompt 字符串本身。',
].join('\n')

function extractPromptFromLLM(raw) {
  if (!raw) return null
  let text = raw.trim()

  // 1) 剥掉推理模型的思考块(DeepSeek/MiniMax-M3/QwQ 等都会输出 <think>...</think>)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  text = text.replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')

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
  if (paragraphs.length === 0) return null
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

// 检测 LLM 改写后是否仍有 agnes 容易拒掉的关键词
function containsResidualPolicyRisk(text) {
  // 武器/武侠 + 暴力/燃烧类,任一命中即认为有残留风险
  return /(?:杀气|血色|尸体|鲜血|搏杀|拼杀|厮杀|燃烧|燃起|残阳如血|残阳如丹|血色夕阳|杀机|邪气|萧杀|肃杀|比武|过招|剑身|剑刃|刀锋|长剑|短剑|刀光|剑光|兵器|武功|高手|对决|致命一击|残忍.{0,2}对待|凄厉|哀嚎|死亡.{0,2}威胁|白骨|死寂|残月|武林)/.test(text)
}

function getTextProviderBaseUrlPath(provider) {
  const p = (provider || '').toLowerCase()
  if (p === 'openai' || p === 'openrouter' || p === 'chatfire') return '/v1'
  if (p === 'volcengine') return '/api/v3'
  if (p === 'ali') return '/api/v1'
  return ''
}

async function sanitizeImagePromptLLM(rawPrompt) {
  const config = getActiveConfig('text')
  if (!config) {
    logTaskWarn('PromptSanitizer', 'no-text-config', { reason: 'no active text AI config' })
    return null
  }
  if (!config.apiKey || !config.model) {
    logTaskWarn('PromptSanitizer', 'text-config-incomplete', { provider: config.provider })
    return null
  }

  const url = joinProviderUrl(
    config.baseUrl,
    getTextProviderBaseUrlPath(config.provider),
    '/chat/completions',
  )
  logTaskProgress('PromptSanitizer', 'llm-rewrite-start', {
    provider: config.provider,
    model: config.model,
    inputLen: rawPrompt.length,
  })

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
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: `原文 prompt:\n<<<${rawPrompt}>>>` },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      logTaskWarn('PromptSanitizer', 'llm-rewrite-http-error', {
        status: resp.status,
        body: errText.slice(0, 240),
      })
      return null
    }
    const data = await resp.json()
    const content = data?.choices?.[0]?.message?.content
    const rewritten = extractPromptFromLLM(typeof content === 'string' ? content : '')
    if (!rewritten) {
      logTaskWarn('PromptSanitizer', 'llm-rewrite-empty', {
        provider: config.provider,
        rawPreview: (typeof content === 'string' ? content : '').slice(0, 400),
      })
      return null
    }
    logTaskProgress('PromptSanitizer', 'llm-rewrite-success', {
      provider: config.provider,
      inLen: rawPrompt.length,
      outLen: rewritten.length,
      rewritten,
    })
    // 第二层防御:LLM 改写后可能仍有 agnes 黑名单关键词残留,
    // 用本地 sanitize 再精确擦除一次(不丢弃 LLM 的整体框架)
    const polished = sanitizeImagePromptLocal(rewritten)
    if (polished !== rewritten) {
      logTaskProgress('PromptSanitizer', 'llm-output-polished', {
        provider: config.provider,
        before: rewritten.slice(0, 60),
        after: polished.slice(0, 60),
      })
    }
    if (containsResidualPolicyRisk(polished)) {
      // 本地 sanitize 后仍有残留,降级到纯本地兜底
      logTaskWarn('PromptSanitizer', 'llm-output-still-risky', {
        provider: config.provider,
        preview: polished.slice(0, 80),
      })
      return null
    }
    return polished
  } catch (err) {
    logTaskWarn('PromptSanitizer', 'llm-rewrite-failed', { error: err?.message || String(err) })
    return null
  }
}

/**
 * 图片生成 prompt 无害化改写主入口。
 *
 * - 优先 LLM 视觉化改写(用 text provider)
 * - LLM 失败时本地关键词兜底
 * - 末尾追加艺术化 suffix(若已含则不重复)
 * - 任何异常都被吞掉,保证生图链路不被打断
 */
export async function sanitizeImagePrompt(rawPrompt) {
  try {
    const llmResult = await sanitizeImagePromptLLM(rawPrompt)
    if (llmResult) {
      return applySafetySuffix(llmResult)
    }
    logTaskWarn('PromptSanitizer', 'fallback-to-local', { reason: 'LLM rewrite unavailable' })
  } catch (err) {
    logTaskError('PromptSanitizer', 'llm-threw', { error: err?.message || String(err) })
  }
  const local = sanitizeImagePromptLocal(rawPrompt)
  return applySafetySuffix(local)
}

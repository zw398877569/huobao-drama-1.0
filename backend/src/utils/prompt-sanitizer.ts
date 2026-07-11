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
  '改写规则:',
  '1. 保留所有视觉信息:发型、服装、构图、光线、色调、镜头、表情、姿态、场景。',
  '2. 对"中毒/受伤/武器/血腥/死亡/师徒暧昧/昏迷/濒死/窒息/自尽"等高敏语义,',
  '   用中性的视觉描写替换(例如:昏迷不醒→安静地闭目养神;毒气攻心、肤色滚烫→面部泛着柔和的红润光晕;刀光剑影→光影交错)。',
  '3. 末尾追加 ", 电影剧照, 戏剧张力, 艺术化构图"。',
  '4. 输出语言保持中文,逗号分隔短句,总长不超过 240 字。',
  '5. 严禁输出任何解释、前缀、引号或 markdown,只输出改写后的 prompt 字符串本身。',
].join('\n')

function extractPromptFromLLM(raw) {
  if (!raw) return null
  let text = raw.trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
  text = text.replace(/^(改写后的?\s*prompt\s*[:：]\s*|prompt\s*[:：]\s*|output\s*[:：]\s*)/i, '')
  text = text.replace(/^["「『]+|["」』]+$/g, '')
  if (!/[一-龥]/.test(text)) return null
  if (text.length > 600) text = text.slice(0, 600)
  return text.trim()
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
      logTaskWarn('PromptSanitizer', 'llm-rewrite-empty', { provider: config.provider })
      return null
    }
    logTaskProgress('PromptSanitizer', 'llm-rewrite-success', {
      provider: config.provider,
      inLen: rawPrompt.length,
      outLen: rewritten.length,
      rewritten,
    })
    return rewritten
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

/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'sanitizer'

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 不同 LLM provider 的 base path 前缀。
 * 与 prompt-sanitizer.ts 旧版 getTextProviderBaseUrlPath 同源, 提到此处统一。
 * (两个版本之前略有重复, 现在只有这一处定义)
 *
 * 注意: minimax 也在 /v1 端点上 (OpenAI 兼容), 跟 openai/openrouter/chatfire 同组
 */
function textProviderPath(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'openai' || p === 'openrouter' || p === 'chatfire' || p === 'minimax') return '/v1'
  if (p === 'volcengine') return '/api/v3'
  if (p === 'ali') return '/api/v1'
  return ''
}

/**
 * 返回带 provider 路径前缀的 base URL (无末尾 path 部分)
 * — 用于 Vercel AI SDK 这类需要自己拼 path 的库 (agents/index.ts:864)
 */
export function getTextProviderBaseUrl(config: AIConfig) {
  return joinProviderUrl(config.baseUrl, textProviderPath(config.provider), '')
}

/**
 * 返回完整的 chat completions URL — 多数 LLM provider 都用同一端点
 * — 替代之前 5 处手工拼接 (4 种写法), 见 PR commit message
 */
export function getTextChatCompletionsUrl(config: AIConfig): string {
  return joinProviderUrl(config.baseUrl, textProviderPath(config.provider), '/chat/completions')
}

// 2026-09-25 PM msg-20260924-002 决策 B: text config baseUrl 监控
// 当 text 服务 active config 的 baseUrl host 不在已知 provider 列表时, 记 WARN (config_drift)
// 防 voice_assigner 端点串入 deepseek 这类 silent breaking 再次发生 — 及时发现让 agentType 跑错端点
//
// 已知 text provider host (HUOBAO_PRESET_SERVICES + 用户当前 DB 的 MiniMax):
const TEXT_BASEURL_ALLOWED_HOSTS = [
  'minimaxi.com',         // MiniMax openai 兼容端点 (用户当前 DB configId=1)
  'minimax.cn',           // MiniMax 官方端点 (configId=9/10, isActive=1)
  'chatfire.site',        // chatfire 代理 (HUOBAO_PRESET 默认, 用户当前 DB 未用)
  'openrouter.ai',        // openrouter 备用
]

function isTextBaseUrlAllowed(baseUrl: string): boolean {
  const url = (baseUrl || '').toLowerCase()
  return TEXT_BASEURL_ALLOWED_HOSTS.some(host => url.includes(host))
}

function parseModelsJson(modelField: unknown): string {
  if (!modelField) return ''
  try {
    const arr = JSON.parse(modelField as string)
    return Array.isArray(arr) ? (arr[0] || '') : (modelField as string)
  } catch {
    return modelField as string
  }
}

function monitorTextConfigDrift(activeRow: any): void {
  // 仅 text 服务监控 (audio/image/video provider host 各自不同, 误报风险高, scope 控制)
  if (!isTextBaseUrlAllowed(activeRow.baseUrl)) {
    logTaskWarn('AIConfig', 'text-config-baseurlunexpected', {
      configId: activeRow.id,
      serviceType: 'text',
      provider: activeRow.provider,
      baseUrl: activeRow.baseUrl,
      model: parseModelsJson(activeRow.model),
      allowed_hosts: TEXT_BASEURL_ALLOWED_HOSTS,
      severity: 'config_drift',
      hint: 'active text config baseUrl 不在已知 provider host 列表, 可能是端点串入/配置漂移, 排查 DB aiServiceConfigs 表 + 任何 agentType getActiveConfig(\'text\') 链路上的 setBaseUrl override',
    })
  }
}

/**
 * 2026-10-12 sprint 43 FIX-7 (QA msg-20261012-043): 后端 GET episode 时返回当前生效的 video config label
 * 优先级: episode.videoConfigId (用户显式锁) > aiServiceConfigs serviceType='video' 优先级最高 active 行 (后端 fallback)
 * 返 label 字符串 (跟 useConfigLoading.ts:71-76 configLabel 格式一致), 没找到返 null
 */
export function getActiveVideoConfigLabel(videoConfigId: number | null | undefined): string | null {
  // 1. episode.videoConfigId 设了 → 查该 id 的 config
  let row: any = null
  if (videoConfigId) {
    const [r] = db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, videoConfigId))
      .all()
    row = r
  }
  // 2. 没设 / 查不到 → 查 serviceType='video' 优先级最高 active 行 (跟 getActiveConfig 行为一致)
  if (!row) {
    const rows = db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.serviceType, 'video'))
      .all()
      .filter(r => r.isActive)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    row = rows[0]
  }
  if (!row) return null
  // 跟 useConfigLoading.ts configLabel 同格式
  let modelName = ''
  try {
    const m = row.model ? JSON.parse(row.model) : []
    modelName = Array.isArray(m) ? (m[0] || '') : (m || '')
  } catch { modelName = row.model || '' }
  const suffix = row.isActive === false ? ' · 已停用' : ''
  return modelName ? `${row.name} · ${modelName} (${row.provider})${suffix}` : `${row.name} (${row.provider})${suffix}`
}

export function getActiveConfig(serviceType: ServiceType): AIConfig | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = active.model ? JSON.parse(active.model) : []
  logTaskProgress('AIConfig', 'active-config-selected', {
    serviceType,
    configId: active.id,
    provider: active.provider,
    model: models[0] || '',
    priority: active.priority,
  })
  // 2026-09-25 PM msg-20260924-002 决策 B: 监控 — text 端点漂移检测
  if (serviceType === 'text') monitorTextConfigDrift(active)
  return {
    provider: active.provider || '',
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: models[0] || '',
  }
}

export function getTextConfig(): AIConfig {
  const config = getActiveConfig('text')
  if (!config) throw new Error('No active text AI config')
  return config
}

export function getAudioConfig(): AIConfig {
  const config = getActiveConfig('audio')
  if (!config) throw new Error('No active audio AI config — 请在设置中添加音频服务')
  return config
}

export function getAudioConfigById(id?: number | null): AIConfig {
  if (id) {
    const config = getConfigById(id)
    if (config) return config
  }
  return getAudioConfig()
}

export function getConfigById(id: number): AIConfig | null {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row) {
    // ID 根本不存在 (数据库没有这行) — 与「存在但被关掉」是两种不同场景,分开记便于排查
    logTaskWarn('AIConfig', 'config-not-found', { configId: id })
    return null
  }
  if (!row.isActive) {
    // 行存在但 isActive=false — 用户在设置页关掉的配置被代码或前端选了。
    // 记 provider 方便定位是哪个服务的配置被关掉。
    logTaskWarn('AIConfig', 'config-inactive', { configId: id, provider: row.provider })
    return null
  }
  const models = row.model ? JSON.parse(row.model) : []
  logTaskProgress('AIConfig', 'config-by-id-selected', {
    configId: id,
    provider: row.provider,
    model: models[0] || '',
    serviceType: row.serviceType,
  })
  return {
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: models[0] || '',
  }
}

/**
 * 解析路由入参中的 config_id：
 *   - 数字 / 数字字符串         → { configId }
 *   - "8:gpt-image-2" 复合格式  → { configId: 8, model: "gpt-image-2" }
 *   - null / 空 / 非数字        → {}
 *
 * 用于支持多模型配置：同一 ai_service_configs 行可挂多个 model，
 * 前端模型选择器把 value 编为 "<configId>:<modelName>" 让用户精确选到具体 model，
 * 而不仅仅是 config 行。后端需要拆分 model 传给 generateImage / generateVideo，
 * 不然 getConfigById("8:gpt-image-2") 会查不到行（只匹配纯数字主键）。
 *
 * 返回的 model 用于覆盖 config.model（后者只取 models[0]），
 * 落库时确保是用户选中的那个 model 名。
 */
export function parseConfigIdWithModel(value: unknown): { configId?: number; model?: string } {
  if (value === null || value === undefined || value === '') return {}
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { configId: value } : {}
  }
  if (typeof value !== 'string') return {}
  // 复合格式：按第一个冒号切（model 名只含 -/_ 等，不含 :）
  const colonIdx = value.indexOf(':')
  if (colonIdx > 0) {
    const idStr = value.slice(0, colonIdx).trim()
    const modelStr = value.slice(colonIdx + 1).trim()
    const id = Number(idStr)
    const out: { configId?: number; model?: string } = {}
    if (Number.isFinite(id) && id > 0) out.configId = id
    if (modelStr) out.model = modelStr
    return out
  }
  // 纯数字字符串
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? { configId: id } : {}
}

/**
 * 检测 prompt 是否包含非英文字符
 */
export function hasNonEnglishChars(text: string): boolean {
  return /[^\x00-\x7F]/.test(text)
}

/**
 * 剥掉推理模型输出的思考/反思/推理块 — 多个 provider (DeepSeek/MiniMax-M3/QwQ 等) 都会输出
 * <think>...</think> / <reflection>...</reflection> / <reasoning>...</reasoning>。
 * 这些块不应该进入发给上游图片/视频 API 的 prompt (会污染画面 / 触发审核 / 浪费 token)。
 *
 * 集中放在 helper, 让 translateImagePromptToEnglish / translateVideoPromptToEnglish
 * 与 utils/prompt-sanitizer.ts#extractPromptFromLLM 共用同一份剥离规则, 避免一处防护一处漏。
 */
export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    // QA msg-20261010-014 ISSUE-014 Fix 2: LLM 经常用 ```json ... ``` markdown fence 包裹 JSON 输出
    //   (LLM 系统 prompt 说 '严格 JSON', 但实际还是 markdown), 剥 fence 后再 JSON.parse
    .replace(/^\s*```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

/**
 * 通用 prompt 翻译入口 — 调用 text provider LLM, 完成防护 (think 块剥离 / reasoning 禁用 / 截断降级)。
 *
 * @param userPrompt — 待翻译的原始 prompt
 * @param systemPrompt — 调用方提供的翻译指令 (image vs video 不同, 见下方两个包装函数)
 * @returns 清洗后的英文翻译; 任何失败路径 (无 text config / HTTP 错 / 空内容 / 截断) 都 fallback 原 prompt,
 *   保证上游生图链路不被打断。
 */
/**
 * Sprint 16 QA msg-20261021-073: 翻译/对齐调用的超时 + 重试策略。
 *
 * 背景: 30s 硬超时 + 零重试, MiniMax-M3 偶发慢响应 (实测 id=180 跑了 30.099s 才被掐断)
 *   就会 fallback 回原中文 prompt —— 对齐 (A2) 完全没跑, integrated 描述跟时间轴继续互相矛盾,
 *   用户观感就是「错角色说台词」。
 *   本函数还兼着 sprint-16 的描述/时间轴对齐职责, 比普通翻译更重, 30s 偏紧。
 *
 * 超时值参考同项目其它 LLM 链路: scene-intention.ts 60s, storyboard-planner-service 420s。
 * 这里取 90s —— 正常路径 13s 左右返回, 超时只在真的慢的时候才吃到, 不拖正常流程。
 *
 * 全部可用 env 覆盖 (不设就用默认值):
 *   PROMPT_TRANSLATION_TIMEOUT_MS      默认 90000
 *   PROMPT_TRANSLATION_MAX_RETRIES     默认 1
 *   PROMPT_TRANSLATION_RETRY_GAP_MS    默认 3000
 *   PROMPT_TRANSLATION_MODEL           默认不覆盖 (用 active text config 的模型);
 *                                     填了则只用这个模型做翻译/对齐, 不影响拆解/音色等其它链路
 */
const PROMPT_TRANSLATION_TIMEOUT_MS = Number(process.env.PROMPT_TRANSLATION_TIMEOUT_MS || 90_000)
const PROMPT_TRANSLATION_MAX_RETRIES = Number(process.env.PROMPT_TRANSLATION_MAX_RETRIES || 1)
const PROMPT_TRANSLATION_RETRY_GAP_MS = Number(process.env.PROMPT_TRANSLATION_RETRY_GAP_MS || 3_000)
/** 800 在中文角色 prompt + think overhead 下必截。先提到 2000, sprint 16 加了对齐职责
 *  (要按时间轴重写描述) 再提到 2600 留余量 —— 截断会直接毁掉整个 prompt。 */
const PROMPT_TRANSLATION_MAX_TOKENS = 2600

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callTextLLMForPrompt(userPrompt: string, systemPrompt: string): Promise<string> {
  const config = getActiveConfig('text')
  if (!config) {
    logTaskWarn('PromptTranslation', 'text-config-missing', { reason: 'skipping translation, using original prompt' })
    return userPrompt
  }

  const url = getTextChatCompletionsUrl(config)
  const model = process.env.PROMPT_TRANSLATION_MODEL?.trim() || config.model || 'agnes-2.0-flash'
  // 日志底座: 排查「是慢还是失败」靠这几个数, 不用再去翻 llm-debug-*.log
  const logMeta = {
    provider: config.provider,
    model,
    systemLen: systemPrompt.length,
    userLen: userPrompt.length,
    maxTokens: PROMPT_TRANSLATION_MAX_TOKENS,
    timeoutMs: PROMPT_TRANSLATION_TIMEOUT_MS,
  }

  for (let attempt = 0; attempt <= PROMPT_TRANSLATION_MAX_RETRIES; attempt++) {
    const startedAt = Date.now()
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: PROMPT_TRANSLATION_MAX_TOKENS,
          // MiniMax-M3 等推理模型默认输出 thinking 块, 禁用以避免污染翻译结果 (与 prompt-sanitizer.ts:296 一致)
          extra_body: { reasoning: { enabled: false } },
        }),
        signal: AbortSignal.timeout(PROMPT_TRANSLATION_TIMEOUT_MS),
      })
    } catch (err: any) {
      const elapsedMs = Date.now() - startedAt
      logTaskWarn('PromptTranslation', 'http-threw', {
        ...logMeta,
        elapsedMs,
        attempt,
        willRetry: attempt < PROMPT_TRANSLATION_MAX_RETRIES,
        error: err?.message || String(err),
      })
      // 网络/超时 → 重试
      if (attempt < PROMPT_TRANSLATION_MAX_RETRIES) {
        await sleepMs(PROMPT_TRANSLATION_RETRY_GAP_MS)
        continue
      }
      return userPrompt
    }

    const elapsedMs = Date.now() - startedAt
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      // 5xx / 429 是可重试的 (服务端抖 / 限流); 其它 4xx (鉴权/参数) 重试没有意义
      const retryable = resp.status >= 500 || resp.status === 429
      logTaskWarn('PromptTranslation', 'translation-failed', {
        ...logMeta,
        elapsedMs,
        attempt,
        status: resp.status,
        retryable,
        willRetry: retryable && attempt < PROMPT_TRANSLATION_MAX_RETRIES,
        error: errText.slice(0, 200),
      })
      if (retryable && attempt < PROMPT_TRANSLATION_MAX_RETRIES) {
        await sleepMs(PROMPT_TRANSLATION_RETRY_GAP_MS)
        continue
      }
      return userPrompt
    }

    let data: any
    try {
      data = await resp.json() as any
    } catch (err: any) {
      logTaskWarn('PromptTranslation', 'response-not-json', {
        ...logMeta,
        elapsedMs,
        attempt,
        willRetry: attempt < PROMPT_TRANSLATION_MAX_RETRIES,
        error: err?.message || String(err),
      })
      if (attempt < PROMPT_TRANSLATION_MAX_RETRIES) {
        await sleepMs(PROMPT_TRANSLATION_RETRY_GAP_MS)
        continue
      }
      return userPrompt
    }

    const choice = data?.choices?.[0]
    const raw = choice?.message?.content?.trim() || ''
    if (!raw) {
      logTaskWarn('PromptTranslation', 'empty-translation', { ...logMeta, elapsedMs, attempt, reason: 'no content in response' })
      return userPrompt
    }
    // 截断防护: max_tokens 触顶时不要用半截翻译 (后半段可能是中文残留 + 拼回去反而更糟)
    //   重试没用 (temperature=0 + 同样输入 = 同样输出), 所以不重试
    if (choice?.finish_reason === 'length') {
      logTaskWarn('PromptTranslation', 'truncated-fallback', {
        ...logMeta,
        elapsedMs,
        attempt,
        rawLen: raw.length,
        hint: 'max_tokens 触顶, 提高 PROMPT_TRANSLATION_MAX_TOKENS 或换更省 token 的模型',
      })
      return userPrompt
    }
    // 二次防护: 即使模型没被 reasoning 禁用参数拦住 (provider 不支持), 也手动剥 think 块
    const cleaned = stripReasoningBlocks(raw)
    if (!cleaned) {
      logTaskWarn('PromptTranslation', 'all-think-stripped', { ...logMeta, elapsedMs, attempt, reason: 'cleaned output empty' })
      return userPrompt
    }
    logTaskProgress('PromptTranslation', 'translated', { ...logMeta, elapsedMs, attempt, outLen: cleaned.length })
    return cleaned
  }

  // 理论上到不了这里 (循环里每条分支都 return), 兜底保险
  return userPrompt
}

/**
 * 图片 prompt 翻译 — 用于角色图 / 场景图 / 道具图 / 分镜首尾帧。
 *
 * 跟视频不同, 图片 prompt 完全没有「中文对白」或「H3 三段式」需要保留,
 * 目标就是干净纯英文视觉描述, 给英文 diffusion 模型 (Grsai GPT/Nano Banana/Hailuo) 用。
 *
 * 旧 translatePromptToEnglish (video 专用 system) 误被 image 路径复用时, 模型因看不到
 * H3 / XML 等预期结构而困惑, 触发 chain-of-thought 输出 <think> 块泄露到最终 prompt
 * (2026-09-18 bug report) — 拆函数后两边 system prompt 各管各的, 不会再误触发 reasoning。
 */
export async function translateImagePromptToEnglish(prompt: string): Promise<string> {
  const systemPrompt = (
    'You are translating an AI image generation prompt into fluent English. '
    + 'Preserve all concrete visual details: face / appearance / outfit / scene / lighting / color '
    + '/ camera angle / style tokens (cinematic, anamorphic, shallow DOF, etc.). '
    + 'Output ONLY the English translation — no commentary, no explanation, no thinking blocks. '
    + 'Do NOT preserve any Chinese in the output; the entire result should be English.'
  )
  return callTextLLMForPrompt(prompt, systemPrompt)
}

/**
 * 视频 prompt 翻译 — 用于 storyboard video generation (H3 三段式 video_prompt)。
 *
 * 必须保留:
 *   - H3 三段式英文 header: 'Integrated multimodal description:', 'Overall soundscape:',
 *     'Non-diegetic music:'
 *   - XML 标签: <n>0-3s</n> 时间戳, <location>X</location>, <role>X</role>, <voice>X</voice>
 *   - 中文对白 (开口:'...' / <d>...</d> 内部) — 不能翻译成英文, 演员要照原语言念
 *   - 删掉 speaker 前缀 (如 "年轻人:" 应被剥掉, 只保留台词)
 */
export async function translateVideoPromptToEnglish(prompt: string): Promise<string> {
  // Sprint 16 (PM msg-20261020-072) 在原有翻译职责上加了「描述/说话时间轴对齐」:
  //   翻译本质就是改写整个 prompt, 让同一次调用顺手把 integrated 描述里的角色动作
  //   跟末尾的说话时间轴对齐 —— 等于白捡一次对齐, 不额外花 LLM 调用。
  //   不对齐的后果 (QA 2026-10-20 实测): 描述写 "Linda sits completely still" 而音频里
  //   Linda 在说话, H3 两个都看到了 -> 画面让另一个人动嘴, 音频是 Linda 的声音。
  const systemPrompt = (
    'You are translating AND aligning a video generation prompt for an AI video model. '
    + 'Preserve the three H3 sections exactly with their English headers: '
    + '"Integrated multimodal description:", "Overall soundscape:", "Non-diegetic music:". '
    + 'Keep XML-style tags intact: <n>0-3s</n> and <n>0-3秒：</n> timecodes, <location>X</location>, '
    + '<role>X</role>, <voice>X</voice>. '
    + 'CRITICAL: Dialogue inside 开口:\'...\' or <d>...</d> tags MUST stay in the '
    + 'ORIGINAL language — do NOT translate the spoken words. Translate only the '
    + 'surrounding action/description. Strip speaker name prefix (e.g. "年轻人:" '
    + 'before the line should be removed, keep only the spoken words). '
    + 'SPEAKING SCHEDULE (critical): the user text ends with a schedule of segments like '
    + '<n>0-4秒：王秀兰开口:\'...\'</n>. That schedule is the AUTHORITATIVE source of who speaks when. '
    + 'Rewrite the Integrated multimodal description so it AGREES with the schedule: '
    + 'inside each time range, the speaker named in the schedule must be the one talking / moving their mouth; '
    + 'never describe a speaking character as still, motionless, silent, or not moving; '
    + 'and never describe a non-speaking character as talking. '
    + 'Keep the schedule segments themselves byte-identical (same timecodes, same speaker names, same dialogue text). '
    + 'Output ONLY the English translation, no commentary, no thinking blocks.'
  )
  return callTextLLMForPrompt(prompt, systemPrompt)
}

/**
 * @deprecated 拆分为 translateImagePromptToEnglish / translateVideoPromptToEnglish 后保留 1 个 commit 周期,
 * 下个 commit 删。当前转发到 image 版保持 image 路径行为不变 (旧实现本身就有这个行为)。
 *
 * 之所以保留 fallback 而不是直接删: 调用方不止 image/video (video-generation.ts 也用过),
 * 留个 grep 余地让外部 caller (如果有) 自己迁移。
 */
export async function translatePromptToEnglish(prompt: string): Promise<string> {
  return translateImagePromptToEnglish(prompt)
}

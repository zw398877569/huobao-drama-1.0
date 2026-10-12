/**
 * LLM Schema Validator — 公共 zod 校验 + salvage 工具
 *
 * 2026-10-10 V3 治本 (PM msg-20261010-002): V2 让 LLM 输出 array of strings,
 *   string 可含任何内容, LLM 仍塞 plot 描述进去 (drama 9 主人 '深爱豆豆胜过自己'),
 *   zod 不报错, 软约束 (JSDoc) LLM 忽略。
 * V3 治本: 让 LLM 输出 array of {category: enum, value: string} 结构化对象,
 *   5 维 enum 强约束 (age/face/hair/body/outfit), LLM 想写 plot 描述
 *   会因没匹配 category 被 zod reject。
 *
 * 公共逻辑:
 *   - V3ShotDetailsItemSchema: shot_plan[i] 的 V3 严格 schema, 用于 tool inputSchema + 后置 salvage
 *   - salvageShotDetailsItem: tool call 成功后, 二次扫描解析出来的对象,
 *     仍不达标的字段 (LLM 偶尔塞进 character_traits 但不属于 5 维 enum) → 移到 plot_state 字段 + logTaskWarn
 *   - structureToText: V3 结构化对象 → 拼接成 imagePrompt 文本段 (跟 V2 拼接公式兼容)
 *
 * 跨 sprint 复用: V4 拆 3 步 endpoint 也用这套 schema + salvage。
 */
import { z } from 'zod'
import { logTaskWarn } from '../utils/task-logger.js'

// ─── V3 enum 强约束定义 ────────────────────────────────────────

/**
 * permanent_traits 强制 5 维 enum (PM msg-20261010-002 D1 拍板)。
 * 跨剧情通用 — 永久外貌任何剧情适用 (年龄/脸型/发型/体态/服装基准)。
 * 不接受 'clothing/accessory/eyebrows/skin_tone' 等扩展维度 — 防止 enum 无限扩大,
 * 扩展维度时 fallback 到 plot_state, 由用户手动 review。
 */
export const PERMANENT_TRAITS_CATEGORIES = ['age', 'face', 'hair', 'body', 'outfit'] as const
export type PermanentTraitsCategory = typeof PERMANENT_TRAITS_CATEGORIES[number]

export const SHOT_TYPE_REFS = ['全景', '中景', '近景', '特写'] as const
export type ShotTypeRef = typeof SHOT_TYPE_REFS[number]

// ─── V3 子 schema ──────────────────────────────────────────────

/**
 * image_prompt_permanent 单条 schema。
 * character_traits 2-10 项, 每项 category 必须在 5 维 enum 内。
 * scene_aesthetic 0-5 项 (场景氛围数组, 不限 enum)。
 * shot_type_ref 必须是 SHOT_TYPE_REFS 之一。
 * angle / movement 自由 string (机位/运镜)。
 */
export const V3ImagePromptPermanentSchema = z.object({
  // QA msg-20261012-040 Fix 2: category 放宽为 z.string(), 非法值由 salvageImagePromptPermanent
  //   移到 plotState (和 shot_type_ref 同理 sprint 39 Fix 2 已改)。用 schema 硬 reject 一个可以被 salvage 的字段,
  //   会导致整个 response 报废 + 重跑 LLM 118s — 分层不对。
  // value 同步放宽到 500 + min/max 放宽到 2..20 的原因: 非法 category 的条目本来就要被移到 plotState
  //   (内容完整保留在 plotState 里), 如果 value 卡死 50 字 + zod reject 整个 response, 那些内容就彻底丢了。
  // 放宽后交给 salvage 分流 — 合法的截到 50, 非法的完整进 plotState。
  // 放宽后 V3 5 维 enum 强约束的'物理保证'被削弱 — 变成 salvage 软约束
  // (LLM 输 clothing 也能过, 只是会被挪到 plotState)。严格性由 salvage + flow log warn 保证可观测, 而不是 zod reject
  character_traits: z.array(z.object({
    category: z.string(),          // salvage 会校验并 fallback, 不在 5 维 enum 的移到 plotState
    value: z.string().max(500),    // 同时放宽: 非法 category 的描述可能较长, 截断到 500 再由 salvage 截到 50
  })).min(2).max(20),             // 上限放到 20: salvage 会裁到 10, 多出的移到 plotState 不丢失
  scene_aesthetic: z.array(z.string()).min(0).max(5),
  // QA msg-20261012-039 Fix 2: 放宽 shot_type_ref 从 z.enum(SHOT_TYPE_REFS) → z.string().optional(), 让 salvageImagePromptPermanent (L170-184) 兜底 fallback, 比硬 reject + retry 整个 LLM (118s) 更省 token
  shot_type_ref: z.string().optional(),  // LLM 可能输出 '中近景'/'中全景' 等复合值, salvage 兜底统一 fallback 到 '中景', 治本不再烧 retry
  angle: z.string(),
  movement: z.string(),
})

/**
 * shot_plan[i] 的 V3 完整 schema (跟 V2 generateShotPrompts inputSchema 兼容,
 * 只把 image_prompt_permanent 字段从 string 改成结构化 object)。
 *
 * 用 preprocess 容错 LLM 输出 JSON 字符串时 parse 成 object (跟 V2 character_ids
 * preprocess 同源)。
 */
export const V3ShotDetailsItemSchema = z.object({
  shot_number: z.number().int().positive(),
  // V3 治本: image_prompt_permanent 从 string 改成结构化 object
  image_prompt_permanent: z.preprocess(
    (v): unknown => {
      if (v === null || v === undefined) return null
      if (typeof v === 'string') {
        try { return JSON.parse(v) } catch { return v }
      }
      return v
    },
    V3ImagePromptPermanentSchema.nullish()
  ),
  image_prompt_plot_state: z.string().nullish(),
  video_prompt_permanent: z.string().nullish(),
  video_prompt_plot_state: z.string().nullish(),
  // 兼容 V2 其它字段 (LLM 输出 free-text 时这些仍是 string)
  scene_id: z.number().int().nullish(),
  character_ids: z.array(z.number().int()).nullish(),
  shot_type: z.string().nullish(),
  angle: z.string().nullish(),
  movement: z.string().nullish(),
  duration: z.number().nullish(),
  location: z.string().nullish(),
  time: z.string().nullish(),
  action: z.string().nullish(),
  dialogue: z.string().nullish(),
  description: z.string().nullish(),
  result: z.string().nullish(),
  atmosphere: z.string().nullish(),
  intent_function: z.string().nullish(),
})

// ─── Salvage / Fallback 逻辑 ──────────────────────────────────

/**
 * image_prompt_permanent salvage — tool 拍板的数据已经通过 V3 zod 校验,
 * 但 LLM 偶尔会塞 enum 边界外的字符 (例如 '深爱豆豆胜过自己' 当作 value),
 * 这里再做二次扫描:
 *
 *   1. character_traits[i].category 不在 enum → 整条移到 plot_state
 *   2. character_traits[i].value 超过 50 字 → 截断到 50 字
 *   3. character_traits 超过 10 条 → 截断到 10 条, 多余的移到 plot_state
 *   4. scene_aesthetic 超过 5 条 → 截断到 5 条
 *   5. shot_type_ref 不在 SHOT_TYPE_REFS → fallback 到 '中景', log warn
 *
 * 失败时 logTaskWarn 报警, 不阻塞主流程 (PM msg-20261010-002 D3 拍板)。
 *
 * 返回: { imagePromptPermanent: 清洗后的对象 | null, plotState: 拼接后的 fallback 字符串 | null }
 */
export interface SalvageResult {
  imagePromptPermanent: z.infer<typeof V3ImagePromptPermanentSchema> | null
  plotState: string
}

export function salvageImagePromptPermanent(
  raw: unknown,
  ctx: { episodeId: number; shotNumber: number },
): SalvageResult {
  const fallbackParts: string[] = []

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { imagePromptPermanent: null, plotState: '' }
  }

  const obj = raw as Record<string, unknown>

  // 1-4. character_traits 清洗
  const traitsRaw = Array.isArray(obj.character_traits) ? obj.character_traits : []
  const validTraits: { category: PermanentTraitsCategory; value: string }[] = []
  for (const t of traitsRaw) {
    if (!t || typeof t !== 'object') continue
    const item = t as { category?: unknown; value?: unknown }
    const cat = typeof item.category === 'string' ? item.category : ''
    const val = typeof item.value === 'string' ? item.value : ''
    if (!PERMANENT_TRAITS_CATEGORIES.includes(cat as PermanentTraitsCategory)) {
      // 非法 category → 整条移到 plot_state
      fallbackParts.push(`[${cat || 'unknown'}]:${val}`.slice(0, 200))
      continue
    }
    if (val.length > 50) {
      // value 超过 50 字 → 截断
      validTraits.push({ category: cat as PermanentTraitsCategory, value: val.slice(0, 50) })
    } else {
      validTraits.push({ category: cat as PermanentTraitsCategory, value: val })
    }
  }
  // 数量上限 10
  if (validTraits.length > 10) {
    const overflow = validTraits.splice(10)
    for (const t of overflow) fallbackParts.push(`[${t.category}]:${t.value}`.slice(0, 200))
  }
  // 数量下限 2 (zod min(.min()) 已经校验, 这里兜底)
  while (validTraits.length < 2 && (obj.scene_aesthetic as string[] | undefined)?.length) {
    // 不够 2 条 → 从 scene_aesthetic 借一条 (LLM 把 scene 信息塞 trait 是常见错误)
    const sa = obj.scene_aesthetic as string[]
    if (sa.length) {
      validTraits.push({ category: 'body', value: sa.shift()! })
    } else {
      break
    }
  }

  // 4. scene_aesthetic 清洗 (截断到 5)
  const saRaw = Array.isArray(obj.scene_aesthetic) ? obj.scene_aesthetic : []
  const sceneAesthetic = saRaw.filter((s): s is string => typeof s === 'string').slice(0, 5)

  // 5. shot_type_ref fallback
  const shotTypeRaw = typeof obj.shot_type_ref === 'string' ? obj.shot_type_ref : ''
  let shotTypeRef: ShotTypeRef = '中景'
  if (SHOT_TYPE_REFS.includes(shotTypeRaw as ShotTypeRef)) {
    shotTypeRef = shotTypeRaw as ShotTypeRef
  } else if (shotTypeRaw) {
    // LLM 输出了非法 shot_type_ref (例如 '中近景') → fallback 中景 + log warn
    logTaskWarn('LLMSchemaValidator', 'shot-type-ref-fallback', {
      episodeId: ctx.episodeId,
      shotNumber: ctx.shotNumber,
      rawShotTypeRef: shotTypeRaw,
      fallback: '中景',
      hint: 'shot_type_ref 必须在 SHOT_TYPE_REFS (全景/中景/近景/特写) 内, 否则 fallback 中景',
    })
    fallbackParts.push(`[shot_type_ref]:${shotTypeRaw}`)
  }

  // angle / movement (string, 任意)
  const angle = typeof obj.angle === 'string' ? obj.angle : ''
  const movement = typeof obj.movement === 'string' ? obj.movement : ''

  const imagePromptPermanent = {
    character_traits: validTraits,
    scene_aesthetic: sceneAesthetic,
    shot_type_ref: shotTypeRef,
    angle,
    movement,
  }

  if (fallbackParts.length) {
    logTaskWarn('LLMSchemaValidator', 'permanent-fallback', {
      episodeId: ctx.episodeId,
      shotNumber: ctx.shotNumber,
      fallbackContent: fallbackParts.join(' | ').slice(0, 500),
      severity: 'config_drift',
      hint: 'V3 enum 5 维外的内容自动移到 plot_state, 用户后续可在 UI 调整 (Sprint 9 V4 wizard 提供 review 入口)',
    })
  }

  return { imagePromptPermanent, plotState: fallbackParts.join(' | ').slice(0, 200) }
}

/**
 * 把 V3 结构化 image_prompt_permanent 对象拼接成 imagePrompt 文本段
 * (跟 V2 拼接公式兼容, 下游 imagePrompt / videoPrompt 主串不变)。
 *
 * 例子输出: "中景平视推镜。年龄35岁, 长方脸, 短发。现代都市室内风格。"
 */
export function permanentToText(
  perm: z.infer<typeof V3ImagePromptPermanentSchema>,
): string {
  const parts: string[] = []
  // 拼接顺序 (sprint 41 QA msg-20261012-041): 物理外貌 → 场景氛围 → 摄影参数
  // 用户读起来先看剧情内容, 后看摄影配置, 避免把 prompt 误判为'跟剧情无关'
  // character_traits (例如 "年龄35岁, 长方脸, 短发")
  const traitParts = perm.character_traits.map(t => t.value).filter(Boolean)
  if (traitParts.length) parts.push(traitParts.join(' | '))
  // scene_aesthetic (例如 "现代都市室内风格")
  if (perm.scene_aesthetic.length) parts.push(perm.scene_aesthetic.join(' '))
  // 摄影参数 (放最后, 视觉上像技术配置附录, 不抢剧情内容注意力)
  if (perm.shot_type_ref) parts.push(perm.shot_type_ref)
  if (perm.angle) parts.push(perm.angle)
  if (perm.movement) parts.push(perm.movement)
  return parts.join('。')
}

// ─── Character 5 维 enum (ISSUE-023) ─────────────────────────────────────

/**
 * Permanent trait 单条 schema — 5 维 enum 强约束
 * 跨剧情通用: age / face / hair / body / outfit
 */
export const V3PermanentTraitItemSchema = z.object({
  category: z.enum(PERMANENT_TRAITS_CATEGORIES),
  value: z.string().max(50),
})

/**
 * permanent_traits 完整 schema — 2-10 项 5 维 enum 结构化数组
 * 跟 V3ImagePromptPermanentSchema.character_traits 同源, V3 character 治本扩面 (ISSUE-023) 复用
 */
export const V3PermanentTraitsSchema = z.array(V3PermanentTraitItemSchema).min(2).max(10)

/**
 * permanent_outfit 完整 schema — 自由 string 数组, 每项 max 50 字, max 10 项
 * 服装描述不需 enum (材质/款式/颜色变化多), 但限长防 prompt 污染
 */
export const V3PermanentOutfitSchema = z.array(z.string().max(50)).max(10)

/**
 * permanent_traits salvage — 跟 salvageImagePromptPermanent 同源
 *
 * 当 LLM 输出 category 不在 5 维 enum (例如 'clothing/accessory/eyebrows') 或 value 含 plot_state 关键词
 * (反转/狂笑/按按钮/后期/虚弱 等) 时, 整条移到 description 字段 + logTaskWarn.
 *
 * 返回 { permanent_traits: 清洗后 enum 数组, fallbackDescription: 拼接后的 description 追加内容 }
 */
export function salvagePermanentTraits(
  raw: unknown,
  ctx: { dramaId: number; characterName: string },
): { permanent_traits: z.infer<typeof V3PermanentTraitsSchema>; fallbackDescription: string } {
  const fallbackParts: string[] = []

  if (!Array.isArray(raw)) {
    return { permanent_traits: [], fallbackDescription: '' }
  }

  const valid: { category: PermanentTraitsCategory; value: string }[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const item = t as { category?: unknown; value?: unknown }
    const cat = typeof item.category === 'string' ? item.category : ''
    const val = typeof item.value === 'string' ? item.value : ''
    if (!PERMANENT_TRAITS_CATEGORIES.includes(cat as PermanentTraitsCategory)) {
      // 非法 category → 整条移到 description
      fallbackParts.push(`[${cat || 'unknown'}]:${val}`.slice(0, 200))
      continue
    }
    if (val.length > 50) {
      valid.push({ category: cat as PermanentTraitsCategory, value: val.slice(0, 50) })
    } else {
      valid.push({ category: cat as PermanentTraitsCategory, value: val })
    }
  }

  // 数量上限 10
  if (valid.length > 10) {
    const overflow = valid.splice(10)
    for (const t of overflow) fallbackParts.push(`[${t.category}]:${t.value}`.slice(0, 200))
  }

  if (fallbackParts.length) {
    logTaskWarn('LLMSchemaValidator', 'character-permanent-fallback', {
      dramaId: ctx.dramaId,
      characterName: ctx.characterName,
      fallbackContent: fallbackParts.join(' | ').slice(0, 500),
      severity: 'config_drift',
      hint: 'V3 character 5 维 enum 外的 category 或 value 自动移到 description 字段, 用户后续可在 UI 调整',
    })
  }

  return { permanent_traits: valid, fallbackDescription: fallbackParts.join(' | ').slice(0, 300) }
}

/**
 * permanent_outfit salvage — string 数组每项截断到 50 字, max 10 项
 * outfit 是 free-text 描述不需 enum, 但限长防 prompt 污染
 */
export function salvagePermanentOutfit(
  raw: unknown,
  ctx: { dramaId: number; characterName: string },
): string[] {
  if (!Array.isArray(raw)) return []
  const valid: string[] = []
  const overflow: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    if (item.length === 0) continue
    if (valid.length < 10) {
      valid.push(item.slice(0, 50))
    } else {
      overflow.push(item.slice(0, 50))
    }
  }
  if (overflow.length) {
    logTaskWarn('LLMSchemaValidator', 'character-outfit-overflow', {
      dramaId: ctx.dramaId, characterName: ctx.characterName,
      overflowCount: overflow.length,
      hint: 'permanent_outfit 超 10 项, 多余的丢弃 (LLM 误生成)',
    })
  }
  return valid
}

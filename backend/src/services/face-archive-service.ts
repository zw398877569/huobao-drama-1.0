/**
 * face-archive service — Sprint 5 PM msg-20260929-002 Task D + F
 *
 * 数据源: face_type_entries 表 (schema.ts, index manual-2026-09-29-face-type-entries.sql)
 * 注入位置:
 *   - src/routes/characters.ts imagePrompt 拼接 (code-side 1-2 条精选)
 *   - src/agents/tools/grid-prompt-tools.ts generateCharacterPrompt (LLM-side few-shot 5-8 条)
 *
 * 设计要点:
 *   - code-side: 确定性, 1-2 条精选 (latest archivedAt DESC), 不让 LLM 漂
 *   - LLM-side: 多样性, ORDER BY RANDOM() (用户拍板 D3), 5-8 条跨风格
 *   - 双层注入解耦 — code-side 保 base style 不变, LLM-side 给 cross-style reference 让 LLM 原创但风格对齐
 *   - 评估钩子 logFewshotSelection 记录每次选中条目 ID, QA/PM 可查 logs/YYYY-MM-DD/flow-<traceId>.jsonl
 *
 * user_decisions_locked (PM msg-20260929-002):
 *   D2_diversity_constraint: 软约束 (LLM prompt 写倾向性), 不做硬约束 (后端相似度校验不算)
 *   D3_order_by_strategy:    ORDER BY RANDOM() + logTaskProgress 钩子 + 用户人工抽检
 *   D4_negative_fewshot:     反例 few-shot 不做, 走正向 5-8 条 cross-style reference
 */
import { eq, desc, sql, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { logTaskProgress } from '../utils/task-logger.js'

export interface FaceEntry {
  id: number
  factor: string
  externalId: string
  name: string
  nameEn: string | null
  gender: string | null
  promptTokens: string | null
  data: Record<string, unknown>
}

export interface DramaContext {
  id: number
  style?: string | null
  characterAesthetic?: string | null
}

export interface CharacterContext {
  id: number
  name: string
  personality?: string | null
  dramaId: number
  appearancePermanent?: string | null
  appearance?: string | null
}

/**
 * Code-side 精选 — 1-2 条最新采集条目
 * 用途: 跟 aestheticTokens 并列硬拼进 imagePrompt (characters.ts)
 * 策略: ORDER BY archived_at DESC LIMIT n (最新采集优先)
 */
export function selectForCodeSide(_drama: DramaContext, _character: CharacterContext, n = 2): FaceEntry[] {
  const rows = db.select({
    id: schema.faceTypeEntries.id,
    factor: schema.faceTypeEntries.factor,
    externalId: schema.faceTypeEntries.externalId,
    name: schema.faceTypeEntries.name,
    nameEn: schema.faceTypeEntries.nameEn,
    gender: schema.faceTypeEntries.gender,
    promptTokens: schema.faceTypeEntries.promptTokens,
    data: schema.faceTypeEntries.data,
  })
    .from(schema.faceTypeEntries)
    .orderBy(desc(schema.faceTypeEntries.archivedAt))
    .limit(n)
    .all()

  return rows.map(parseFaceEntry)
}

/**
 * LLM-side few-shot 精选 — 5-8 条 ORDER BY RANDOM()
 * 用途: grid-prompt-tools.ts generateCharacterPrompt 返回的 prompt + 附加 fewshotReferences 列表
 * 策略: ORDER BY RANDOM() (用户拍板 D3), n 默认 8
 * 注意: SQLite better-sqlite3 不支持 RANDOM() seed, 每次随机
 */
export function selectForLLMFewshot(_drama: DramaContext, _character: CharacterContext, n = 8): FaceEntry[] {
  const rows = db.select({
    id: schema.faceTypeEntries.id,
    factor: schema.faceTypeEntries.factor,
    externalId: schema.faceTypeEntries.externalId,
    name: schema.faceTypeEntries.name,
    nameEn: schema.faceTypeEntries.nameEn,
    gender: schema.faceTypeEntries.gender,
    promptTokens: schema.faceTypeEntries.promptTokens,
    data: schema.faceTypeEntries.data,
  })
    .from(schema.faceTypeEntries)
    .orderBy(sql`RANDOM()`)
    .limit(n)
    .all()

  return rows.map(parseFaceEntry)
}

/**
 * 把 face-archive 条目拼成 imagePrompt 末尾 token
 * 格式: '【风格参考: ${name} (${nameEn}): ${promptTokens}】'
 * 多条用 ', ' 串联
 *
 * 例如 (2 条):
 *   '【风格参考: 鹅蛋脸 (Oval Face): soft jawline, gentle cheekbones...】,
 *    【风格参考: 黑色直发 (Straight Black Hair): long sleek black hair falling past shoulders...】'
 */
export function formatCodeSideTokens(entries: FaceEntry[]): string {
  if (!entries.length) return ''
  return entries.map((e) => {
    const nameLabel = e.nameEn ? `${e.name} (${e.nameEn})` : e.name
    const tokens = e.promptTokens || (e.data && typeof e.data.prompt_tokens === 'string' ? e.data.prompt_tokens : '')
    return `【风格参考: ${nameLabel}: ${tokens}】`
  }).join(', ')
}

/**
 * Few-shot 文本 — 给 LLM-side reference list (cross-style, prompt 提示"原创不复制")
 * 格式: '- [Face] 鹅蛋脸 (Oval Face): soft jawline...\n- [Hair] 黑色直发...'
 */
export function formatFewShotList(entries: FaceEntry[]): string {
  if (!entries.length) return ''
  return entries.map((e) => {
    const tokens = e.promptTokens || (e.data && typeof e.data.prompt_tokens === 'string' ? e.data.prompt_tokens : '')
    const label = e.nameEn ? `${e.name} (${e.nameEn})` : e.name
    return `- [${e.factor}] ${label}: ${tokens}`
  }).join('\n')
}

/**
 * logTaskProgress 评估钩子 — 记录每次 few-shot/code-side 选中条目 ID
 * QA/PM 可查 logs/YYYY-MM-DD/flow-<traceId>.jsonl 找 'face-archive-selection' 事件
 *
 * meta 字段:
 *   traceId (后续可加 ALS 拿, 现在 traceId 由调用方传)
 *   scope: 'face-archive-selection'
 *   action: 'code-side' | 'llm-fewshot'
 *   dramaId, characterId
 *   entryIds: [number]   (用于反查)
 *   entryNames: [string] (用户肉眼抽检)
 *   entryPromptTokens: [string] (用于人工评估)
 */
export function logFewshotSelection(opts: {
  scope: 'code-side' | 'llm-fewshot'
  dramaId: number
  characterId: number
  entries: FaceEntry[]
  traceId?: string
}): void {
  const { scope, dramaId, characterId, entries, traceId } = opts
  const meta: Record<string, unknown> = {
    dramaId,
    characterId,
    selectionReason: scope,
    entryIds: entries.map((e) => e.id),
    entryNames: entries.map((e) => e.name),
    entryPromptTokens: entries.map((e) => e.promptTokens ?? null),
  }
  if (traceId) meta.traceId = traceId
  logTaskProgress('face-archive', 'pick', {
    action: scope,
    ...meta,
  })
}

// ─── helpers ────────────────────────────────────────────────

function parseFaceEntry(r: {
  id: number
  factor: string
  externalId: string
  name: string
  nameEn: string | null
  gender: string | null
  promptTokens: string | null
  data: string
}): FaceEntry {
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(r.data) } catch { /* keep empty */ }
  return {
    id: r.id,
    factor: r.factor,
    externalId: r.externalId,
    name: r.name,
    nameEn: r.nameEn,
    gender: r.gender,
    promptTokens: r.promptTokens,
    data,
  }
}

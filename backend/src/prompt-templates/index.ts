/**
 * Sprint 19 (PM msg-20261025-082) —— prompt 模板注册表。
 *
 * 用法:
 *   const tpl = getTemplate(templateId || DEFAULT_TEMPLATE_ID)
 *   const tpl2 = getEpisodeTemplate(episodeId)   // 按 episodes.prompt_template 查
 *
 * ⚠️ 未知 id 【必须抛错】, 不能静默 fallback 到 general —— 拼错 id 会静默用错模板,
 *   等于"看起来选了新模板, 实际跑的是老模板", 极难查 (PM Task A/C 明确要求)。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generalTemplate } from './general.js'
import { minimaxH3Template } from './minimax-h3.js'
import type { PromptTemplate } from './types.js'

/**
 * 默认 prompt 模板 —— PM 2026-10-27 拍板 (msg-20261027-112): 从 'general' 改成 'minimax-h3'。
 * general 模板【保留】—— 用户仍可在分步拆解向导里手动切回「通用」。
 *
 * ⚠️ 光改这里【不够】: episodes.prompt_template 列是 TEXT NOT NULL DEFAULT 'general',
 *    新建 episode 时数据库默认值会先落库 → getEpisodeTemplateId 读到的是 'general'。
 *    所以新建路径 (routes/episodes.ts + routes/dramas.ts) 必须显式写这个默认值,
 *    列默认值 (db/schema.ts + db/index.ts 的 ensureColumn) 也要同步改 —— 见 112 单 handoff。
 */
export const DEFAULT_TEMPLATE_ID = 'minimax-h3'

const registry = new Map<string, PromptTemplate>()
registry.set(generalTemplate.id, generalTemplate)
// Sprint 23 Task A: MiniMax H3 官方格式模板 (★ Sprint 25: 已是默认模板, general 保留可手动切回)
registry.set(minimaxH3Template.id, minimaxH3Template)

export function listTemplates(): PromptTemplate[] {
  return [...registry.values()]
}

export function getTemplate(id: string): PromptTemplate {
  const tpl = registry.get(id)
  if (!tpl) {
    throw new Error(`未知的 prompt 模板 id: "${id}" (可用: ${[...registry.keys()].join(', ')})`)
  }
  return tpl
}

/** 解析传入的模板 id —— 空值用默认, 未知 id 抛错 */
export function resolveTemplateId(id: string | null | undefined): string {
  const tid = (id || '').trim() || DEFAULT_TEMPLATE_ID
  if (!registry.has(tid)) {
    throw new Error(`未知的 prompt 模板 id: "${tid}" (可用: ${[...registry.keys()].join(', ')})`)
  }
  return tid
}

// ─── 按 episode 查模板 (episodes.prompt_template) ──────────────────────────

const episodeTemplateCache = new Map<number, string>()

export function getEpisodeTemplateId(episodeId: number | null | undefined): string {
  if (!episodeId) return DEFAULT_TEMPLATE_ID
  const cached = episodeTemplateCache.get(episodeId)
  if (cached) return cached
  let id = DEFAULT_TEMPLATE_ID
  try {
    const [ep] = db.select({ tpl: schema.episodes.promptTemplate })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
      .all()
    id = (ep?.tpl || '').trim() || DEFAULT_TEMPLATE_ID
  } catch {
    // episodes.prompt_template 列还没建 (Task C 的迁移没跑) / DB 异常 → 用默认模板, 不阻断主流程
    id = DEFAULT_TEMPLATE_ID
  }
  episodeTemplateCache.set(episodeId, id)
  return id
}

export function getEpisodeTemplate(episodeId: number | null | undefined): PromptTemplate {
  return getTemplate(getEpisodeTemplateId(episodeId))
}

/** 模板选择变了要清缓存 (Task C 的 API 落库后调用) */
export function invalidateEpisodeTemplateCache(episodeId?: number): void {
  if (episodeId === undefined) episodeTemplateCache.clear()
  else episodeTemplateCache.delete(episodeId)
}

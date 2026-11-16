/**
 * 剧本改写 Agent 工具
 * 工厂函数模式 — 注入 episodeId，工具不再需要 LLM 传递 ID
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index'
// ★ Sprint 48 T3 (PM msg-20261116-194): 改写阶段要拿到【本集目标时长】并据此控制内容密度
import { computeRewriteCapacity, formatRewriteCapacity } from '../../constants/rewrite-capacity.js'
// ★ 目标时长来源与拆解阶段【同一个】(用户手设的优先, 否则自动估算)
import { getEpisodeTargetSeconds } from '../../services/shot-duration.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response'

export function createScriptTools(episodeId: number) {
  const readEpisodeScript = createTool({
    id: 'read_episode_script',
    description: 'Read the script content of the current episode.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: `Episode not found (id=${episodeId})` }
      const content = ep.content || ep.scriptContent
      if (!content) return { error: `Episode has no content (id=${episodeId})` }
      return { content, word_count: content.length, episode_id: episodeId }
    },
  })

  const rewriteToScreenplay = createTool({
    id: 'rewrite_to_screenplay',
    description: 'Read the original content for AI rewriting. Returns the source text with formatting instructions.',
    inputSchema: z.object({
      instructions: z.string().optional().describe('Additional rewrite instructions'),
    }),
    execute: async ({ instructions }) => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: `Episode not found` }
      const source = ep.content || ep.scriptContent
      if (!source) return { error: `Episode has no content to rewrite` }

      // ★ Sprint 48 T3: 本集目标时长 (用户手设优先, 否则自动估算 —— 与拆解阶段同源)
      const cap = computeRewriteCapacity(getEpisodeTargetSeconds(episodeId))
      return {
        source_content: source,
        instruction: `请将以下内容改写为格式化剧本。

格式规范：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 ${cap.sceneSecondsMin}-${cap.sceneSecondsMax} 秒内容

${formatRewriteCapacity(cap)}

【改写质量自检(提交前必须跑一遍, 不通过就重写那一段)】
1) 第一幕前 3 秒:有钩子吗?
2) 场景数 ${cap.sceneCountMin}-${cap.sceneCountMax} 个?每个 ${cap.sceneSecondsMin}-${cap.sceneSecondsMax} 秒?
3) 对白占比:每个场景内对白行数 ≥ 动作行数 × 1.5?
4) 冲突密度:每 ${cap.conflictIntervalSec} 秒至少 1 处对撞/打断/反转?
5) 结尾:未解之谜/反转预兆/危机升级 至少 1 个?
6) 格式:无镜头语言/无时间码/无章节标记?
7) 角色名:对白里的角色名与原文一致?前后一致?
8) ★ 对白总字数 ≤ ${cap.dialogueCharCap} 字?超了要删动作描写/合并场景, 【不许压缩台词本身】
   (台词超量 → 拆解时装不下 → 会被迫截台词, 用户听成片会觉得"台词少了很多")

${instructions || ''}

【原始内容】
${source}`,
      }
    },
  })

  const saveScript = createTool({
    id: 'save_script',
    description: 'Save the rewritten screenplay content to the current episode.',
    inputSchema: z.object({
      content: z.string().describe('The formatted screenplay content to save'),
    }),
    execute: async ({ content }) => {
      db.update(schema.episodes)
        .set({ scriptContent: content, updatedAt: now() })
        .where(eq(schema.episodes.id, episodeId))
        .run()
      return { message: `Script saved`, word_count: content.length }
    },
  })

  return { readEpisodeScript, rewriteToScreenplay, saveScript }
}

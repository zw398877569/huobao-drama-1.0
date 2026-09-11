/**
 * 角色/场景提取 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 *
 * 单 Agent 一步流程：
 * 1. 读取剧本内容
 * 2. 读取项目中已存在的角色/场景（用于去重）
 * 3. 提取角色/场景并智能去重后直接保存
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index'
import { eq, and } from 'drizzle-orm'
import { now } from '../../utils/response'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger'

// ─── 关联辅助 ────────────────────────────────────────────────
function linkCharToEpisode(episodeId: number, characterId: number) {
  const ts = now()
  const existing = db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))
    .all()
  if (!existing.length) {
    db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  }
}

function linkSceneToEpisode(episodeId: number, sceneId: number) {
  const ts = now()
  const existing = db.select().from(schema.episodeScenes)
    .where(and(eq(schema.episodeScenes.episodeId, episodeId), eq(schema.episodeScenes.sceneId, sceneId)))
    .all()
  if (!existing.length) {
    db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
  }
}

function linkPropToEpisode(episodeId: number, propId: number, appearanceWeight: string) {
  const ts = now()
  const existing = db.select().from(schema.episodeProps)
    .where(and(eq(schema.episodeProps.episodeId, episodeId), eq(schema.episodeProps.propId, propId)))
    .all()
  if (existing.length) {
    // 升级出现强度 (minor -> major -> critical),不降级
    const order: Record<string, number> = { minor: 1, major: 2, critical: 3 }
    const cur = order[existing[0].appearanceWeight || 'minor'] || 1
    const upd = order[appearanceWeight] || 1
    if (upd > cur) {
      db.update(schema.episodeProps).set({ appearanceWeight })
        .where(eq(schema.episodeProps.id, existing[0].id)).run()
    }
    return
  }
  db.insert(schema.episodeProps).values({ episodeId, propId, appearanceWeight, createdAt: ts }).run()
}

export function createExtractTools(episodeId: number, dramaId: number) {

  // 1. 读取剧本内容
  const readScriptForExtraction = createTool({
    id: 'read_script_for_extraction',
    description: 'Read the formatted screenplay for character/scene extraction.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const content = ep.scriptContent || ep.content
      if (!content) return { error: 'Episode has no script content' }
      logTaskSuccess('ExtractTool', 'read-script', { episodeId, dramaId, scriptLength: content.length })
      return { script: content }
    },
  })

  // 2. 读取项目中已存在的角色（用于去重判断）
  const readExistingCharacters = createTool({
    id: 'read_existing_characters',
    description: 'Read all characters already existing in this drama project (for deduplication).',
    inputSchema: z.object({}),
    execute: async () => {
      const linkedIds = new Set(
        db.select().from(schema.episodeCharacters)
          .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
          .map(link => link.characterId),
      )
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
        .filter(c => !c.deletedAt)
      const payload = {
        count: chars.length,
        characters: chars,
        current_episode_characters: chars.filter(c => linkedIds.has(c.id)),
      }
      logTaskSuccess('ExtractTool', 'read-characters', {
        episodeId,
        dramaId,
        projectCharacters: payload.count,
        episodeCharacters: payload.current_episode_characters.length,
      })
      return payload
    },
  })

  // 3. 读取项目中已存在的关键道具（用于去重判断）— 2026-09-10
  const readExistingProps = createTool({
    id: 'read_existing_props',
    description: 'Read all key props already existing in this drama project (for deduplication).',
    inputSchema: z.object({}),
    execute: async () => {
      const linkedIds = new Set(
        db.select().from(schema.episodeProps)
          .where(eq(schema.episodeProps.episodeId, episodeId)).all()
          .map(link => link.propId),
      )
      const props = db.select().from(schema.props)
        .where(eq(schema.props.dramaId, dramaId)).all()
        .filter(p => !p.deletedAt)
      const payload = {
        count: props.length,
        props,
        current_episode_props: props.filter(p => linkedIds.has(p.id)),
      }
      logTaskSuccess('ExtractTool', 'read-props', {
        episodeId,
        dramaId,
        projectProps: payload.count,
        episodeProps: payload.current_episode_props.length,
      })
      return payload
    },
  })

  // 4. 读取项目中已存在的场景（用于去重判断）
  const readExistingScenes = createTool({
    id: 'read_existing_scenes',
    description: 'Read all scenes already existing in this drama project (for deduplication).',
    inputSchema: z.object({}),
    execute: async () => {
      const linkedIds = new Set(
        db.select().from(schema.episodeScenes)
          .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
          .map(link => link.sceneId),
      )
      const scenes = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
        .filter(s => !s.deletedAt)
      const payload = {
        count: scenes.length,
        scenes,
        current_episode_scenes: scenes.filter(s => linkedIds.has(s.id)),
      }
      logTaskSuccess('ExtractTool', 'read-scenes', {
        episodeId,
        dramaId,
        projectScenes: payload.count,
        episodeScenes: payload.current_episode_scenes.length,
      })
      return payload
    },
  })

  // 5. 智能保存角色（按名字去重，与现有数据合并）
  const saveDedupCharacters = createTool({
    id: 'save_dedup_characters',
    description: 'Save extracted characters with deduplication. Existing characters (same name) are merged/updated; new ones are created. All are linked to the current episode.',
    inputSchema: z.object({
      characters: z.array(z.object({
        name: z.string(),
        role: z.string().optional(),
        description: z.string().optional(),
        appearance: z.string().optional(),
        personality: z.string().optional(),
      })),
    }),
    execute: async ({ characters }) => {
      const ts = now()
      const results = { created: 0, merged: 0 }
      logTaskProgress('ExtractTool', 'save-characters-begin', {
        episodeId,
        dramaId,
        names: characters.map(char => char.name).join(','),
      })

      for (const char of characters) {
        const existing = db.select().from(schema.characters)
          .where(eq(schema.characters.dramaId, dramaId)).all()
          .filter(c => !c.deletedAt)
          .find(c => c.name === char.name)

        if (existing) {
          // 已存在：合并信息，保留 ID
          db.update(schema.characters).set({
            role: char.role || existing.role,
            description: char.description || existing.description,
            appearance: char.appearance || existing.appearance,
            personality: char.personality || existing.personality,
            updatedAt: ts,
          }).where(eq(schema.characters.id, existing.id)).run()
          linkCharToEpisode(episodeId, existing.id)
          results.merged++
        } else {
          // 新增角色
          const res = db.insert(schema.characters).values({
            name: char.name,
            role: char.role || '',
            description: char.description || '',
            appearance: char.appearance || '',
            personality: char.personality || '',
            dramaId,
            createdAt: ts,
            updatedAt: ts,
          }).run()
          const charId = Number(res.lastInsertRowid)
          linkCharToEpisode(episodeId, charId)
          results.created++
        }
      }

      const payload = {
        message: `角色保存完成：新增 ${results.created}，合并更新 ${results.merged}`,
        ...results,
      }
      logTaskSuccess('ExtractTool', 'save-characters-complete', { episodeId, ...results })
      return payload
    },
  })

  // 6. 智能保存场景（按地点+时间段去重，与现有数据合并）
  const saveDedupScenes = createTool({
    id: 'save_dedup_scenes',
    description: 'Save extracted scenes with deduplication. Existing scenes (same location+time) are reused; new ones are created. All are linked to the current episode.',
    inputSchema: z.object({
      scenes: z.array(z.object({
        location: z.string(),
        time: z.string().optional(),
        prompt: z.string().optional(),
      })),
    }),
    execute: async ({ scenes }) => {
      const ts = now()
      const results = { created: 0, reused: 0 }
      logTaskProgress('ExtractTool', 'save-scenes-begin', {
        episodeId,
        dramaId,
        scenes: scenes.map(scene => `${scene.location}@${scene.time || ''}`).join(','),
      })

      for (const scene of scenes) {
        // 按地点+时间段精确匹配
        const existing = db.select().from(schema.scenes)
          .where(eq(schema.scenes.dramaId, dramaId)).all()
          .filter(s => !s.deletedAt)
          .find(s => s.location === scene.location && s.time === (scene.time || ''))

        if (existing) {
          // 已存在完全匹配的场景：直接关联
          linkSceneToEpisode(episodeId, existing.id)
          results.reused++
        } else {
          // 检查是否有同地点不同时段（保留现有，新增独立场景）
          const sameLocation = db.select().from(schema.scenes)
            .where(eq(schema.scenes.dramaId, dramaId)).all()
            .filter(s => !s.deletedAt)
            .find(s => s.location === scene.location)

          const res = db.insert(schema.scenes).values({
            dramaId,
            location: scene.location,
            time: scene.time || '',
            prompt: scene.prompt || scene.location,
            createdAt: ts,
            updatedAt: ts,
          }).run()
          const sceneId = Number(res.lastInsertRowid)
          linkSceneToEpisode(episodeId, sceneId)
          results.created++
        }
      }

      const payload = {
        message: `场景保存完成：新增 ${results.created}，复用已有 ${results.reused}`,
        ...results,
      }
      logTaskSuccess('ExtractTool', 'save-scenes-complete', { episodeId, ...results })
      return payload
    },
  })

  // 7. 智能保存关键道具（按 name + owner_character_id 去重）— 2026-09-10
  //    关键道具判据: 跨镜头反复出现 + 推动剧情 + 角色标志性 (信物/武器/随身工具/纪念品)
  //    不是: 纯场景装饰物(吧台/吊灯/椅子), 一次性物品(门铃响一下), 抽象概念
  const saveDedupProps = createTool({
    id: 'save_dedup_props',
    description: 'Save extracted key props with deduplication. Existing props (same name within same drama, optionally narrowed by owner_character) are merged/updated; new ones are created. All are linked to the current episode. Each prop must declare an owner_character (referenced by character name from extraction).',
    inputSchema: z.object({
      props: z.array(z.object({
        name: z.string(),
        type: z.string().optional(),                          // single=单一物, set=成套物
        description: z.string().optional(),                  // 外观详细描述 (材质/颜色/尺寸/状态/特殊标记)
        prompt: z.string().optional(),                        // 图像生成 prompt (用于 H3 Ref2V 参考图)
        owner_character: z.string().optional(),              // 归属于哪个角色 (角色名,会解析为 character_id)
        narrative_role: z.string().optional(),                // 信物 / 武器 / 随身工具 / 纪念品 / 服装配饰
        first_storyboard_number: z.number().optional(),      // 首次出现的镜头编号
        appearance_count: z.number().optional(),              // 在本集出现次数 (用于计算 appearance_weight)
      })),
    }),
    execute: async ({ props }) => {
      const ts = now()
      const results = { created: 0, merged: 0, skipped: 0 }
      logTaskProgress('ExtractTool', 'save-props-begin', {
        episodeId,
        dramaId,
        names: props.map(p => p.name).join(','),
      })

      // 先把所有角色加载到内存,按 name 查 id
      const allChars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
        .filter(c => !c.deletedAt)
      const charByName = new Map(allChars.map(c => [c.name, c.id]))

      for (const prop of props) {
        // 解析 owner_character_id (可能为空,如旁白类道具)
        let ownerId: number | null = null
        if (prop.owner_character) {
          ownerId = charByName.get(prop.owner_character) ?? null
          if (ownerId === null) {
            logTaskProgress('ExtractTool', 'prop-owner-unknown', {
              propName: prop.name, ownerName: prop.owner_character,
            })
          }
        }

        // 按 name + owner_character_id 组合去重 (同项目同名道具分归属角色)
        // 降级匹配: 已存在同名但 owner 为 null (LLM 第一次漏填), 视为同一条
        const existing = db.select().from(schema.props)
          .where(eq(schema.props.dramaId, dramaId)).all()
          .filter(p => !p.deletedAt)
          .find(p => p.name === prop.name && (
            p.ownerCharacterId === ownerId ||
            (ownerId != null && p.ownerCharacterId == null)
          ))

        if (existing) {
          // 已存在: 合并, 保留 ID, 累加出现次数
          const newCount = (existing as any).appearanceCount
            ? (existing as any).appearanceCount + (prop.appearance_count || 1)
            : (prop.appearance_count || 1)
          db.update(schema.props).set({
            type: prop.type || existing.type,
            description: prop.description || existing.description,
            prompt: prop.prompt || existing.prompt,
            narrativeRole: prop.narrative_role || existing.narrativeRole,
            firstStoryboardNumber: prop.first_storyboard_number ?? existing.firstStoryboardNumber,
            appearanceCount: newCount,
            updatedAt: ts,
          }).where(eq(schema.props.id, existing.id)).run()
          // 计算 appearance_weight
          const weight = newCount >= 9 ? 'critical' : newCount >= 4 ? 'major' : 'minor'
          linkPropToEpisode(episodeId, existing.id, weight)
          results.merged++
        } else {
          // 新增
          const res = db.insert(schema.props).values({
            dramaId,
            name: prop.name,
            type: prop.type || 'single',
            description: prop.description || '',
            prompt: prop.prompt || prop.description || '',
            ownerCharacterId: ownerId,
            narrativeRole: prop.narrative_role || '道具',
            firstStoryboardNumber: prop.first_storyboard_number || null,
            appearanceCount: prop.appearance_count || 1,
            createdAt: ts,
            updatedAt: ts,
          } as any).run()
          const propId = Number(res.lastInsertRowid)
          const count = prop.appearance_count || 1
          const weight = count >= 9 ? 'critical' : count >= 4 ? 'major' : 'minor'
          linkPropToEpisode(episodeId, propId, weight)
          results.created++
        }
      }

      const payload = {
        message: `关键道具保存完成：新增 ${results.created}，合并更新 ${results.merged}，跳过 ${results.skipped}`,
        ...results,
      }
      logTaskSuccess('ExtractTool', 'save-props-complete', { episodeId, ...results })
      return payload
    },
  })

  return {
    readScriptForExtraction,
    readExistingCharacters,
    readExistingScenes,
    readExistingProps,
    saveDedupCharacters,
    saveDedupScenes,
    saveDedupProps,
  }
}

/**
 * 分镜拆解 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index'
import { eq, and, isNull } from 'drizzle-orm'
import { now } from '../../utils/response'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger'
import { getPresetByStyle, getStylePreset } from '../../services/negative-prompt-presets'
// Import scene intention analysis function and templates
import { analyzeSceneIntentionForScene } from '../scene-intention'
import { applyQualityChecklist } from '../../services/prompt-quality'
import { validateEventDensity } from '../../services/prompt-validation'
import { checkPromptSafety } from '../../services/prompt-safety'
import { autoFillSpeakerFromScript } from '../../utils/dialogue-parser'
import { INTENTION_TEMPLATES, type DramaticFunctionKey } from '../director-intent-templates'

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getEpisodeSceneIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
}

function getEpisodeCharacterIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = getEpisodeCharacterIds(episodeId)

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error(`scene_id ${sceneId} 不属于当前集`)
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error(`character_ids 不属于当前集: ${invalidCharacterIds.join(', ')}`)
  }
}

export function createStoryboardTools(episodeId: number, dramaId: number) {
  // 预计算自动反词：按 drama.style 匹配一次，整个会话复用
  const [drama] = db.select({ style: schema.dramas.style })
    .from(schema.dramas)
    .where(eq(schema.dramas.id, dramaId)).all()
  const autoNegativePrompt = getPresetByStyle(drama?.style).prompt
  const stylePreset = getStylePreset(drama?.style)

  const readStoryboardContext = createTool({
    id: 'read_storyboard_context',
    description: 'Read the screenplay, characters, and scenes for storyboard breakdown.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const script = ep.scriptContent || ep.content
      if (!script) return { error: 'Episode has no script' }

      const charLinks = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const sceneLinks = db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, episodeId)).all()

      const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
      const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))

      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const scns = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
      const existingStoryboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()

      const characters = chars
        .filter(c => !c.deletedAt)
        .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
        .map(c => ({
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
          voice_style: c.voiceStyle || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
        }))

      const scenes = scns
        .filter(s => !s.deletedAt)
        .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
        .map(s => ({
          id: s.id,
          location: s.location,
          time: s.time,
          prompt: s.prompt || '',
          image_url: s.imageUrl || '',
          storyboard_count: s.storyboardCount || 0,
        }))

      // === Add scene intention analysis for director engine ===
      // Get all episode characters to use as context for each scene
      const episodeCharacters = chars.filter(c => !c.deletedAt);
      const characterNames = episodeCharacters.map(c => c.name);

      // Analyze intentions for each scene in parallel (fire and forget for speed)
      const enhancedScenes = await Promise.all(
        scenes.map(async (scene) => {
          try {
            // Analyze the dramatic intention of this scene
            const intentionResult = await analyzeSceneIntentionForScene({
              location: scene.location,
              time: scene.time,
              characters: characterNames.length > 0 ? characterNames : ['未知角色'],
              action: '',
              description: scene.prompt,
            });

            // Get the template for visual strategy guidance (includes cameraSpeed, shortDramaTips etc.)
            const template = INTENTION_TEMPLATES[intentionResult.function] || INTENTION_TEMPLATES['铺垫'];

            // Build intention object enriched with template data (cameraSpeed, shortDramaTips)
            const intention = {
              intention: intentionResult.intention,
              function: intentionResult.function,
              visualStrategy: intentionResult.visualStrategy,
              cameraSpeed: template.cameraSpeed || '',
              shortDramaTips: template.shortDramaTips || '',
            };

            return {
              ...scene,
              intention,
              intentionTemplate: template,
            };
          } catch (e) {
            console.warn(`Failed to analyze intention for scene ${scene.id}:`, e);
            const fallbackTemplate = INTENTION_TEMPLATES['铺垫'];
            const intention = {
              intention: '场景意图分析失败',
              function: '铺垫' as DramaticFunctionKey,
              visualStrategy: '请手动设定或稍后分析',
              cameraSpeed: fallbackTemplate.cameraSpeed || '',
              shortDramaTips: fallbackTemplate.shortDramaTips || '',
            };
            return {
              ...scene,
              intention,
              intentionTemplate: fallbackTemplate,
            };
          }
        })
      );
      logTaskProgress('StoryboardTool', 'intentions-analyzed', {
        sceneCount: enhancedScenes.length,
      });
      // ==============================================

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          description: ep.description || '',
        },
        script,
        characters,
        scenes: enhancedScenes, // Use enhanced scenes with intention data
        existing_storyboards: existingStoryboards
          .filter(sb => !sb.deletedAt)
          .map(sb => ({
            id: sb.id,
            shot_number: sb.storyboardNumber,
            title: sb.title || '',
            scene_id: sb.sceneId,
            character_ids: db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
              .map(link => link.characterId),
            shot_type: sb.shotType || '',
            duration: sb.duration || 0,
          })),
      }
      logTaskSuccess('StoryboardTool', 'read-context', {
        episodeId,
        dramaId,
        characters: characters.length,
        scenes: scenes.length,
        existingStoryboards: payload.existing_storyboards.length,
        scriptLength: script.length,
      })
      return payload
    },
  })

  const saveStoryboards = createTool({
    id: 'save_storyboards',
    description: 'Save generated storyboards. Replaces all existing storyboards for this episode.',
    inputSchema: z.object({
      storyboards: z.array(z.object({
        shot_number: z.number(),
        title: z.string().optional(),
        shot_type: z.string().optional(),
        angle: z.string().optional(),
        movement: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        action: z.string().optional(),
        dialogue: z.string().optional(),
        description: z.string().optional(),
        result: z.string().optional(),
        atmosphere: z.string().optional(),
        image_prompt: z.string().optional(),
        video_prompt: z.string().optional(),
        bgm_prompt: z.string().optional(),
        sound_effect: z.string().optional(),
        negative_prompt: z.string().optional(),
        duration: z.number().optional(),
        scene_id: z.number().nullable().optional(),
        character_ids: z.array(z.number()).optional(),
      })),
    }),
    execute: async ({ storyboards }) => {
      const ts = now()
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: storyboards.length,
        shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
      })
      const existingStoryboardIds = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .map(sb => sb.id)
      for (const storyboardId of existingStoryboardIds) {
        db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
          .run()
      }
      db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()

      let totalDuration = 0
      const densityWarnings: Array<{ shot_number: number; density: string; suggestion: string; events: string[] }> = []
      const safetyWarnings: Array<{ shot_number: number; flagged: boolean; notes: any[] }> = []
      for (const sb of storyboards) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const cleanedImage = applyQualityChecklist(sb.image_prompt, 'image').cleaned
        const cleanedVideo = applyQualityChecklist(sb.video_prompt, 'video').cleaned
        const densityResult = validateEventDensity(cleanedVideo)
        const safetyResult = checkPromptSafety(cleanedImage, 'image')
        const res = db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          action: sb.action, dialogue: sb.dialogue,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere,
          imagePrompt: safetyResult.cleaned,
          videoPrompt: cleanedVideo,
          bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          negativePrompt: sb.negative_prompt || autoNegativePrompt,
          eventDensity: densityResult.density,
          eventList: densityResult.events.length ? JSON.stringify(densityResult.events) : '',
          promptOriginal: safetyResult.flagged ? sb.image_prompt : '',
          safetyFlagged: safetyResult.flagged ? 1 : 0,
          safetyNotes: safetyResult.notes.length ? JSON.stringify(safetyResult.notes) : '',
          createdAt: ts, updatedAt: ts,
        }).run()
        syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
        totalDuration += sb.duration || 10
        if (densityResult.suggestion) {
          densityWarnings.push({
            shot_number: sb.shot_number,
            density: densityResult.density,
            suggestion: densityResult.suggestion,
            events: densityResult.events,
          })
        }
        if (safetyResult.flagged) {
          safetyWarnings.push({
            shot_number: sb.shot_number,
            flagged: true,
            notes: safetyResult.notes,
          })
        }
      }

      db.update(schema.episodes)
        .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
        .where(eq(schema.episodes.id, episodeId)).run()

      logTaskSuccess('StoryboardTool', 'save-complete', {
        episodeId,
        count: storyboards.length,
        totalDuration,
        densityWarnings: densityWarnings.length,
        safetyWarnings: safetyWarnings.length,
      })
      return {
        message: `Saved ${storyboards.length} storyboards`,
        count: storyboards.length,
        total_duration: totalDuration,
        density_warnings: densityWarnings,
        safety_warnings: safetyWarnings,
      }
    },
  })

  const updateStoryboard = createTool({
    id: 'update_storyboard',
    description: 'Update a specific storyboard shot.',
    inputSchema: z.object({
      storyboard_id: z.number(),
      title: z.string().optional(),
      shot_type: z.string().optional(),
      angle: z.string().optional(),
      movement: z.string().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      action: z.string().optional(),
      result: z.string().optional(),
      atmosphere: z.string().optional(),
      image_prompt: z.string().optional(),
      video_prompt: z.string().optional(),
      bgm_prompt: z.string().optional(),
      sound_effect: z.string().optional(),
      description: z.string().optional(),
      dialogue: z.string().optional(),
      scene_id: z.number().nullable().optional(),
      character_ids: z.array(z.number()).optional(),
      duration: z.number().optional(),
    }),
    execute: async ({ storyboard_id, ...fields }) => {
      const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
      if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
      // 单镜头增量时同样兜底: dialogue 缺前缀用 script_content 补回
      const [epRow] = db.select({ scriptContent: schema.episodes.scriptContent })
        .from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      const scriptContent = epRow?.scriptContent || ''
      logTaskProgress('StoryboardTool', 'update-begin', {
        episodeId,
        storyboardId: storyboard_id,
        fields: Object.keys(fields),
      })

      validateStoryboardBindings(
        episodeId,
        'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
        'character_ids' in fields
          ? fields.character_ids
          : db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
              .map(link => link.characterId),
      )

      const updates: Record<string, any> = { updatedAt: now() }
      if ('title' in fields) updates.title = fields.title
      if ('shot_type' in fields) updates.shotType = fields.shot_type
      if ('angle' in fields) updates.angle = fields.angle
      if ('movement' in fields) updates.movement = fields.movement
      if ('location' in fields) updates.location = fields.location
      if ('time' in fields) updates.time = fields.time
      if ('action' in fields) updates.action = fields.action
      if ('result' in fields) updates.result = fields.result
      if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
      if ('image_prompt' in fields) {
        const cleanedImage = applyQualityChecklist(fields.image_prompt, 'image').cleaned
        const safetyResult = checkPromptSafety(cleanedImage, 'image')
        updates.imagePrompt = safetyResult.cleaned
        if (safetyResult.flagged) {
          updates.promptOriginal = fields.image_prompt
          updates.safetyFlagged = 1
          updates.safetyNotes = JSON.stringify(safetyResult.notes)
        } else {
          updates.safetyFlagged = 0
          updates.safetyNotes = ''
          updates.promptOriginal = ''
        }
      }
      if ('video_prompt' in fields) {
        const cleanedVideo = applyQualityChecklist(fields.video_prompt, 'video').cleaned
        const densityResult = validateEventDensity(cleanedVideo)
        updates.videoPrompt = cleanedVideo
        updates.eventDensity = densityResult.density
        updates.eventList = densityResult.events.length ? JSON.stringify(densityResult.events) : ''
      }
      if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
      if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
      if ('description' in fields) updates.description = fields.description
      if ('dialogue' in fields) updates.dialogue = autoFillSpeakerFromScript(fields.dialogue, scriptContent)
      if ('scene_id' in fields) updates.sceneId = fields.scene_id
      if ('duration' in fields) updates.duration = fields.duration
      db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
      logTaskSuccess('StoryboardTool', 'update-complete', {
        episodeId,
        storyboardId: storyboard_id,
        updatedFields: Object.keys(updates),
        characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      })
      return { message: `Storyboard ${storyboard_id} updated` }
    },
  })

  // 为宫格图生成整体提示词（分析选中镜头的描述，生成一个连贯的画格布局描述）
  const generateGridPrompt = createTool({
    id: 'generate_grid_prompt',
    description: '为宫格图生成整体画面描述。根据选中的镜头列表及其描述，生成一个连贯的宫格图提示词，用于一次性生成完整的宫格拼图。',
    inputSchema: z.object({
      shots: z.array(z.object({
        shot_number: z.number(),
        description: z.string(),
        shot_type: z.string().optional(),
        dialogue: z.string().optional(),
      })),
      rows: z.number(),
      cols: z.number(),
      mode: z.string(), // 'first_frame' | 'first_last' | 'multi_ref'
    }),
    execute: async ({ shots, rows, cols, mode }) => {
      if (!shots.length) return { error: 'No shots provided' }
      logTaskProgress('StoryboardTool', 'grid-prompt-begin', {
        episodeId,
        shots: shots.length,
        rows,
        cols,
        mode,
      })

      if (mode === 'multi_ref') {
        const sb = shots[0]
        const payload = {
          grid_prompt: `${stylePreset.positiveShotTokens}，${sb.description}，专业摄影，4K分辨率，${rows}x${cols} 宫格统一风格参考图`,
          cell_prompts: shots.map(s => ({
            shot_number: s.shot_number,
            frame_type: 'reference',
            prompt: `${stylePreset.positiveShotTokens}，${s.description}，专业摄影，4K分辨率，统一风格`,
          })),
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      if (mode === 'first_last') {
        const cellPrompts = []
        for (const s of shots) {
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'first_frame',
            prompt: `${stylePreset.positiveShotTokens}，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'last_frame',
            prompt: `${stylePreset.positiveShotTokens}，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
        }
        const payload = {
          grid_prompt: `${shots.length}个镜头首尾帧拼图，${shots.map(s => s.description).join(' | ')}，${stylePreset.positiveShotTokens}，${rows}行${cols}列风格统一`,
          cell_prompts: cellPrompts,
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      // first_frame mode
      const cellPrompts = shots.slice(0, rows * cols).map(s => ({
        shot_number: s.shot_number,
        frame_type: 'first_frame',
        prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
      }))
      const payload = {
        grid_prompt: `${shots.length}个镜头首帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
        cell_prompts: cellPrompts,
      }
      logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
      return payload
    },
  })

  // 供 storyboard_planner agent 调用：接收结构 plan，生成 17 字段并批量写入 DB
  const generateShotPrompts = createTool({
    id: 'generate_shot_prompts',
    description: '接收规划好的 shot_plan（结构字段），为每个镜头生成完整 17 字段 image_prompt / video_prompt / bgm_prompt / sound_effect / negative_prompt 并批量保存。',
    inputSchema: z.object({
      shot_plan: z.array(z.object({
        shot_number: z.number(),
        scene_id: z.number(),
        character_ids: z.array(z.number()),
        shot_type: z.string(),
        angle: z.string(),
        movement: z.string(),
        location: z.string(),
        time: z.string(),
        duration: z.number(),
        action: z.string(),
        dialogue: z.string().optional(),
        description: z.string(),
        result: z.string(),
        atmosphere: z.string(),
        intent_function: z.string(),
      })),
    }),
    execute: async ({ shot_plan }) => runGenerateShotPrompts({ episodeId, dramaId, shot_plan }),
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt, generateShotPrompts }
}

/**
 * 直接调用（不走 LLM）：将 shot_plan 批量生成 prompt 并写入 DB。
 * 供 /agent/storyboard_breaker/execute 路由使用，绕过 agent 推理层。
 * @param keepExisting 是否保留已有 storyboards（默认 true，只追加/更新；设为 false 才全量覆盖）
 */
export async function runGenerateShotPrompts(params: {
  episodeId: number
  dramaId: number
  shot_plan: Array<{
    shot_number: number
    scene_id: number
    character_ids: number[]
    shot_type: string
    angle: string
    movement: string
    location: string
    time: string
    duration: number
    action: string
    dialogue?: string
    description: string
    result: string
    atmosphere: string
    intent_function: string
  }>
  keepExisting?: boolean
  onProgress?: (progress: { shot: number; total: number; status: string }) => void
}): Promise<{ count: number; total_duration: number; density_warnings: number; safety_warnings: number }> {
  const { episodeId, dramaId, shot_plan, keepExisting = true, onProgress } = params
  const ts = now()
  logTaskProgress('StoryboardTool', 'generate-shot-prompts-begin', {
    episodeId,
    dramaId,
    count: shot_plan.length,
    keepExisting,
  })

  // 读取 drama 风格 + 角色 + 场景
  const [drama] = db.select({ style: schema.dramas.style })
    .from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  const autoNegativePrompt = getPresetByStyle(drama?.style).prompt
  const stylePreset = getStylePreset(drama?.style)
  // 取 episode.script_content 当 dialogue speaker 反查源
  // commit 08c3dba 引入回归: planner 不带 speaker 前缀, 用这里兜底
  const [episodeRow] = db.select({ scriptContent: schema.episodes.scriptContent })
    .from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const scriptContent = episodeRow?.scriptContent || ''

  const chars = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt))).all()
  const scenes = db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.dramaId, dramaId), isNull(schema.scenes.deletedAt))).all()
  const charMap = new Map(chars.map(c => [c.id, c]))
  const sceneMap = new Map(scenes.map(s => [s.id, s]))

  // ── H3 感知 ──
  const videoConfigs = db.select({ label: schema.aiServiceConfigs.name, provider: schema.aiServiceConfigs.provider })
    .from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'video'))
    .orderBy(schema.aiServiceConfigs.priority)
    .all()
  const lockedVideoLabel = videoConfigs[0]?.label || ''
  const isH3 = /H3|minimax/i.test(lockedVideoLabel)

  // ── 处理已有 storyboards ──
  if (!keepExisting) {
    const existingIds = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .map(sb => sb.id)
    for (const id of existingIds) {
      db.delete(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, id)).run()
    }
    db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
  }

  let totalDuration = 0
  const densityWarnings: Array<{ shot_number: number; density: string; suggestion: string; events: string[] }> = []
  const safetyWarnings: Array<{ shot_number: number; flagged: boolean; notes: any[] }> = []

  for (const sp of shot_plan) {
    validateStoryboardBindings(episodeId, sp.scene_id, sp.character_ids)
    const scene = sceneMap.get(sp.scene_id)
    const charRefs = sp.character_ids.map(id => charMap.get(id)).filter((c): c is NonNullable<typeof c> => !!c)

    // 角色外观兜底
    const charDesc = charRefs.map(c => {
      const look = c.appearance ||
        c.description ||
        c.personality ||
        (() => {
          const roleLower = (c.role || c.name || '').toLowerCase()
          if (roleLower.includes('男') || roleLower.includes('man') || roleLower.includes('male')) return '男性'
          if (roleLower.includes('女') || roleLower.includes('woman') || roleLower.includes('female')) return '女性'
          return '人物'
        })()
      return `${c.name}外貌:${look}`
    }).join('；')

    // 场景参考图
    const sceneImgRef = scene?.imageUrl ? `参考图:场景[${scene.location} · ${scene.imageUrl}]，` : ''
    // H3 感知 hint
    const h3ImageHint = isH3
      ? '下游视频模型:H3 — 此图为分镜首/尾帧参考；构图需稳定单一主体+半身/全身景别+自然光影+半写实电影感;避免极端运镜、动作模糊、文字水印、多余人物。'
      : ''
    const sceneLight = scene?.prompt
      ? `场景:${scene.location}${scene.time}，${scene.prompt}`
      : `地点:${sp.location}，时间:${sp.time}`
    const imagePrompt = `${charDesc}。${sceneImgRef}${sceneLight}。${sp.description}。${stylePreset.positiveShotTokens}，${sp.atmosphere || ''}，${h3ImageHint}no text, no watermark`

    // 对白转义 + H3 格式
    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const safeDialogue = escapeXml(sp.dialogue || '')
    const dialogueTag = safeDialogue ? `<d>${safeDialogue}</d>` : ''

    const durationSec = sp.duration || 10
    const segments = Math.ceil(durationSec / 3)
    const segs = Array.from({ length: segments }, (_, i) => {
      const start = i * 3
      const end = Math.min((i + 1) * 3, durationSec)
      return `<n>${start}-${end}秒</n>`
    }).join('')

    const dialogueSection = dialogueTag
      ? `\n[multimodal_description]\n${sp.action}${segs}${sp.result ? `\n收尾:${sp.result}` : ''}\n${dialogueTag}`
      : `${sp.action}${segs}${sp.result ? `。收尾于：${sp.result}` : ''}`
    const videoPrompt = `${dialogueSection}。延续上一镜末帧构图。`

    const cleanedImage = applyQualityChecklist(imagePrompt, 'image').cleaned
    const cleanedVideo = applyQualityChecklist(videoPrompt, 'video').cleaned
    const densityResult = validateEventDensity(cleanedVideo)
    const safetyResult = checkPromptSafety(cleanedImage, 'image')

    const res = db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: sp.shot_number,
      title: `镜头#${sp.shot_number}`,
      shotType: sp.shot_type,
      angle: sp.angle,
      movement: sp.movement,
      location: sp.location,
      time: sp.time,
      action: sp.action,
      dialogue: autoFillSpeakerFromScript(sp.dialogue, scriptContent),
      description: sp.description,
      result: sp.result,
      atmosphere: sp.atmosphere,
      imagePrompt: safetyResult.cleaned,
      videoPrompt: cleanedVideo,
      bgmPrompt: '',
      soundEffect: '',
      sceneId: sp.scene_id,
      duration: sp.duration || 10,
      negativePrompt: autoNegativePrompt,
      eventDensity: densityResult.density,
      eventList: densityResult.events.length ? JSON.stringify(densityResult.events) : '',
      promptOriginal: safetyResult.flagged ? imagePrompt : '',
      safetyFlagged: safetyResult.flagged ? 1 : 0,
      safetyNotes: safetyResult.notes.length ? JSON.stringify(safetyResult.notes) : '',
      createdAt: ts, updatedAt: ts,
    }).run()
    syncStoryboardCharacters(Number(res.lastInsertRowid), sp.character_ids || [])
    onProgress?.({ shot: sp.shot_number, total: shot_plan.length, status: 'writing' })
    totalDuration += sp.duration || 10
    if (densityResult.suggestion) {
      densityWarnings.push({
        shot_number: sp.shot_number,
        density: densityResult.density,
        suggestion: densityResult.suggestion,
        events: densityResult.events,
      })
    }
    if (safetyResult.flagged) {
      safetyWarnings.push({
        shot_number: sp.shot_number,
        flagged: true,
        notes: safetyResult.notes,
      })
    }
  }

  db.update(schema.episodes)
    .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId)).run()

  logTaskSuccess('StoryboardTool', 'generate-shot-prompts-complete', {
    episodeId, count: shot_plan.length, totalDuration,
    densityWarnings: densityWarnings.length, safetyWarnings: safetyWarnings.length,
  })
  return { count: shot_plan.length, total_duration: totalDuration, density_warnings: densityWarnings.length, safety_warnings: safetyWarnings.length }
}

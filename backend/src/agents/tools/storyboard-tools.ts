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
import {
  getBaselineFor,
  getDensityScale,
  getMoveScale,
  FALLBACK_DENSITY_SCALE,
  computeDialogueFloor,
  SHORT_DIALOGUE_THRESHOLD,
  SHORT_DIALOGUE_MAX,
  VIDEO_MIN_DURATION,
  VIDEO_MAX_DURATION,
  HOOK_OPENING_MIN,
  HOOK_CLOSING_MIN,
  HOOK_CLIFFHANGER_MIN,
  CLIFFHANGER_TAGS,
  SCENE_TRANSITION_BONUS,
  DEFAULT_EPISODE_TARGET_SECONDS,
  EPISODE_TARGET_TOLERANCE,
  CLIMAX_BONUS_COEFFICIENT,
} from '../../constants/shot-type-baseline'
import {
  estimateTargetDuration,
} from '../../lib/episode-duration-estimator'
import {
  classifyEpisodeScenes,
  type EpisodeSceneData,
  type SceneTag,
} from '../../lib/scene-classifier'

// H3 三段式 video_prompt 的 5D 字段映射(对齐 backend/src/agents/index.ts storyboard_breaker DEFAULT_PROMPTS P4)
// planner 输出中文 / 自由文本,这里统一映射到 H3 英文 enum
const H3_SHOT_TYPE_MAP: Record<string, string> = {
  远景: 'WS', 全景: 'WS', WS: 'WS',
  中全景: 'MLS', MLS: 'MLS',
  中景: 'MS', MS: 'MS',
  近景: 'CU', CU: 'CU',
  特写: 'ECU', ECU: 'ECU', 大特写: 'ECU',
}
const H3_MOVEMENT_MAP: Record<string, string> = {
  固定: 'static', static: 'static', 静止: 'static',
  推镜: 'slow dolly in', 推: 'slow dolly in', 'dolly in': 'slow dolly in', 推进: 'slow dolly in',
  拉镜: 'dolly out', 拉: 'dolly out', 'dolly out': 'dolly out', 后拉: 'dolly out',
  左移: 'pan left', 'pan left': 'pan left', 左摇: 'pan left',
  右移: 'pan right', 'pan right': 'pan right', 右摇: 'pan right',
  手持: 'handheld', handheld: 'handheld',
  仰拍: 'tilt up', 'tilt up': 'tilt up', 上摇: 'tilt up',
  俯拍: 'tilt down', 'tilt down': 'tilt down', 下摇: 'tilt down',
}
const H3_ANGLE_MAP: Record<string, string> = {
  平视: 'eye-level', 'eye-level': 'eye-level', 水平: 'eye-level',
  仰视: 'low angle', 'low angle': 'low angle',
  俯视: 'high angle', 'high angle': 'high angle',
  荷兰角: 'dutch tilt', 'dutch tilt': 'dutch tilt',
  过肩: 'over-shoulder', 'over-shoulder': 'over-shoulder',
  主观: 'POV', POV: 'POV',
}
// 焦距 / 景深 planner 未输出,按景别给常用默认值(H3 P4)
const H3_FOCAL_BY_SHOT: Record<string, string> = {
  WS: '24mm(广角)', MLS: '35mm(标准)',
  MS: '50mm(中焦)', CU: '85mm(肖像)', ECU: '85mm(肖像)',
}
const H3_DEPTH_BY_SHOT: Record<string, string> = {
  WS: 'deep f/8', MLS: 'standard f/4', MS: 'standard f/4',
  CU: 'shallow f/1.8', ECU: 'shallow f/1.8',
}


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

// 2026-09-10 fix: H3 三段式 video_prompt 兜底
//   LLM 经常只输出 Integrated multimodal description 一段,导致
//   Overall soundscape / Non-diegetic music 缺失, H3 模型对缺失段
//   自由发挥, 产生不可控随机音频("杂乱的声音")。code 端必须保证
//   video_prompt 字段始终包含完整三段式。
//   music 兜底不允许用 atmosphere 推断 (atmosphere 不是音乐描述,
//   会让 H3 看到抽象词后自由发挥) — 见 commit f927a6a。
function ensureH3ThreePartPrompt(
  prompt: string,
  soundEffect?: string | null,
  bgmPrompt?: string | null,
): string {
  let result = prompt
  // 宽松匹配 H3 三段式 header (大小写、分隔符空格/_/- 都不敏感)
  // LLM 翻译后可能写出 Overall soundscape: / Overall_Soundscape: /
  // OVERALL SOUNDSCAPE: 等变体, 下面这个 regex 都接得住
  const hasSoundscape = /(?:^|\n)\s*overall[\s_-]+soundscape[\s_-]*:/i.test(result)
  const hasMusic = /(?:^|\n)\s*(?:non[\s_-]+diegetic[\s_-]+music|non-diegetic\s+music)[\s_-]*:/i.test(result)
  if (!hasSoundscape) {
    const soundscape = soundEffect?.trim() || 'N/A'
    result = result.trimEnd() + "\n\nOverall soundscape:\n" + soundscape
  }
  if (!hasMusic) {
    const music = bgmPrompt?.trim() || 'N/A'
    result = result.trimEnd() + "\n\nNon-diegetic music:\n" + music
  }
  return result
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
              shotDensity: template.shotDensity,
              // @deprecated 仅 scene-intention.ts fallback 路径消费 (line 128 tmpl?.recommendedDuration), storyboard-tools 内部不读
              recommendedDuration: template.recommendedDuration,
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
              shotDensity: fallbackTemplate.shotDensity,
              // @deprecated 仅 scene-intention.ts fallback 路径消费, storyboard-tools 内部不读
              recommendedDuration: fallbackTemplate.recommendedDuration,
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
        dialogue: z.string().nullish(),
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
      // 兜底 clamp duration 到 [4, 15] (MiniMax-H3 支持范围). Agent prompt 写了 5-15s
      // 但 LLM 不一定听话, 之前见过输出 2/3/20 直接报 400. Adapter 层也有 clamp 但不
      // 持久化, 这里直接 mutate 让 DB 落库就是规范的. 已有数据不会自动改, 需要重新拆解.
      let durationClamped = 0
      for (const sb of storyboards) {
        if (sb.duration != null) {
          const clamped = Math.max(4, Math.min(15, Math.floor(sb.duration)))
          if (clamped !== sb.duration) { sb.duration = clamped; durationClamped++ }
        }
      }
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: storyboards.length,
        shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
        durationClamped,
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
        const baseVideo = applyQualityChecklist(sb.video_prompt, 'video').cleaned
        // 2026-09-10: 兜底三段式,补齐缺失的 Overall soundscape / Non-diegetic music 段
        const cleanedVideo = ensureH3ThreePartPrompt(baseVideo, sb.sound_effect, sb.bgm_prompt)
        // 2026-09-10: 只对 integrated multimodal description 段做事件密度检查,
        //   避免 soundscape/music 描述里的句号被算成独立事件而误报 density
        const densityInput = cleanedVideo.split(/\n\n(?:Overall|non[\s_-]+diegetic)[\s_-]+(?:soundscape|music)[\s_-]*:/i)[0]
        const densityResult = validateEventDensity(densityInput)
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
      // 兜底 clamp duration (同 save_storyboards)
      if (fields.duration != null) {
        fields.duration = Math.max(4, Math.min(15, Math.floor(fields.duration)))
      }
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
        const baseVideo = applyQualityChecklist(fields.video_prompt, 'video').cleaned
        // 2026-09-10: 兜底三段式,补齐缺失的 Overall soundscape / Non-diegetic music 段
        // sound_effect / bgm_prompt 用 fields 优先, 否则用 db 当前值
        const [curSb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
        const cleanedVideo = ensureH3ThreePartPrompt(
          baseVideo,
          fields.sound_effect ?? curSb?.soundEffect,
          fields.bgm_prompt ?? curSb?.bgmPrompt,
        )
        // 2026-09-10: 只对 integrated 段做事件密度检查 (避免 soundscape/music 描述里的句号被算成事件)
        const densityInput = cleanedVideo.split(/\n\n(?:Overall|non[\s_-]+diegetic)[\s_-]+(?:soundscape|music)[\s_-]*:/i)[0]
        const densityResult = validateEventDensity(densityInput)
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
      if ('character_ids' in fields && fields.character_ids?.length) syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
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
        dialogue: z.string().nullish(),
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
        // nullable 风险字段: planner 输出 null 时不报 zod validation 错, 由 execute normalize 兜底
        // (2026-09-21 fix: 之前 .optional() 不接 null, planner 输出 null 时整个 tool call fail, history 反复重发 body 暴涨)
        // 2026-09-22 fix: LLM 在我加了 Batch A #3 character_ids 必填 prompt 后,
        //   把 JSON Schema 的 items 关键字当成数据输出成 {item: [...]} (89 次 Tool input validation failed 循环).
        //   preprocess 容错: 接受 array / object({item:[...]}) / null / undefined, 转换到标准 array.
        character_ids: z.preprocess(
          (v): number[] | null | undefined => {
            if (v === null || v === undefined) return null
            if (Array.isArray(v)) return v
            // LLM 把 schema items 误当字段名, 出现 {item: [...]} 或 {items: [...]}
            if (typeof v === 'object' && v !== null) {
              const obj = v as Record<string, any>
              if (Array.isArray(obj.item)) return obj.item
              if (Array.isArray(obj.items)) return obj.items
            }
            return null  // 其它形态 fallback null (zod .nullish 接受), 避免 zod error 触 retry 循环
          },
          z.array(z.number()).nullish()
        ),
        shot_type: z.string().nullish(),
        // angle/movement/action 也改 .nullish() (2026-09-21 ISSUE-006): 同 dialogue/description 一样会触发 zod validation fail + history 重发
        angle: z.string().nullish(),
        movement: z.string().nullish(),
        // action normalize 已存在 (见 execute 入口), schema 改 nullish 让其激活
        location: z.string().nullish(),
        time: z.string().nullish(),
        duration: z.number(),
        // action nullish (2026-09-21 ISSUE-007): 上一 commit (610610d) 注释和 commit message 都声明改了 action 但漏改,
        // 这次补上. normalize 那行 action: sp.action ?? '' 之前是 dead code, 现在激活
        action: z.string().nullish(),
        dialogue: z.string().nullish(),
        description: z.string().nullish(),
        result: z.string().nullish(),
        atmosphere: z.string().nullish(),
        intent_function: z.string().nullish(),
      })),
    }),
    execute: async ({ shot_plan }) => {
      // normalize nullable → 默认值, 防 null 字符串拼进 prompt + map() TypeError
      // (2026-09-21 fix: 上 schema 改 nullish 后必须配此兜底, 否则 null 字符串会进 prompt 出图乱)
      const safeShotPlan = shot_plan.map(sp => ({
        ...sp,
        character_ids: Array.isArray(sp.character_ids) ? sp.character_ids : [],
        shot_type: sp.shot_type ?? '中景',
        angle: sp.angle ?? '',
        movement: sp.movement ?? '',
        location: sp.location ?? '',
        time: sp.time ?? '',
        action: sp.action ?? '',
        dialogue: sp.dialogue ?? '',
        description: sp.description ?? '',
        result: sp.result ?? '',
        atmosphere: sp.atmosphere ?? '',
        intent_function: sp.intent_function ?? '铺垫',
      }))
      return runGenerateShotPrompts({ episodeId, dramaId, shot_plan: safeShotPlan })
    },
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt, generateShotPrompts }
}

// ── Phase 2 时长决策 helper functions (msg-20260920-003) ──────────────
// 不混入主循环, 每个函数独立可测. 上游常量: ../../constants/shot-type-baseline.ts

/**
 * 五因子粒度模型 → candidate duration (秒)
 *  factor-1: 景别 baseline (getBaselineFor)
 *  factor-2: 密度系数 (getDensityScale from intentTemplate.durationCoefficient)
 *  factor-4: 运镜速度系数 (getMoveScale from sp.movement)
 *  → baseline.min × density × move
 *  factor-3: dialogueFloor = ceil(对白字数 / 4.5) + 1
 *  → candidate = max(floor, scaled)
 *  P3: 短对白 (<10字) 压缩到 ≤ 8s
 *  最终: [VIDEO_MIN_DURATION, VIDEO_MAX_DURATION] clamp
 */
function computeShotDuration(
  sp: { shot_type: string; dialogue?: string; movement?: string },
  intentTemplate: { durationCoefficient?: number; shotDensity?: string } | undefined,
  // Step 3.G: scene-classifier 标记 climax 时应用 CLIMAX_BONUS_COEFFICIENT,
  // 让该 scene 所有镜头延长 (但不破坏 intent-template 快慢节奏 + 不突破 VIDEO_MAX=15)
  sceneTag: SceneTag = 'normal',
): number {
  const baseline = getBaselineFor(sp.shot_type)
  const densityScale = intentTemplate?.durationCoefficient ?? FALLBACK_DENSITY_SCALE
  const moveScale = getMoveScale(sp.movement)
  // 对白按 char count (去空白), 中文 4.5 字/秒常识
  const dialogueChars = (sp.dialogue || '').replace(/\s/g, '').length
  const scaled = baseline.min * densityScale * moveScale
  const floor = computeDialogueFloor(dialogueChars)
  let candidate = Math.max(floor, scaled)
  // Step 3.G: climax bonus (scene-classifier 3-vote 标记 climax 时)
  //   1.3x 乘到 candidate, 让该 scene 镜头延长落点时间.
  //   Σ 收敛时 climax 镜相对延长比例 1.3:1 仍保留 (绝对时长会被 Σ 缩, 但相对节奏稳).
  if (sceneTag === 'climax') {
    candidate *= CLIMAX_BONUS_COEFFICIENT
  }
  // P3: 短对白压缩 (< 10 字 → ≤ 8s, 避免空转)
  if (dialogueChars > 0 && dialogueChars < SHORT_DIALOGUE_THRESHOLD) {
    candidate = Math.min(candidate, SHORT_DIALOGUE_MAX)
  }
  return Math.round(candidate)
}

/**
 * 钩子保留 (O3)
 *  idx=0 → HOOK_OPENING_MIN (3s, 开场钩子)
 *  idx=last → HOOK_CLIFFHANGER_MIN (10s, 仅 cliffhanger) 或 HOOK_CLOSING_MIN (8s)
 *  其他 → 0 (不强制)
 */
function getHookMin(idx: number, total: number, isCliffhanger: boolean): number {
  if (idx === 0) return HOOK_OPENING_MIN
  if (idx === total - 1) {
    return isCliffhanger ? HOOK_CLIFFHANGER_MIN : HOOK_CLOSING_MIN
  }
  return 0
}

/**
 * 场景过渡 bonus (O2)
 *  每个 scene 第一个镜 +0.5s (观众认知切换需要缓冲)
 */
function applySceneTransitionBonus(candidate: number, isFirstInScene: boolean): number {
  return isFirstInScene ? candidate + SCENE_TRANSITION_BONUS : candidate
}

/**
 * scene 内第一镜索引集合 (Phase 2 C, 用于场景过渡 bonus)
 *  shot_plan 按 shot_number 顺序, 同一 scene_id 第一次出现算 first
 */
function buildFirstInSceneIndices(
  shot_plan: Array<{ scene_id: number }>
): Set<number> {
  const seenScenes = new Set<number>()
  const firstIndices = new Set<number>()
  shot_plan.forEach((sp, i) => {
    if (!seenScenes.has(sp.scene_id)) {
      seenScenes.add(sp.scene_id)
      firstIndices.add(i)
    }
  })
  return firstIndices
}

/**
 * cliffhanger 判定 (Phase 2 C placeholder, Phase 3 scene-classifier 会替换为更复杂逻辑)
 *  检查 scene 的 intention.function 字段是否命中 CLIFFHANGER_TAGS
 *  scene.intention 不存在 → false (无 cliffhanger)
 *  Phase 3: lib/scene-classifier.ts 会加 fallback 推断 (结构位置后 30% + description 冲突词 + 场景对峙)
 */
function isCliffhangerScene(
  sceneId: number,
  sceneMap: Map<number, { intention?: { function?: string } | null }>
): boolean {
  const fn = sceneMap.get(sceneId)?.intention?.function
  return fn ? CLIFFHANGER_TAGS.includes(fn as typeof CLIFFHANGER_TAGS[number]) : false
}

/**
 * episode target 来源 (Phase 2 C placeholder, Phase 3 estimator 替换)
 *  当前 episodes 表没有 target_duration 字段, fallback DEFAULT_EPISODE_TARGET_SECONDS (100s)
 *  Phase 3 lib/episode-duration-estimator.ts 接入后会先查 episodes.target_duration 字段再 fallback
 *  这里保留 placeholder 接口便于 Phase 3 直接替换
 */
function getEpisodeTargetSeconds(episodeId: number): number {
  // PM 派单 msg-20260920-004 Step 3.D 接入:
  //   1. 先查 episodes.target_duration 字段（如有且不为 null）→ 直接返回
  //   2. 否则调 estimateTargetDuration() (聚合 storyboards dialogue + sceneIntention)
  //   3. 再 fallback 100s

  // 1. user-set target duration
  const episodeRow = db.select({ targetDuration: schema.episodes.targetDuration, dramaId: schema.episodes.dramaId })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (episodeRow?.targetDuration != null && episodeRow.targetDuration > 0) {
    return episodeRow.targetDuration
  }

  if (!episodeRow || episodeRow.dramaId == null) {
    return DEFAULT_EPISODE_TARGET_SECONDS
  }

  // 2. 聚合 estimator 所需数据
  //    drama 内所有 episodes (算 episode position penalty)
  const dramaEpisodes = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, episodeRow.dramaId))
    .all()

  //    本 episode 所有 scenes
  const scenes = db.select().from(schema.scenes)
    .where(eq(schema.scenes.episodeId, episodeId))
    .all()

  //    本 episode 所有 storyboards (聚合 dialogue + intentionFunction per scene)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()

  const dialogueByScene = new Map<number, string>()
  const intentionByScene = new Map<number, DramaticFunctionKey>()
  for (const sb of storyboards) {
    if (sb.sceneId == null) continue
    if (sb.dialogue) {
      dialogueByScene.set(sb.sceneId, (dialogueByScene.get(sb.sceneId) ?? '') + sb.dialogue)
    }
    if (sb.sceneIntention) {
      // first-wins: 取第一个解析成功的 intention (同 scene 多 storyboard 时)
      if (!intentionByScene.has(sb.sceneId)) {
        try {
          const parsed = JSON.parse(sb.sceneIntention) as { function?: string }
          if (parsed.function) {
            intentionByScene.set(sb.sceneId, parsed.function as DramaticFunctionKey)
          }
        } catch {
          // 解析失败忽略, 下个 storyboard 再试
        }
      }
    }
  }

  //    构造 EpisodeSceneData[] (caller 负责组装 dialogue/intentionFunction)
  const episodeSceneData: EpisodeSceneData[] = scenes.map(s => ({
    ...s,
    dialogue: dialogueByScene.get(s.id),
    intentionFunction: intentionByScene.get(s.id),
  }))

  // 3. estimator (返回 [60, 240] clamp 后的秒数)
  return estimateTargetDuration(episodeId, dramaEpisodes, episodeSceneData)
}

/**
 * Σ 收敛 (Phase 2 C)
 *  当 Σ > target × tolerance, 按比例缩放非钩子镜头
 *  钩子镜 (idx=0, idx=last 且 cliffhanger) 强制 ≥ hookMin 不被缩
 *  返回新的 durations 数组 (新数组, 不修改入参)
 */
function convergeShotDurations(
  durations: number[],
  episodeTargetSeconds: number,
  isCliffhanger: (idx: number) => boolean,
): number[] {
  const total = durations.reduce((a, b) => a + b, 0)
  const maxAllowed = episodeTargetSeconds * EPISODE_TARGET_TOLERANCE
  if (total <= maxAllowed) return durations.slice()  // 不超, 不缩
  const scale = maxAllowed / total
  return durations.map((d, i) => {
    const hookMin = getHookMin(i, durations.length, isCliffhanger(i))
    if (hookMin > 0) return Math.max(d, hookMin)  // 钩子镜不缩
    // QA ISSUE-002 (msg-20260920-006): 之前用 Math.max(1, ...) 兜底, 缩放后非钩子镜可能跌到 1-3s
    //   违反 H3 VIDEO_MIN_DURATION=4 硬约束. EP=5 Σ=258s scale≈0.43 大概率触发.
    //   修复: 兜底用 VIDEO_MIN_DURATION=4, 钩子镜仍保留 hook_min 不被缩
    return Math.max(VIDEO_MIN_DURATION, Math.round(d * scale))
  })
}

// ── Phase 2 helper functions 结束 ──────────────────────────────

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
    // 修:planner 之前不输出这两字段,音效/配乐段只能 'none' 兜底 — 现在 planner 直出,code 侧优先用
    sound_effect?: string
    bgm_prompt?: string
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

  // Phase 2 准备: episode 目标时长
  //   firstInSceneIndices 必须在 P3 stable sort 之后算 (QA ISSUE-008 修, 2026-09-22):
  //   sort 改变 shot_plan 数组顺序, 如果先算 firstInSceneIndices, 主循环里
  //   firstInSceneIndices.has(i) 用的 i 是 sort 后的 idx, 但集合是 sort 前的 idx → stale,
  //   漏 +0.5s 场景过渡 bonus (SCENE_TRANSITION_BONUS)
  const episodeTargetSeconds = getEpisodeTargetSeconds(episodeId)

  // 2026-09-22 P3 修: scene_id 单调性校验 + 合法性校验
  //   合法性: scene_id 必须在 readStoryboardContext 返回的 scene 集合里 (planner hallucination 硬错, throw)
  //   单调性: 同 scene 必须连续, 不允许拆分中间夹其它 scene. 旧版本 throw → planner retry (浪费 290s).
  //          新版本 auto-fix: stable sort + warning log. 99% 短剧情况下等价于 planner 想要的效果.
  //          真正闪回剧本需要升级方案 B (group first-appearance non-decreasing), 当前用不到.

  // (a) 合法性 throw: hallucinated scene_id 必须 retry
  const validSceneIds = new Set(scenes.map(s => s.id))
  for (const sp of shot_plan) {
    if (!validSceneIds.has(sp.scene_id)) {
      throw new Error(
        `非法 scene_id=${sp.scene_id} (镜 ${sp.shot_number}),不在剧本场景集合 [${[...validSceneIds].join(',')}]中. ` +
        `禁止凭空创造新 scene_id (planner system prompt 硬约束).`
      )
    }
  }

  // (b) 单调性 stable sort: 同 scene_id 保持原相对顺序, 不同 scene_id 按 scene_id 升序
  const _wasReordered = !shot_plan.every((sp, i) => i === 0 || sp.scene_id >= shot_plan[i - 1].scene_id)
  if (_wasReordered) {
    // 收集违规点用于 warning log
    const violations: Array<{ shot: number; prevSceneId: number; gotSceneId: number }> = []
    for (let i = 1; i < shot_plan.length; i++) {
      if (shot_plan[i].scene_id < shot_plan[i - 1].scene_id) {
        violations.push({
          shot: shot_plan[i].shot_number,
          prevSceneId: shot_plan[i - 1].scene_id,
          gotSceneId: shot_plan[i].scene_id,
        })
      }
    }
    // stable sort: sort + 同 scene_id 保持原相对顺序
    shot_plan.sort((a, b) => a.scene_id - b.scene_id)
    console.warn(
      `[P3 auto-fix] shot_plan scene_id 不单调, 已 stable sort. 违规数=${violations.length}, ` +
      `前 3 个: ${violations.slice(0, 3).map(v => `镜${v.shot}: ${v.prevSceneId}→${v.gotSceneId}`).join('; ')}. ` +
      `如需保持 planner 原序 (闪回剧本), 升级到方案 B (group first-appearance non-decreasing).`
    )
  }

  // QA ISSUE-008 fix (2026-09-22): sort 之后重算 firstInSceneIndices, 否则 stale
  const firstInSceneIndices = buildFirstInSceneIndices(shot_plan)

  // Step 3.G: scene-classifier 算 climax 标签 (Step 2.F) → computeShotDuration climax bonus
  //   流程: 取 episode 所有 storyboards 解析 sceneIntention JSON → 按 scene_id 聚合 intentionFunction
  //     → 组装 EpisodeSceneData[] → classifyEpisodeScenes 3-vote → Map<scene_id, SceneTag>
  //   后续 loop 里 sp.scene_id 查表得到 sceneTag 传给 computeShotDuration.
  const storyboardsForClf = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  const intentionByScene = new Map<number, DramaticFunctionKey>()
  for (const sb of storyboardsForClf) {
    if (sb.sceneId == null) continue
    if (sb.sceneIntention && !intentionByScene.has(sb.sceneId)) {
      try {
        const parsed = JSON.parse(sb.sceneIntention) as { function?: string }
        if (parsed.function) {
          intentionByScene.set(sb.sceneId, parsed.function as DramaticFunctionKey)
        }
      } catch { /* malformed sceneIntention JSON, skip */ }
    }
  }
  const episodeScenesForClf: EpisodeSceneData[] = scenes
    .filter(s => s.episodeId === episodeId)
    .sort((a, b) => a.id - b.id)  // chronological order for position-based 3-vote
    .map(s => ({ ...s, intentionFunction: intentionByScene.get(s.id) }))
  const sceneClimaxTags = classifyEpisodeScenes(episodeScenesForClf)
  const sceneTagMap = new Map<number, SceneTag>(
    episodeScenesForClf.map((s, idx) => [s.id, sceneClimaxTags[idx]])
  )

  // 2026-09-22 P2+P4 修: scene 密度软联动约束 (单镜下限 + Σ 区间)
  //   planner 不强制镜数, 但每场景的总时长 + 单镜时长受 density 约束
  //   违反 → 抛错让 planner retry
  //   注: 用 intentionByScene (DramaticFunctionKey) → INTENTION_TEMPLATES[fn].shotDensity 拿密度
  const SCENE_DENSITY_RULES = {
    high:   { minMirror: 3, sceneMinTotal: 10, sceneMaxTotal: 25 },
    medium: { minMirror: 5, sceneMinTotal: 15, sceneMaxTotal: 35 },
    low:    { minMirror: 8, sceneMinTotal: 25, sceneMaxTotal: 50 },
  } as const

  // 按 scene_id 分组统计 shot_plan (此时 shot_plan 原始 duration, 不是 clamp 后的)
  type SceneStat = { density: string; totalDuration: number; count: number; minMirror: number }
  const sceneStats2 = new Map<number, SceneStat>()
  for (const sp of shot_plan) {
    const fn = intentionByScene.get(sp.scene_id)
    const density = (fn && INTENTION_TEMPLATES[fn]?.shotDensity) || 'medium'
    const cur = sceneStats2.get(sp.scene_id) || { density, totalDuration: 0, count: 0, minMirror: Infinity }
    cur.totalDuration += sp.duration || 10
    cur.count++
    cur.minMirror = Math.min(cur.minMirror, sp.duration || 10)
    sceneStats2.set(sp.scene_id, cur)
  }

  const violations: string[] = []
  for (const [sceneId, stats] of sceneStats2) {
    const rule = SCENE_DENSITY_RULES[stats.density as keyof typeof SCENE_DENSITY_RULES]
    if (!rule) continue
    if (stats.minMirror < rule.minMirror) {
      violations.push(`scene ${sceneId}(${stats.density}): 单镜下限违反, 最小单镜=${stats.minMirror}s < 阈值 ${rule.minMirror}s`)
    }
    if (stats.totalDuration < rule.sceneMinTotal) {
      violations.push(`scene ${sceneId}(${stats.density}): Σ 时长过短=${stats.totalDuration}s < 阈值 ${rule.sceneMinTotal}s`)
    }
    if (stats.totalDuration > rule.sceneMaxTotal) {
      violations.push(`scene ${sceneId}(${stats.density}): Σ 时长过长=${stats.totalDuration}s > 阈值 ${rule.sceneMaxTotal}s`)
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `scene 密度软联动约束违反 (P2+P4 校验失败): ${violations.join('; ')}. ` +
      `低密度场景应切 2-3 个长镜(≥8s/个), medium 应 4-6 镜 ≥5s, high 应 3-5 镜 ≥3s. Σ 时长也应在区间内.`
    )
  }

  let totalDuration = 0
  const densityWarnings: Array<{ shot_number: number; density: string; suggestion: string; events: string[] }> = []
  const safetyWarnings: Array<{ shot_number: number; flagged: boolean; notes: any[] }> = []

  for (const [i, sp] of shot_plan.entries()) {
    validateStoryboardBindings(episodeId, sp.scene_id, sp.character_ids)
    const scene = sceneMap.get(sp.scene_id)
    const charRefs = sp.character_ids.map(id => charMap.get(id)).filter((c): c is NonNullable<typeof c> => !!c)

    // 五因子粒度模型 (Phase 2 msg-20260920-003): 景别 baseline × 密度系数 × 运镜系数
    //   → dialogueFloor clamp → [VIDEO_MIN, VIDEO_MAX] 安全网
    //   旧逻辑 (密度 clamp 到区间) 已废弃, 密度现在是 scale 系数不是 range
    const intentTemplate = INTENTION_TEMPLATES[sp.intent_function as DramaticFunctionKey]
    // Step 3.G: 取 scene-classifier 标签 (fallback 'normal' 表示 scene_id 不在 episode 场景表)
    const sceneTag = sceneTagMap.get(sp.scene_id) ?? 'normal'
    let candidate = computeShotDuration(sp, intentTemplate, sceneTag)
    // 场景过渡 bonus (O2)
    candidate = applySceneTransitionBonus(candidate, firstInSceneIndices.has(i))
    // [VIDEO_MIN_DURATION, VIDEO_MAX_DURATION] 终极安全网 (video API 硬约束)
    sp.duration = Math.max(VIDEO_MIN_DURATION, Math.min(VIDEO_MAX_DURATION, candidate))

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
      return `${c.name}永久外貌(年龄/脸型/发色/体型/服装,仅参考角色立绘,不重复 plot 道具/高潮动作):${look}`
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

    // H3 三段式 video_prompt 构造(对齐 backend/src/agents/index.ts storyboard_breaker DEFAULT_PROMPTS):
    //   1) Integrated multimodal description + 5D(景别/焦距/运镜/景深/视角) + 时间戳 <n>X-Ys</n>(s 缩写)
    //   2) Overall soundscape — 无 diegetic 音效时显式 'none'
    //   3) Non-diegetic music — 缺省用 atmosphere 兜底,无则 'none'
    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

    const shotTypeEn = H3_SHOT_TYPE_MAP[sp.shot_type] || 'MS'
    const movementEn = H3_MOVEMENT_MAP[sp.movement] || 'static'
    const angleEn = H3_ANGLE_MAP[sp.angle] || 'eye-level'
    const focal = H3_FOCAL_BY_SHOT[shotTypeEn] || '50mm(中焦)'
    const depth = H3_DEPTH_BY_SHOT[shotTypeEn] || 'standard f/4'

    const durationSec = sp.duration || 10
    const segments = Math.ceil(durationSec / 3)
    const segs = Array.from({ length: segments }, (_, i) => {
      const start = i * 3
      const end = Math.min((i + 1) * 3, durationSec)
      return `<n>${start}-${end}s</n>`  // 修 commit 1f1b944 P1: 秒 → s 缩写
    }).join('')


    const dialogueInline = sp.dialogue ? ` 开口:'${escapeXml(sp.dialogue)}'` : ''
    const resultInline = sp.result ? ` Ends with ${sp.result}.` : ''
    // 角色 6 维外貌注入 — 对齐 planner prompt 5 规则「video_prompt 中提到角色时必须复制 6 维描述」,
    //   之前只 imagePrompt 注入了 ${charDesc}, videoPrompt 漏了, H3 模型只能靠 first_frame 参考图保持一致性 → 换脸/换体型
    //   修复: integrated 段开头插入 charRoles (角色名 + 外貌), 让 H3 模型在动起来之前明确知道角色长什么样
    // 注意: 用 escapeXml 转义以防 character.appearance 里有 < / > / ' 等特殊字符
    // QA ISSUE-003 (msg-20260920-006): charRefs 为空时 charRoles='', integrated 开头会变
    //   '延续上一镜末帧构图. . ${segs}...', 多一个 '. ', 格式丑但不崩.
    //   修复: 用 charRolesPrefix 判断, 空时不加这个 '. '
    const charRoles = charRefs.map(c => {
      const look = c.appearance || c.description || c.personality || '人物'
      return `${escapeXml(c.name)}永久外貌(年龄/脸型/发色/体型/服装,仅参考立绘不重复 plot 道具/高潮动作):${escapeXml(look)}`
    }).join('；')
    const charRolesPrefix = charRoles ? `${charRoles}. ` : ''
    const integrated = `延续上一镜末帧构图. ${charRolesPrefix}${segs}<location>${sp.location}</location>${sp.time}, ${shotTypeEn} ${focal}, ${angleEn}, ${movementEn}, ${depth}. ${sp.action}${dialogueInline}.${resultInline}`.replace(/\s+/g, ' ').trim()
    // H3 官方规范 (skills/storyboard_breaker/h3-official-prompt/fl2va.md):
    //   - Overall soundscape: 无环境音/音效时显式写 'N/A',不要 'none'
    //   - Non-diegetic music: 描述必须用配器/速度/节奏/动态变化,
    //     不能用抽象情绪词 (比如 '情绪铺垫') — atmosphere 不是音乐描述,
    //     H3 看到抽象词会自由发挥,产生不可控的随机音频
    // 2026-09-10 fix: 把 'none' 改成 'N/A' (H3 官方关键字),
    //   music 兜底只允许 'N/A',不允许拿 atmosphere 当音乐描述
    const soundscape = sp.sound_effect?.trim() || 'N/A'
    const music = sp.bgm_prompt?.trim() || 'N/A'

    const videoPrompt =
      `Integrated multimodal description:\n${integrated}\n\n` +
      `Overall soundscape:\n${soundscape}\n\n` +
      `Non-diegetic music:\n${music}`

    const cleanedImage = applyQualityChecklist(imagePrompt, 'image').cleaned
    const cleanedVideo = applyQualityChecklist(videoPrompt, 'video').cleaned
    // 2026-09-10: 只对 integrated 段做事件密度检查, 避免 soundscape/music 描述里的句号被算成事件
    const densityInput = cleanedVideo.split(/\n\n(?:Overall|non[\s_-]+diegetic)[\s_-]+(?:soundscape|music)[\s_-]*:/i)[0]
    const densityResult = validateEventDensity(densityInput)
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
      bgmPrompt: music,
      soundEffect: soundscape,
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

  // Σ 收敛 (Phase 2 C): 当 Σ 超过 target × tolerance, 按比例缩放非钩子镜头
  //   注意: 钩子镜 (idx=0, idx=last 且 cliffhanger) 保留时长不被压
  const convergedDurations = convergeShotDurations(
    shot_plan.map(sp => sp.duration),
    episodeTargetSeconds,
    (idx) => isCliffhangerScene(shot_plan[idx].scene_id, sceneMap as any),
  )
  // 把 converged 值写回 shot_plan, 同时重算 totalDuration
  let convergedTotal = 0
  shot_plan.forEach((sp, i) => {
    sp.duration = convergedDurations[i]
    convergedTotal += sp.duration
  })

  db.update(schema.episodes)
    .set({ duration: Math.ceil(convergedTotal / 60), updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId)).run()

  logTaskSuccess('StoryboardTool', 'generate-shot-prompts-complete', {
    episodeId, count: shot_plan.length, totalDuration: convergedTotal, converged: convergedTotal !== shot_plan.reduce((a, sp) => a + sp.duration, 0),
    densityWarnings: densityWarnings.length, safetyWarnings: safetyWarnings.length,
  })
  // total_duration 返回收敛后的 Σ (用户看到的应该是 Σ 收敛后值, 不是循环累加中间值)
  return { count: shot_plan.length, total_duration: convergedTotal, density_warnings: densityWarnings.length, safety_warnings: safetyWarnings.length }
}

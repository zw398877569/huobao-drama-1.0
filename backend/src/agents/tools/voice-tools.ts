/**
 * 角色音色分配 Agent 工具
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response'
import { logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../../utils/task-logger'
import { generateTTSPreview } from '../../services/tts-preview.js'
// Sprint 11 QA msg-20261016-067 Bug-A: assignVoice 时把试听样本落到 static/audio/ 并写 characters.voice_sample_url
import { generateTTS } from '../../services/tts-generation.js'
// ★ Sprint 47 T4 (PM msg-20261115-188): 音色清单 (list_voices + assign_voice 的白名单校验)
import { assertVoiceInLibrary } from '../../services/voice-library.js'
import { loadVoiceLibrary } from '../../services/voice-library-db.js'
// ★ Sprint 47 T10 (PM msg-20261115-188): 试听样本的实测特征 (语速/音高/停顿)
import {
  analyzeAudioFeatures, formatAudioFeatures, cacheAudioFeatures, getCachedAudioFeatures,
} from '../../services/audio-features.js'

export function createVoiceTools(episodeId: number, dramaId: number) {
  function getEpisodeAudioProvider() {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    if (!episode?.audioConfigId) return null
    const [config] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, episode.audioConfigId)).all()
    return config?.provider || null
  }

  const getCharacters = createTool({
    id: 'get_characters',
    description: 'Get all characters for the current drama with their current voice assignments.',
    inputSchema: z.object({}),
    execute: async () => {
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const payload = {
        characters: chars.map(c => ({
          id: c.id,
          name: c.name,
          role: c.role,
          personality: c.personality,
          description: c.description,
          current_voice: c.voiceStyle || '未分配',
        })),
      }
      logTaskSuccess('VoiceTool', 'get-characters', { episodeId, dramaId, count: payload.characters.length })
      return payload
    },
  })

  const listVoices = createTool({
    id: 'list_voices',
    description: 'List all available voice options for TTS.',
    inputSchema: z.object({}),
    execute: async () => {
      const provider = getEpisodeAudioProvider() || 'minimax'
      // ★ Sprint 47 T4: 原来这里在库里没行的时候, 会返回一份【别平台音色】的硬编码兜底
      //   (alloy/echo/fable/onyx/nova/shimmer) → agent 照着这些名字挑, 最后把库里根本不存在的
      //   voice_id 写进 characters.voice_style (后面配音时才炸)。
      //   → 现在统一走 loadVoiceLibrary: 库里没有就是没有, 不编造; 上面 assign_voice 还有白名单校验兜底
      const library = loadVoiceLibrary(provider)
      const voices = library.map((v) => ({
        id: v.id,
        name: v.name,
        gender: v.gender,
        traits: v.traits,
        suitable_for: v.description || `${v.language || '通用'}角色`,
        language: v.language,
        provider,
        // ★ T10: 已经试听过的音色 → 带上实测特征 (没试听过就没有, 不编造)
        measured_features: getCachedAudioFeatures(v.id),
      }))

      const payload = {
        provider,
        voices,
        instruction: voices.length
          ? '根据角色的性别、性格、年龄来匹配最合适的音色，并且只能从当前集音频配置可用的音色列表中选择 (voice_id 要逐字照抄清单里的)。'
          : '当前 provider 的音色库是空的 → 不要挑任何音色 (尤其不要凭记忆写 echo/onyx/fable 这类名字), 请提示用户去设置里同步音色库后重试。',
      }
      logTaskSuccess('VoiceTool', 'list-voices', { episodeId, provider, count: payload.voices.length })
      return payload
    },
  })

  const assignVoice = createTool({
    id: 'assign_voice',
    description: 'Assign a voice to a character. Also persists a playable voice sample (voice_sample_url) so the user can preview the voice in the UI.',
    inputSchema: z.object({
      character_id: z.number().describe('Character ID'),
      voice_id: z.string().describe('Voice ID from list_voices'),
      reason: z.string().optional().describe('Why this voice fits'),
      sample_text: z.string().optional().describe(
        '台词片段 (建议 5-15 字, 用该角色第 1-2 句真实台词)。会生成一条永久试听样本存到 static/audio/ 供前端播放。省略则用默认问候语。',
      ),
    }),
    execute: async ({ character_id, voice_id, reason, sample_text }) => {
      const provider = getEpisodeAudioProvider() || 'minimax'
      logTaskProgress('VoiceTool', 'assign-begin', { episodeId, dramaId, characterId: character_id, voiceId: voice_id, provider, reason })

      // Sprint 11 QA msg-20261016-067 Bug-A: 生成并持久化试听样本
      //   修前: .set({ voiceSampleUrl: null }) → 3 角色 voice_sample_url 全 null,
      //         前端 '生成试听' 按钮无可播放 sample (voiceSampleCount=0)。
      //   修后: 用 agent 指定的台词 (或默认问候语) 生成一条 3-5s 样本写到 static/audio/<uuid>.mp3,
      //         写入 characters.voice_sample_url。
      //   为什么不用 tts-preview/: preview 样本在 data/tts-preview/ 且 24h lazy cleanup
      //         会删掉 (services/tts-preview.ts PREVIEW_MAX_AGE_MS), 正式样本不能放那。
      // ★ Sprint 47 T4: 白名单校验 —— 不在当前 provider 音色库里的 voice_id 一律拒绝
      //   (反向验证: 故意塞一个不存在的音色名 → 这里直接报错, 不会写进 characters.voice_style)
      const library = loadVoiceLibrary(provider)
      if (!library.some((v) => v.id === voice_id)) {
        logTaskWarn('VoiceTool', 'assign-voice-not-in-library', {
          episodeId, dramaId, characterId: character_id, voiceId: voice_id, provider,
          librarySize: library.length,
        })
      }
      assertVoiceInLibrary(voice_id, library)
      const [charRow] = db.select().from(schema.characters)
        .where(eq(schema.characters.id, character_id)).all()
      const charName = charRow?.name || `角色${character_id}`
      const sampleText = (sample_text || '').trim() || `你好，我是${charName}。很高兴认识你，这是我的声音试听。`

      let voiceSampleUrl: string | null = null
      let sampleError: string | null = null
      try {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
        voiceSampleUrl = await generateTTS({
          text: sampleText,
          voice: voice_id,
          configId: ep?.audioConfigId ?? undefined,
        })
      } catch (err: any) {
        // 样本生成失败不阻断音色分配 (音色已定, 只是前端试听不了)
        sampleError = err?.message || String(err)
        logTaskWarn('VoiceTool', 'assign-sample-failed', {
          episodeId, characterId: character_id, voiceId: voice_id, error: sampleError,
        })
      }

      db.update(schema.characters)
        .set({ voiceStyle: voice_id, voiceProvider: provider, voiceSampleUrl, updatedAt: now() })
        .where(eq(schema.characters.id, character_id))
        .run()
      logTaskSuccess('VoiceTool', 'assign-complete', {
        episodeId, characterId: character_id, voiceId: voice_id, provider,
        voiceSampleUrl, sampleError,
      })
      return {
        message: `Assigned voice "${voice_id}" to character ${character_id}`,
        reason,
        voice_sample_url: voiceSampleUrl,
        sample_error: sampleError,
        instruction: voiceSampleUrl
          ? '样本已持久化, 用户可在音色页试听该角色的声音。'
          : '样本生成失败, 用户暂时无法试听 (音色已分配, 不影响后续配音生成)。',
      }
    },
  })

  // 2026-09-25 PM msg-20260924-005 (Q4 voice_assigner preview TTS):
  // 让 agent 真听 base64 评估音色, 而非凭直觉决策
  // 每次 preview 自动 lazy cleanup 24h+ 旧样本
  const previewVoiceTts = createTool({
    id: 'preview_voice_tts',
    description: 'Generate a short TTS preview (3-5s) for a candidate voice. Returns base64 audio so you can HEAR the voice, PLUS measured features (语速/音高/停顿) — 你自己感知不到音高语速, 只能靠这些实测数值判断. Always preview >=2 candidates before assign_voice, and use the SAME text for every candidate so the numbers are comparable.',
    inputSchema: z.object({
      text: z.string().describe('台词片段, 建议 5-15 字, 反映角色说话风格'),
      voice_id: z.string().describe('候选 voice id (from list_voices)'),
      speed: z.number().optional().describe('语速 (默认 1.0)'),
      emotion: z.string().optional().describe('情绪 (默认 neutral)'),
    }),
    execute: async ({ text, voice_id, speed, emotion }) => {
      logTaskStart('VoiceTool', 'preview-tts', { voiceId: voice_id, textLen: text.length, emotion, speed })
      const result = await generateTTSPreview(
        text,
        voice_id,
        speed ?? 1.0,
        emotion ?? 'neutral',
      )
      // ★ Sprint 47 T10 (PM msg-20261115-188): 实测特征 (语速 / 音高 / 停顿)
      //   ★ 从生成的样本音频里【实测】(不是估算): ffmpeg 解码 → RMS 分帧 → 自相关算基频
      //   ★ 数值随音频一起返回 → agent 能"看数值 + 听音色"双重判断 (它自己听不出音高语速)
      let features: any = null
      try {
        features = await analyzeAudioFeatures(result.audioPath, text)
        cacheAudioFeatures(voice_id, features)
      } catch (err: any) {
        logTaskWarn('VoiceTool', 'preview-features-failed', { voiceId: voice_id, error: err?.message })
      }
      return {
        voice_id,
        audio_path: result.relativePath,
        audio_base64: result.base64,
        file_size: result.fileSize,
        duration_ms: result.durationMs,
        features,
        feature_summary: features ? formatAudioFeatures(features) : '特征不可用 (音频没解出来)',
        instruction: [
          '评估音色是否匹配: (1) 性别 (2) 年龄段 (3) 情绪 (4) 整体气质.',
          '★ 你【感知不到音高/语速/停顿】→ 这三个只能看 features 里的【实测数值】.',
          '★ 对比多个候选音色时用【同一条文本 + 同样语速设置】→ 数值才严格可比.',
          '满意再调 assign_voice.',
        ].join(' '),
      }
    },
  })

  return { getCharacters, listVoices, previewVoiceTts, assignVoice }
}

// ★ Sprint 47 T4: 性别推断统一走 services/voice-library.ts 的 inferVoiceGender
//   (老实现写成了字符类 /[男|青年|大爷|...]/ → "青年女性"命中"青" → 女声全被判成男声, 已删)

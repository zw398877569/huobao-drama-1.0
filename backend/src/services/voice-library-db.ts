/**
 * ★ Sprint 47 T4 (PM msg-20261115-188): 音色库读取 (DB 那一层)
 *
 *   纯逻辑 (生成示例 / 清别平台音色名 / 白名单校验) 在 services/voice-library.ts —— 那边不碰 DB,
 *   可以离线断言; 这个文件只负责从 ai_voices 表把行读出来。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import {
  parseVoiceRows, buildVoiceGuide, sanitizeForeignVoiceNames, upsertVoiceGuide,
  type VoiceLibraryEntry,
} from './voice-library.js'

/** 读当前 provider 的音色清单 */
export function loadVoiceLibrary(provider: string): VoiceLibraryEntry[] {
  const rows = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, provider)).all()
  return parseVoiceRows(rows, provider)
}

/** 取某一集当前用的音频 provider (取不到 → minimax) */
export function getEpisodeAudioProvider(episodeId: number): string {
  try {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    if (episode?.audioConfigId) {
      const [config] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, episode.audioConfigId)).all()
      return config?.provider || 'minimax'
    }
  } catch { /* DB 读不到 → 用默认 minimax */ }
  return 'minimax'
}

/**
 * ★ Sprint 47 T4 + 单 189 T3追加 (PM msg-20261115-188 / 189): 组装音色分配 agent 的最终 instructions。
 *   · 先把遗留的别平台音色名 (echo/onyx/fable/nova/shimmer/alloy) 清掉 —— 它们在当前 provider 下不存在
 *   · 再把【当前可用音色清单 + 真实组合示例 + 声音特征盲点说明】注入进去
 *     (prompt 来自 DB 自定义时也一样注入 —— 否则用户改过的 prompt 永远拿不到真实音色清单)
 *   · guide 用哨兵包着 → 已有 guide 块会被整体替换 (换 provider 时不会重复追加)
 */
export function buildVoiceAssignerInstructions(rawInstructions: string, episodeId: number): string {
  const provider = getEpisodeAudioProvider(episodeId)
  const voices = loadVoiceLibrary(provider)
  const guide = buildVoiceGuide(voices)
  const sanitized = sanitizeForeignVoiceNames(rawInstructions)
  return upsertVoiceGuide(sanitized, guide)
}

/**
 * ★ Sprint 47 T4 (PM msg-20261115-188): 音色库读取 (DB 那一层)
 *
 *   纯逻辑 (生成示例 / 清别平台音色名 / 白名单校验) 在 services/voice-library.ts —— 那边不碰 DB,
 *   可以离线断言; 这个文件只负责从 ai_voices 表把行读出来。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { parseVoiceRows, type VoiceLibraryEntry } from './voice-library.js'

/** 读当前 provider 的音色清单 */
export function loadVoiceLibrary(provider: string): VoiceLibraryEntry[] {
  const rows = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, provider)).all()
  return parseVoiceRows(rows, provider)
}

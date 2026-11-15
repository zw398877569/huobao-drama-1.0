/**
 * ★ Sprint 47 单 189 T3追加 (PM msg-20261115-189): 清理 agent_configs 里【音色分配 prompt】
 * 残留的别平台音色名 (alloy/echo/fable/onyx/nova/shimmer)。
 *
 * 【为什么要清 DB 原件】
 *   运行时虽然已经把别平台音色名替换掉了 (createAgent → buildVoiceAssignerInstructions),
 *   但 DB 里存的那份原始 prompt 还带着 25 处 → QA 验收要求"DB 里那份原始 prompt 也要清,
 *   只在运行时做替换不够, 换一台机器/换一种加载路径就会露出来"。
 *
 * 【怎么清 (幂等 + 尽量不破坏用户改动)】
 *   1. 删掉那段写死别平台音色名的旧示例 (「四、典型场景的音色组合示例」→ 标记找不到就跳过)
 *   2. 剩下的别平台音色名 → 〈音色〉占位符 (保留其余文字)
 *   3. 末尾追加【当前可用音色清单 + 真实组合示例 + 盲点说明】(带哨兵 → 运行时能整体替换)
 *   ★ 已经干净的 prompt 一律不动 (幂等: 反复重启不会反复改)
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import {
  sanitizeForeignVoiceNames, stripStaleVoiceExamples, upsertVoiceGuide, buildVoiceGuide,
  countForeignVoiceNames,
} from './voice-library.js'
import { loadVoiceLibrary } from './voice-library-db.js'

export interface VoicePromptCleanupResult {
  /** 扫了几条音色分配 prompt */
  scanned: number
  /** 实际改写了几条 */
  cleaned: number
  /** 一共清掉了多少处别平台音色名 */
  removedNames: number
}

/**
 * 清理 DB 里音色分配 prompt 的别平台音色名 (启动时调一次)。
 * @param provider 生成清单用哪个 provider 的音色 (默认 minimax)
 */
export function cleanStoredVoiceAssignerPrompts(provider: string = 'minimax'): VoicePromptCleanupResult {
  const rows = db.select().from(schema.agentConfigs)
    .where(eq(schema.agentConfigs.agentType, 'voice_assigner')).all()
  let cleaned = 0
  let removedNames = 0
  for (const row of rows) {
    const prompt = row.systemPrompt
    if (!prompt) continue
    const before = countForeignVoiceNames(prompt)
    if (!before) continue   // ★ 已经干净 → 不动 (幂等)
    const stripped = stripStaleVoiceExamples(prompt)
    const sanitized = sanitizeForeignVoiceNames(stripped)
    const guide = buildVoiceGuide(loadVoiceLibrary(provider))
    const next = upsertVoiceGuide(sanitized, guide)
    db.update(schema.agentConfigs)
      .set({ systemPrompt: next, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentConfigs.id, row.id)).run()
    cleaned++
    removedNames += before
  }
  return { scanned: rows.length, cleaned, removedNames }
}

/**
 * H3 三段式 video_prompt 兜底 (共享模块)
 *
 * Sprint 11 Task A (PM msg-20261016-001):
 *   从 agents/tools/storyboard-tools.ts:140 原样抽出, 供两条链路共用 —
 *     1. 旧 agent 路径 (storyboard-tools.ts) — import 本模块, 行为不变
 *     2. V4 三步新链路 (storyboard-planner-service.ts) — Sprint 9 重构时遗落,
 *        导致 episode 12 的 19 个 video_prompt 100% 缺三段式 header,
 *        H3 拿不到声音指令自由发挥 → 19/19 镜 13 个接近静音 (-45~-52dB)
 *
 * 背景 (原注释保留):
 *   2026-09-10 fix: LLM 经常只输出 Integrated multimodal description 一段, 导致
 *   Overall soundscape / Non-diegetic music 缺失, H3 模型对缺失段自由发挥,
 *   产生不可控随机音频("杂乱的声音")。code 端必须保证 video_prompt 字段始终包含完整三段式。
 *   music 兜底不允许用 atmosphere 推断 (atmosphere 不是音乐描述, 会让 H3 看到抽象词后
 *   自由发挥) — 见 commit f927a6a。
 */

/**
 * 确保 prompt 含 H3 三段式的后两段 (Overall soundscape / Non-diegetic music)。
 *
 * @param prompt       已拼接的 video_prompt (permanent + description + plot_state)
 * @param soundEffect  该镜环境底噪 / diegetic 音效描述, 无则 'N/A'
 * @param bgmPrompt    该镜配乐描述, 无则 'N/A'
 */
export function ensureH3ThreePartPrompt(
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

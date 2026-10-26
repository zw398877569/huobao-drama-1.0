/**
 * Sprint 23 (PM msg-20261027-095) Task C —— 翻译前把 prompt 里【已存在的】<d>...</d> 对白块脱敏。
 *
 * 背景 (PM 决策 1):
 *   H3 模板的对白由【代码层在翻译之后】注入 (Task B) —— 官方 #6 规则要求对白保持原始语言,
 *   翻译器会把它翻成英文 → 口型对不上。所以正常路径上翻译时 prompt 里【本来就没有】<d> 块。
 *   这里的脱敏是【保险】: 防 LLM 自己在 detailed_description 里乱加 <d>[Chinese]…</d> 时被翻译掉。
 *
 * 实现取舍 (PM 说"dev 评估风险后定"):
 *   - 脱敏成 [[H3D0]] 这样的 ASCII 标记 —— LLM 不会翻译/改写它的语义
 *   - 还原用宽松正则 (\[\[ *H3D *(\d+) *\]\]) —— 容忍模型加了空格/改了大小写
 *   - ★ 还原失败【不报错】: 按出现顺序把原块兜底塞回去; 实在塞不回去就保留标记
 *     (最坏情况 = 那段 LLM 自己编的对白丢了, 不影响代码层注入的权威台词)
 *
 * ⚠️ 不影响 general 模板: general 的对白在 开口:'…' 里, 翻译器本来就保护引号内正文 (ai.ts 的
 *   system prompt 规则), 这里只处理 <d> 形式, 两者互不干扰。
 */

const D_BLOCK_RE = /<d>[\s\S]*?<\/d>/gi

export interface DMaskResult {
  /** 脱敏后的文本 (可直接送去翻译) */
  text: string
  /** 翻译后调用它还原 */
  restore(translated: string): string
}

/**
 * 把 <d>...</d> 块脱敏成 [[H3D0]] / [[H3D1]] ... 标记。
 *
 * @param prompt 待翻译的 prompt
 */
export function maskDialogueBlocks(prompt: string): DMaskResult {
  const src = String(prompt || '')
  if (!src) return { text: src, restore: (t) => t }

  const blocks: string[] = []
  const masked = src.replace(D_BLOCK_RE, (m) => {
    const idx = blocks.length
    blocks.push(m)
    return `[[H3D${idx}]]`
  })
  if (blocks.length === 0) return { text: src, restore: (t) => t }

  const restore = (translated: string): string => {
    let out = String(translated || '')
    const restored = new Set<number>()
    // 1) 宽松匹配还原 (容忍模型给标记加空格/改大小写)
    out = out.replace(/\[\[\s*H3D\s*(\d+)\s*\]\]/gi, (m, n) => {
      const i = Number(n)
      const b = blocks[i]
      if (b === undefined) return m
      restored.add(i)
      return b
    })
    // 2) 兜底: 标记被翻译器毁掉 → 还原不了的块先顶掉一个残留标记, 没有残留标记就追加到末尾
    //    (最坏情况 = LLM 自己编的那段对白没还原, 不影响代码层注入的权威台词)
    for (let i = 0; i < blocks.length; i++) {
      if (restored.has(i)) continue
      const before = out
      out = out.replace(/\[\[\s*H3D[^\]]*\]\]/i, blocks[i])
      if (out === before) out = out + ' ' + blocks[i]
    }
    return out
  }

  return { text: masked, restore }
}

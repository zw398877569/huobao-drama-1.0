/**
 * ★ Sprint 48 T2 (PM msg-20261116-194): 拆解产出的 dialogue 必须【原样引用】剧本台词
 *
 * 【为什么要有】
 *   现状: drama20/ep21 的剧本 68 句/1044 字 → 拆解后只剩 33 句/573 字 (保留率 55%)。
 *   丢失不在配音层 (配音是忠实的), 而在【拆解】: planner 被容量/时长约束逼到装不下时,
 *   选择了把台词截短 (例: "祝英台:这书里的女子,宁可剪断喉咙,也不肯嫁别人。先生,你说她傻不傻?"
 *   → "祝英台:你说她傻不傻?")。
 *
 * 【怎么校验 (纯函数 → 可离线断言)]
 *   逐句比对: 拆解出的每一句台词必须在剧本原句里【逐字命中】(只允许空白差异)。
 *   · 逐字不命中 → 【硬违规】: 文字被改写/合并/凭空多出 → 报错让拆解重试
 *   · 只差标点/空白 → 【软违规】: 只告警 (不阻断, 免得因为标点风格把整轮拆解打回)
 *
 * ★ 保留率 = 命中的台词字数 / 剧本台词总字数 (目标 ≥95%, 理想 100%)
 */

/** 剧本里的一行台词 (角色：台词) */
export interface ScriptLine {
  index: number
  /** 整行原文 */
  raw: string
  /** 角色名 */
  speaker: string
  /** 台词正文 */
  text: string
  /** ★ 归一化后的 "角色：台词" (剥掉状态描述) —— 比对用这个 */
  norm: string
}

/** 拆解出来的一镜台词 */
export interface ShotDialogue {
  index: number
  shotNumber?: number
  dialogue?: string | null
}

export interface DialogueVerbatimViolation {
  index: number
  shotNumber?: number
  /** 拆解出的这一句 */
  got: string
  /** 剧本里最接近的一句 */
  expected: string
  /** hard = 文字被改写/合并/凭空多出; soft = 只差标点 */
  kind: 'hard' | 'soft'
}

/**
 * ★ 剥掉括号里的状态描述 (例: "（合上书卷,抬眼）先生也在读梁祝？" → "先生也在读梁祝？")
 *   —— 与 utils/speaker-whitelist.ts 的 stripParenNoise 逐字一致 (那边同模块引了 DB,
 *   这里内联一份纯函数, 便于离线断言; 改那边时记得同步)。
 */
function stripParenNoise(s: string): string {
  return String(s || '').replace(/[（(].+?[)）]/g, '').trim()
}

/** 去掉空白 (半角/全角) */
function stripSpace(s: string): string {
  return String(s || '').replace(/[\s　]/g, '')
}

/** 去掉标点 (用于"只差标点"的软判定) */
function stripPunct(s: string): string {
  return stripSpace(s).replace(/[，。！？、；：""''（）《》…—~,.!?;:"'()<>\[\]\-]/g, '')
}

/** 取"角色：台词"形式的一行 (★ 剥掉括号里的状态描述, 与配音链路同口径) */
function splitSpeakerLine(line: string): { speaker: string; text: string } | null {
  const m = String(line || '').match(/^\s*([^：:]{1,12})\s*[：:]\s*(.+)$/)
  if (!m) return null
  const speaker = stripParenNoise(m[1]).trim()
  const text = stripParenNoise(m[2]).trim()
  if (!speaker || !text) return null
  return { speaker, text }
}

/**
 * ★ 解析剧本里的台词行 (只取"角色：台词"形式; 旁白/状态描述行不算台词)。
 */
export function parseScriptDialogue(script: string): ScriptLine[] {
  const out: ScriptLine[] = []
  String(script || '').split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    const sp = splitSpeakerLine(line)
    if (!sp) return
    out.push({ index, raw: line, speaker: sp.speaker, text: sp.text, norm: `${sp.speaker}:${sp.text}` })
  })
  return out
}

/** 拆解出的镜 → 逐句台词 */
export function parseShotDialogue(shot: ShotDialogue): string[] {
  return String(shot.dialogue || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * ★ 逐句比对: 拆解出的台词是否原样来自剧本。
 */
export function checkDialogueVerbatim(
  script: string,
  shots: ShotDialogue[],
): {
  violations: DialogueVerbatimViolation[]
  hardCount: number
  softCount: number
  /** 命中的台词字数 */
  keptChars: number
  /** 剧本台词总字数 */
  totalChars: number
  /** 保留率 (0~1) */
  keepRate: number
} {
  const scriptLines = parseScriptDialogue(script)
  // ★ 比对用【归一化】的 "角色：台词" (剥掉状态描述) —— 剧本里带 "（合上书卷,抬眼）" 的行也能匹配上
  const scriptRaw = scriptLines.map((l) => stripSpace(l.norm))
  const scriptNoPunct = scriptRaw.map((s) => stripPunct(s))
  // ★ 只看【台词正文】(不含角色前缀) —— 截短常见形态是"丢掉前半句, 保留后半句",
  //   带角色前缀去比会因为前缀不在子串里而匹配不上
  const scriptTexts = scriptLines.map((l) => stripSpace(l.text))
  const totalChars = scriptLines.reduce((a, l) => a + stripSpace(l.text).length, 0)

  const violations: DialogueVerbatimViolation[] = []
  let keptChars = 0

  for (const shot of shots) {
    const lines = parseShotDialogue(shot)
    for (const line of lines) {
      const parsedLine = splitSpeakerLine(line)
      // ★ 同样归一化 (剥掉状态描述) 后再比
      const raw = stripSpace(parsedLine ? `${parsedLine.speaker}:${parsedLine.text}` : line)
      if (!raw) continue
      // 1) 逐字命中 (原样引用) → 完全保留
      if (scriptRaw.includes(raw)) {
        keptChars += stripSpace(parsedLine?.text ?? line).length
        continue
      }
      // 2) 台词正文是某句剧本台词的【子串】→ 前缀被丢了 (截短) → 保留子串的字数, 但记硬违规
      const rawText = stripSpace(parsedLine?.text ?? line)
      if (rawText.length >= 4) {
        const partial = scriptTexts.find((sr) => sr.includes(rawText))
        if (partial) {
          keptChars += stripSpace(parsedLine?.text ?? line).length
          violations.push({
            index: shot.index, shotNumber: shot.shotNumber,
            got: line, expected: '(剧本原句的前半段被丢掉)', kind: 'hard',
          })
          continue
        }
      }
      // 只差标点 → 软违规
      //   ★ 只跟【单行】比 (不跟整篇比) —— 否则"把两句合并成一行"会被误判成"只差标点"
      const noPunct = stripPunct(raw)
      if (noPunct && scriptNoPunct.some((s) => s.includes(noPunct))) {
        keptChars += stripSpace(parsedLine?.text ?? line).length
        violations.push({
          index: shot.index, shotNumber: shot.shotNumber,
          got: line, expected: '(仅标点差异)', kind: 'soft',
        })
        continue
      }
      // 文字被改写/合并/凭空多出 → 硬违规
      let expected = '(剧本里没有这句)'
      for (const l of scriptLines) {
        const t = stripSpace(l.text)
        if (t && (t.includes(raw.slice(0, Math.min(12, raw.length))) || raw.includes(t.slice(0, Math.min(12, t.length))))) {
          expected = l.raw
          break
        }
      }
      violations.push({
        index: shot.index, shotNumber: shot.shotNumber,
        got: line, expected, kind: 'hard',
      })
    }
  }

  const hardCount = violations.filter((v) => v.kind === 'hard').length
  const softCount = violations.length - hardCount
  const keepRate = totalChars > 0 ? Math.min(1, keptChars / totalChars) : 1
  return { violations, hardCount, softCount, keptChars, totalChars, keepRate }
}

/** 硬违规的提示 (给 LLM retry 用) */
export function formatVerbatimViolations(violations: DialogueVerbatimViolation[], limit = 5): string {
  const hard = violations.filter((v) => v.kind === 'hard')
  const lines = hard.slice(0, limit).map((v) =>
    `镜#${v.shotNumber ?? v.index + 1}: "${v.got}" 不是剧本里的原句 (剧本里最接近: ${v.expected})`,
  )
  return lines.join('; ') + (hard.length > limit ? ` …共 ${hard.length} 处` : '')
}

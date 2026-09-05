/**
 * 共享 dialogue 解析器 — 把 storyboard.dialogue 拆成多行 speaker+text
 *
 * 旧 parseDialogueForTTS (在 storyboards.ts + ffmpeg-compose.ts 各一份) 只取**第一个**
 * 冒号前面的角色,然后把整段多角色对白一起送给 TTS,导致单个角色的配音文件里
 * 包含 2 个甚至更多角色的对白(全部用第一个角色音色读)。
 *
 * 新版本:返回 { segments, ignorable } 结构,segments 是 [{ speaker, text }] 数组。
 * 调用方按 speaker 分组合成,保证每个角色用自己的 voice,再用 ffmpeg concat 拼接。
 *
 * 输入格式约定(dialogue 字符串):
 *   "年轻人:听说……这里能用故事换酒？\n老陈:什么故事？\n年轻人:我后悔了。"
 *   - 换行 / \\n / ; 三种分隔都支持
 *   - 冒号(全角:或半角:)识别角色
 *   - 角色名后的括号注释(状态/表情)被去除,例如 "老陈(低头):什么故事？" → speaker="老陈"
 *   - "旁白"/"画外音"/"narrator" 走 narrator 音色(由调用方决定用哪个 voice)
 *   - "环境音"/"bgm" 等标记被识别为 ignorable:true,让合成时跳过
 */
export interface DialogueSegment {
  speaker: string
  text: string
  isNarrator: boolean
}

export interface ParsedDialogue {
  segments: DialogueSegment[]
  ignorable: boolean
  reason?: string  // ignorable 时填原因
}

const NARRATOR_SPEAKERS = /^(旁白|画外音|narrator)$/i
const IGNORABLE_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound\s*effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORABLE_PLAIN = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function stripParenNoise(s: string): string {
  return s.replace(/[（(].+?[)）]/g, '').trim()
}

/**
 * 解析 dialogue 字符串为多行 segments。
 * 始终返回结构 — 不可生成 TTS 时 segments 为空、ignorable 为 true。
 */
export function parseDialogueSegments(dialogue?: string | null): ParsedDialogue {
  const raw = (dialogue || '').trim()
  if (!raw) return { segments: [], ignorable: true, reason: 'empty' }

  // 支持换行 / \n / ; 三种分隔
  const lines = raw
    .replace(/\\n/g, '\n')
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)

  const segments: DialogueSegment[] = []
  for (const line of lines) {
    // 尝试匹配 "角色名:文本" 或 "角色名:（状态）:文本"
    const m = line.match(/^([^:：]{1,40}?)\s*[：:]\s*(.+)$/)
    if (!m) {
      // 整行没有冒号 — 当作旁白
      const t = stripParenNoise(line)
      if (t && !IGNORABLE_PLAIN.test(t)) {
        segments.push({ speaker: '旁白', text: t, isNarrator: true })
      }
      continue
    }
    const speaker = stripParenNoise(m[1])
    const text = stripParenNoise(m[2])
    if (!speaker || !text) continue
    if (IGNORABLE_SPEAKERS.test(speaker) || IGNORABLE_PLAIN.test(text)) continue
    segments.push({
      speaker,
      text,
      isNarrator: NARRATOR_SPEAKERS.test(speaker),
    })
  }

  if (segments.length === 0) {
    return { segments: [], ignorable: true, reason: 'no_speech' }
  }
  return { segments, ignorable: false }
}

/**
 * 自动补回 dialogue 缺失的 speaker 前缀。
 *
 * commit 08c3dba (两阶段 storyboard_breaker 重构) 引入的回归:
 *   planner 的 instructions 没要求 dialogue 必须带 "角色:台词" 前缀,
 *   LLM 经常输出无前缀纯文本 → 下游 parseDialogueSegments 当旁白处理。
 *
 * 修复策略:episode.script_content (AI 改写那层) 有完整 "角色:(状态)台词" 格式,
 *   是 dialogue speaker 信息的源头。用 script_content 反查,自动给没前缀的
 *   dialogue 行补回前缀。
 *
 * 规则:
 *   - 已有前缀的行 → 不动
 *   - 无前缀的行 → 在 script_content 找匹配行,提取 speaker 补回
 *   - 找不到匹配(行长度 < 4 或纯文本无对应) → 保持原样,下游 fallback 走 narrator
 */
export function autoFillSpeakerFromScript(dialogue: string | null | undefined, scriptContent: string | null | undefined): string {
  if (!dialogue || !scriptContent) return dialogue || ''

  // 抽状态括号, 只比较纯文本
  const normalizeText = (s: string) => s.replace(/[（(].+?[)）]/g, '').trim()
  const hasSpeaker = (line: string) => /^([^:：]{1,40}?)\s*[：:]/.test(line.trim())

  // 把 script_content 解析成 [{ speaker, text }] 索引
  const scriptLines = scriptContent
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = l.match(/^([^:：]{1,40}?)\s*[：:]\s*(.+)$/)
      if (!m) return null
      return { speaker: m[1].trim(), text: normalizeText(m[2]) }
    })
    .filter((x): x is { speaker: string; text: string } => !!x)

  if (!scriptLines.length) return dialogue

  // 逐行处理 dialogue (支持换行 / \\n / ; 三种分隔)
  const dialogueLines = dialogue
    .replace(/\\n/g, '\n')
    .split(/\r?\n|;/)
    .map(l => l.trim())
    .filter(Boolean)

  const fixed = dialogueLines.map(line => {
    if (hasSpeaker(line)) return line  // 已有前缀 → 不动
    const lineText = normalizeText(line)
    if (lineText.length < 4) return line  // 太短(嗯/好)→ 不补,避免误匹配

    // 找脚本里包含该文本(反过来也算)的行
    const matched = scriptLines.find(sl => {
      if (sl.text.includes(lineText)) return true  // 精确摘取
      if (lineText.includes(sl.text) && sl.text.length >= lineText.length * 0.5) return true  // 含原文 + 比例合理
      return false
    })

    if (matched) return `${matched.speaker}: ${line}`
    return line  // 找不到 → 保持原样,下游 fallback 走 narrator
  })

  return fixed.join('\n')
}


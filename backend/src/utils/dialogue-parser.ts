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

/**
 * 检测并拆分单行多角色对白
 * 现实场景: LLM 经常把 3 句对话挤到一个 storyboard.dialogue 里,
 * 格式如 "(试探地)听说……  老陈:(头也没抬)什么故事?  年轻人:(抿了抿嘴)我后悔了。"
 * 这种行里包含多个 "角色名:文本" 模式, 应当按边界拆成多行让后续按行处理。
 *
 * 触发条件: 行内出现 ≥2 个 "角色名:" 模式 (排除纯时间戳)
 * 拆分边界: 每个 "角色名:" 前缀位置
 *
 * 启发式角色名识别: 中文 2-8 字 + (半角/全角)冒号, 角色名后常带括号状态注释
 *
 * 例子:
 *   "（试探地）听说……  老陈：（头也没抬）什么故事？  年轻人：（抿了抿嘴）我后悔了。"
 *   → [
 *       "（试探地）听说……",
 *       "老陈：（头也没抬）什么故事？",
 *       "年轻人：（抿了抿嘴）我后悔了。"
 *     ]
 */
export function splitMultiSpeakerLine(line: string): string[] {
  if (!line || !line.trim()) return [line]
  // 匹配 "中文 2-8 字 + 冒号" 或 "英文/拼音 + 冒号", 至少 2 个才拆
  const segmenter = /(?<=[\s　]|^)([一-龥A-Za-z0-9_]{2,8})[\s　]*[:：]\s*(?=\S)/g
  const matches: Array<{ index: number; speaker: string; prefixLen: number }> = []
  let m: RegExpExecArray | null
  while ((m = segmenter.exec(line)) !== null) {
    // 排除看起来像时间戳的伪匹配 (如 "12:30", "15:00")
    const candidate = m[1]
    if (/^\d+$/.test(candidate)) continue
    matches.push({
      index: m.index,
      speaker: candidate,
      prefixLen: m[1].length,
    })
  }
  if (matches.length < 2) return [line]  // 只有 0-1 个角色 → 不拆, 保持原样
  // 验证角色名在 script 角色表里至少出现 1 个, 才认定是真多角色对话
  // 简化: 启发式 — 要求每个匹配前后有合理间隔 (≥4 个非空字符), 避免误拆
  // 跳过 — 直接按 matches 拆分, 上层 autoFillSpeakerFromScript 会处理
  const parts: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length
    parts.push(line.slice(start, end).trim())
  }
  // 第一个分段前面的"前缀" (状态/动作描述) 拼回去
  const leadingPrefix = line.slice(0, matches[0].index).trim()
  if (leadingPrefix) {
    // 前缀可能是"（试探地）" 状态注释, 附给第一段
    parts[0] = leadingPrefix + ' ' + parts[0]
  }
  return parts.filter(Boolean)
}

/** 抽掉状态括号, 只比较纯文本 */
export function stripParenNoise(s: string): string {
  return s.replace(/[（(].+?[)）]/g, '').trim()
}

/** 判断一行是否已有 "角色名:" 前缀 */
export function hasSpeakerPrefix(line: string): boolean {
  return /^([^:：]{1,40}?)\s*[：:]/.test(line.trim())
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
  for (const rawLine of lines) {
    // 2026-09-12 review: 单行多角色拆分 — LLM 把 3 句对话挤到一行时,
    // 拆成多段后每段独立匹配 speaker:前缀, 避免下游 TTS 用单角色音色读整段
    const subLines = splitMultiSpeakerLine(rawLine)
    for (const line of subLines) {
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
    }  // end for subLine
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

  // 把 script_content 解析成 [{ speaker, text }] 索引
  const scriptLines = scriptContent
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = l.match(/^([^:：]{1,40}?)\s*[：:]\s*(.+)$/)
      if (!m) return null
      return { speaker: m[1].trim(), text: stripParenNoise(m[2]) }
    })
    .filter((x): x is { speaker: string; text: string } => !!x)

  if (!scriptLines.length) return dialogue

  // 2026-09-12 review: 先按多角色切分 — LLM 经常把 3 句对话挤到一行
  // 拆完后每个分段会按角色-台词格式独立处理
  const rawLines = dialogue
    .replace(/\\n/g, '\n')
    .split(/\r?\n|;/)
    .map(l => l.trim())
    .filter(Boolean)
  const dialogueLines: string[] = []
  for (const line of rawLines) {
    const sub = splitMultiSpeakerLine(line)
    if (sub.length > 1) {
      // 拆分后保留前导状态注释到第一段 (splitMultiSpeakerLine 已处理)
      dialogueLines.push(...sub)
    } else {
      dialogueLines.push(line)
    }
  }

  const fixed = dialogueLines.map(line => {
    if (hasSpeakerPrefix(line)) return line  // 已有前缀 → 不动
    const lineText = stripParenNoise(line)
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


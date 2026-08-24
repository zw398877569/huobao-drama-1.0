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

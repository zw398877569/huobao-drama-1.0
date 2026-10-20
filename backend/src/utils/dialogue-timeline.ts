/**
 * Sprint 16 (PM msg-20261020-072) 补正了两处 Sprint 15 的问题:
 *   1) <n> 标签格式: Sprint 15 用了闭合形式 <n>0-4s</n>, 但本项目【一直】用不闭合形式
 *      (skills/storyboard_breaker/SKILL.md + planner prompt + 全量拆解路径 都是 `<n>0-3秒：内容`),
 *      <n> 是「段落分隔符」不是自闭合标签。两种混在一个 prompt 里 H3 会解析不一致。
 *   2) 时间轴可能超出视频时长 (音频 9.7s / 视频 9s), 现在按 maxSec 截断。
 *
 * Sprint 15 (PM msg-20261020-075): 台词时间轴
 *
 * 把 storyboards.tts_segments 的每段配音换算成 [startSec, endSec] 区间, 拼进 video_prompt
 * 的描述段, 让 H3 知道「什么时间、谁、说什么」, 口型才能跟音频对上。
 *
 * 背景: Sprint 14 已经把 tts_audio_url 作为 ref_audio_0 传给 H3 了, 但 prompt 里只有动作没有台词。
 *   用户 2026-10-20 实测: 「传了语音没问题, 但生成视频后配音完全不对」—— H3 不知道该让谁在
 *   什么时候张嘴。本模块补上这半边: prompt 说「0.0-3.9s 王秀兰开口:xxx」, 音频说同一句。
 *
 * ⚠️ 关键不变量 (Sprint 15 Task C, 已核实):
 *   本模块的区间必须跟【拼接后的整段音频】的时间轴一致, 不能跟字幕的时间轴一致。
 *   tts-concat 用 ffmpeg concat demuxer 无缝拼接 (段与段之间没有 gap), 所以「按段时长累加」
 *   正好等于 ref_audio_0 里那句台词的真实起始时间。
 *   别参考 ffmpeg-compose 的字幕算法 —— 那边 LEAD_IN=0.5s + GAP=0.15s/段 是字幕观感需求,
 *   音频里没有这些偏移, 照抄会让 prompt 跟音频差最多 0.5 + 0.15×n 秒。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { probeDuration } from './ffprobe-helpers.js'
import { logTaskWarn } from './task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

/** H3 prompt 上限 (平台文档: prompt 1-10000 字符) */
export const H3_PROMPT_MAX_CHARS = 10000

export interface DialogueTimelineItem {
  speaker: string
  text: string
  startSec: number
  endSec: number
}

export interface DialogueTimelineResult {
  items: DialogueTimelineItem[]
  /** 全部有效段累加的总时长 (= 拼接音频时长, 不含 lead-in / gap, 不受 maxSec 截断影响) */
  totalSec: number
  /** 因为文件缺失/测不到时长被跳过的段数 */
  skippedCount: number
  /** 解析或过滤掉的段数 (含旁白) */
  filteredCount: number
  /** 因为超出 maxSec 被丢弃或截断的段数 */
  truncatedCount: number
}

/**
 * 相对路径 → 绝对路径。
 * 跟 ffmpeg-compose.toAbsPath 同规则 (那段是模块私有的, 这里不跨文件改它)。
 * ⚠️ 'static/' 前缀必须保留 —— tts-concat 产物的路径格式是 static/audio/xxx.mp3,
 *    去掉前缀会拼成 data/audio/xxx.mp3 找不到文件 (Sprint 15 调研已踩过)。
 */
function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/** 保留 1 位小数 —— H3 不会按毫秒对齐, 写太精确反而像在暗示精度 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * 算台词时间轴。
 *
 * @param ttsSegmentsJson storyboards.tts_segments 的 JSON 字符串 (null/空 → 返回空结果)
 * @param storyboardId    只用于日志定位
 *
 * 行为约定 (工单验收点):
 * - isNarrator === true 的段直接丢掉 (用户 2026-10-20 拍板: 旁白是画外音, 画面里没人张嘴,
 *   塞进 ref_audio 会让 H3 误以为要动嘴)
 * - 单段文件不存在 / ffprobe 测不到时长 → 跳过该段 + logTaskWarn, 绝不抛异常崩掉视频生成
 * - 全部段无效 → 返回空 items, 调用方退回现状 (prompt 一个字都不加)
 * - ⚠️ tts-concat 目前【没有】回填 durationMs (ffmpeg-compose.ts 的注释说回填了, 实际没有),
 *   所以这里 durationMs 只是「万一以后补上了」的快路径, 主力还是 ffprobe。
 */
export async function buildDialogueTimeline(
  ttsSegmentsJson: string | null | undefined,
  storyboardId: number | null | undefined,
  /** 视频时长上限 (秒)。超过这个点的段会被截断/丢弃 —— prompt 时间码不能超出画面时长 */
  maxSec?: number | null,
): Promise<DialogueTimelineResult> {
  const empty: DialogueTimelineResult = { items: [], totalSec: 0, skippedCount: 0, filteredCount: 0, truncatedCount: 0 }
  if (!ttsSegmentsJson) return empty

  let parsed: any
  try {
    parsed = JSON.parse(ttsSegmentsJson)
  } catch (err: any) {
    logTaskWarn('VideoTask', 'tts-segments-parse-failed', {
      storyboardId,
      error: err?.message,
    })
    return empty
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return empty

  const items: DialogueTimelineItem[] = []
  let skippedCount = 0
  let filteredCount = 0
  let truncatedCount = 0
  let cursor = 0
  const cap = maxSec && maxSec > 0 ? maxSec : null

  for (const seg of parsed) {
    const speaker = String(seg?.speaker || '').trim()
    const text = String(seg?.text || '').trim()

    // 旁白不处理 (用户拍板)
    if (seg?.isNarrator === true) {
      filteredCount++
      continue
    }
    if (!text) {
      filteredCount++
      continue
    }

    // 时长: 优先 durationMs (未来 tts-concat 补上的话), 否则 ffprobe 实测
    let durationSec = Number(seg?.durationMs ?? 0) / 1000
    if (!(durationSec > 0) && seg?.segmentPath) {
      const absPath = toAbsPath(String(seg.segmentPath))
      if (fs.existsSync(absPath)) {
        durationSec = await probeDuration(absPath)
      } else {
        logTaskWarn('VideoTask', 'dialogue-segment-missing', {
          storyboardId,
          speaker,
          segmentPath: seg.segmentPath,
          resolvedPath: absPath,
        })
      }
    }

    if (!(durationSec > 0)) {
      // 测不到时长 → 跳过该段。不抛异常: 配音文件被清掉 / ffprobe 挂掉都不该阻断视频生成
      skippedCount++
      continue
    }

    const startSec = round1(cursor)
    cursor += durationSec

    // Sprint 16: 音频可能比视频长 (shot 17 = 9.7s 音频 / 9s 视频)。
    //   prompt 里的时间码超出画面时长没有意义 —— H3 只会生成 duration 那么长的画面,
    //   多出来的时间轴要么被忽略, 要么把后面的段落挤出画面。
    //   整段都在画面之外 → 丢弃; 跨边界 → 保留但把 endSec 收到 duration (台词说不完, 但至少位置对)
    if (cap != null && startSec >= cap) {
      truncatedCount++
      continue
    }
    const endSec = cap != null ? Math.min(round1(cursor), round1(cap)) : round1(cursor)
    if (cap != null && round1(cursor) > round1(cap)) truncatedCount++
    items.push({ speaker, text, startSec, endSec })
  }

  return { items, totalSec: round1(cursor), skippedCount, filteredCount, truncatedCount }
}

/**
 * 格式化成 H3 认识的台词段。
 *
 * 格式: `<n>0-4秒：王秀兰开口:'我姓王,八三年的。'`
 *
 * ⚠️ Sprint 16 修正: Sprint 15 用的是闭合形式 `<n>0-4s</n> ...`, 但本项目【一直】用不闭合形式
 *   (skills/storyboard_breaker/SKILL.md:48-49 + planner prompt + 全量拆解路径 都是
 *   `<n>3-6秒：内容`) —— <n> 在 H3 这里是「段落分隔符」, 不是自闭合标签。
 *   两种写法混在同一个 prompt 里 H3 会按不同规则切段, 反而更乱。
 *   这里统一成项目规范 (中文「秒」+ 全角冒号), 因为注入发生在【翻译之前】, 此时 prompt 是中文的。
 *
 * 引号转义: 外层用 ASCII 单引号, 所以正文里的 ASCII 单引号要换成全角, 否则闭合错乱。
 *   中文引号 “” 原样保留 (不影响解析, 也是原文语义)。
 */
export function formatDialogueTimeline(items: DialogueTimelineItem[]): string {
  return items
    .map((it) => {
      const safeText = it.text.replace(/'/g, '’')
      const who = it.speaker || '角色'
      return `<n>${it.startSec}-${it.endSec}秒：${who}开口:'${safeText}'`
    })
    .join(' ')
}

/**
 * 数 prompt 里还剩几个「开口:」标记。
 *
 * 用途 (Sprint 16): 台词时间轴现在在【翻译之前】注入, 万一翻译器把它整段吃掉,
 *   prompt 会静默变回「没有台词」的样子 —— 口型又对不上, 而且没有任何报错。
 *   所以翻译前后各数一次, 对不上就 warn + 走降级补注。
 */
export function countDialogueMarkers(prompt: string): number {
  const m = prompt.match(/开口:/g)
  return m ? m.length : 0
}

/**
 * 把台词段注入 prompt 的【描述段】。
 *
 * ⚠️ 绝对不能 append 到 prompt 末尾 —— H3 prompt 是三段式:
 *     Integrated multimodal description / Overall soundscape / Non-diegetic music
 *   末尾是配乐段, 台词掉进去 H3 会当成配乐描述, 口型照样对不上 (Sprint 15 调研发现的坑)。
 *   正确位置是 "Overall soundscape:" 之前, 也就是描述段的末尾。
 *
 * 匹配大小写/分隔符不敏感 (翻译器可能写出 Overall_Soundscape: / OVERALL SOUNDSCAPE:)。
 */
export function injectDialogueTimeline(prompt: string, timelineText: string): string {
  return insertIntoIntegrated(prompt, (timelineText || '').trim())
}

/**
 * Sprint 16 / Bug-B: 把【原始台词】按 saveStoryboards 已有的格式嵌进 integrated 段。
 *
 * 背景: 全量拆解路径 (storyboard-tools.ts:1010 saveStoryboards) 一直有 dialogueInline,
 *   但另外两条构造 video_prompt 的路径都没有 ——
 *     - updateStoryboard (单镜头重拆, sprint-10 加的增量功能)
 *     - storyboard-planner-service (V4 planner 全量拆解)
 *   两条路径产出的 video_prompt 都不含台词, 而 H3 是靠 prompt 里的台词决定谁张嘴的。
 *
 * 格式跟 saveStoryboards 保持一致 (` 开口:'...'` 拼在动作描述后), 三条路径最终收敛成同一种形状。
 * 没台词 → 原样返回, 不改变任何现有行为。
 */
export function embedDialogueInline(prompt: string, dialogue: string | null | undefined): string {
  const d = (dialogue || '').trim()
  if (!d) return prompt
  // 已经有 开口: 就别再嵌一遍 —— planner 路径的 Step2 prompt (sprint-15-a) 已经要求 LLM
  // 自己把台词写进 video_prompt_plot_state, LLM 照做了的话再补一次就成了重复台词。
  if (countDialogueMarkers(prompt) > 0) return prompt
  return insertIntoIntegrated(prompt, `开口:'${d.replace(/'/g, '’')}'`)
}

/**
 * 往 H3 三段式 prompt 的【描述段】末尾插一段文本。
 *
 * ⚠️ 不能插到 prompt 末尾 —— 末尾是 Non-diegetic music 段, 台词掉进去 H3 会当成配乐描述
 *   (Sprint 15 调研发现的坑)。header 匹配大小写/分隔符不敏感 (翻译器会写出
 *   Overall_Soundscape: / OVERALL SOUNDSCAPE: 等变体)。
 */
function insertIntoIntegrated(prompt: string, text: string): string {
  const block = (text || '').trim()
  if (!block) return prompt

  const headerRe = /^[ \t]*(?:overall[\s_-]+soundscape|non[\s_-]+diegetic[\s_-]+music)[\s_-]*:/im
  const m = headerRe.exec(prompt)
  if (m && m.index != null) {
    const head = prompt.slice(0, m.index).trimEnd()
    const tail = prompt.slice(m.index)
    return `${head}\n\n${block}\n\n${tail}`
  }
  // 没有三段式 header (比如自由创作没走 ensureH3ThreePartPrompt) → 直接接在末尾
  return `${prompt.trimEnd()}\n\n${block}`
}

/**
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
  /** 全部有效段累加的总时长 (= 拼接音频时长, 不含 lead-in / gap) */
  totalSec: number
  /** 因为文件缺失/测不到时长被跳过的段数 */
  skippedCount: number
  /** 解析或过滤掉的段数 (含旁白) */
  filteredCount: number
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
): Promise<DialogueTimelineResult> {
  const empty: DialogueTimelineResult = { items: [], totalSec: 0, skippedCount: 0, filteredCount: 0 }
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
  let cursor = 0

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
    items.push({ speaker, text, startSec, endSec: round1(cursor) })
  }

  return { items, totalSec: round1(cursor), skippedCount, filteredCount }
}

/**
 * 格式化成 H3 认识的台词段。
 *
 * 格式: `<n>0.0-3.9s</n> 王秀兰开口:'我姓王,八三年的。'`
 *
 * 为什么用 `<n>` 时间码而不是工单原写的 `王秀兰开口:'台词'(0.0-3.9s)`:
 *   `<n>` 分段是本项目【已经在用】的 H3 描述段时间码格式 (planner prompt 让 LLM 按 <n> 分段,
 *   translateVideoPromptToEnglish 也专门保护 <n>0-3s</n> 不让翻译器改), H3 对这个格式最熟;
 *   而时间轴挂在引号后面容易被当成台词的一部分被念出来。
 *
 * 引号转义: 外层用 ASCII 单引号, 所以正文里的 ASCII 单引号要换成全角, 否则闭合错乱。
 *   中文引号 “” 原样保留 (不影响解析, 也是原文语义)。
 */
export function formatDialogueTimeline(items: DialogueTimelineItem[]): string {
  return items
    .map((it) => {
      const safeText = it.text.replace(/'/g, '’')
      const who = it.speaker || '角色'
      return `<n>${it.startSec}-${it.endSec}s</n> ${who}开口:'${safeText}'`
    })
    .join(' ')
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
  const timeline = (timelineText || '').trim()
  if (!timeline) return prompt

  const headerRe = /^[ \t]*(?:overall[\s_-]+soundscape|non[\s_-]+diegetic[\s_-]+music)[\s_-]*:/im
  const m = headerRe.exec(prompt)
  if (m && m.index != null) {
    const head = prompt.slice(0, m.index).trimEnd()
    const tail = prompt.slice(m.index)
    return `${head}\n\n${timeline}\n\n${tail}`
  }
  // 没有三段式 header (比如自由创作没走 ensureH3ThreePartPrompt) → 直接接在末尾
  return `${prompt.trimEnd()}\n\n${timeline}`
}

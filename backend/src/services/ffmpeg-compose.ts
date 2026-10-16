/**
 * FFmpeg 单镜头合成 — 视频 + TTS音频 + 烧录字幕
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { generateTTS } from './tts-generation.js'
import { generateTTSForDialogue } from './tts-concat.js'
import { parseDialogueSegments } from '../utils/dialogue-parser.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
// Sprint 11 Task C/D/E (PM msg-20261016-001): ffprobe 实测媒体信息, 不再用估算值
import { probeMedia, probeDuration, formatSrtTimestamp } from '../utils/ffprobe-helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')
let subtitleFilterSupport: boolean | null = null
function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function supportsSubtitleFilter(): boolean {
  if (subtitleFilterSupport != null) return subtitleFilterSupport
  try {
    const output = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
    subtitleFilterSupport = /\bsubtitles\b/.test(output)
  } catch {
    subtitleFilterSupport = false
  }
  return subtitleFilterSupport
}

/**
 * 合成单个镜头：视频 + TTS对白音频 + 烧录字幕
 */
export async function composeStoryboard(storyboardId: number): Promise<string> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)
  if (!sb.videoUrl) throw new Error(`Storyboard ${storyboardId} has no video`)
  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  logTaskStart('ComposeTask', 'storyboard-compose', {
    storyboardId,
    storyboardNumber: sb.storyboardNumber,
    episodeId: sb.episodeId,
  })

  const videoPath = toAbsPath(sb.videoUrl)
  let audioPath: string | null = null
  let subtitlePath: string | null = null

  // 1. 生成 TTS 音频(如果有对白) — 2026-08-24 多角色分段合成
  try {
    if (sb.ttsAudioUrl) {
      const existingAudioPath = toAbsPath(sb.ttsAudioUrl)
      if (fs.existsSync(existingAudioPath)) {
        audioPath = existingAudioPath
      }
    }
    if (!audioPath) {
      logTaskProgress('ComposeTask', 'generate-inline-tts', { storyboardId })
      const ttsResult = await generateTTSForDialogue(storyboardId, sb.episodeId, sb.dialogue)
      if (!ttsResult.ignored && ttsResult.audioPath) {
        audioPath = toAbsPath(ttsResult.audioPath)
        db.update(schema.storyboards)
          .set({
            ttsAudioUrl: ttsResult.audioPath,
            ttsSegments: JSON.stringify(ttsResult.segments),
            updatedAt: now(),
          })
          .where(eq(schema.storyboards.id, storyboardId))
          .run()
      }
    }
    // Sprint 11 Task C/D/E 共用: ffprobe 实测原视频 (时长 + 有无音轨)。
    //   D 的对齐基准、E 的字幕末尾对齐、C 的原声保留判定都以此为准,
    //   不用 storyboard.duration 估算值 (估算值跟实测有偏差, 本身由 msg-20261016-002 R1 治)。
    const videoProbe = await probeMedia(videoPath)
    const videoDuration = videoProbe.durationSec > 0 ? videoProbe.durationSec : (sb.duration || 10)

    // 2. 生成字幕文件（SRT）— Sprint 11 Task E (PM msg-20261016-001)
    //   修前: 单条字幕 + join(' ') 挤成一大坨 + 时间轴用 sb.duration 估算值写死
    //         → 多角色对白全部一起出, 跟配音逐句输出完全对不上; FontSize=20 在竖屏几乎看不清
    //   修后: 按 ttsSegments 逐句切分, 每句一条字幕, 段间 150ms gap
    //         时间轴基准 = ffprobe 实测每段 segmentPath 真实时长累积 (不用估算值)
    //         speaker 字段已有, 用于字幕前缀 (如 '男人：')
    //         最后一段结束时间对齐视频实际时长 (ffprobe), 避免字幕比画面先消失
    if (sb.dialogue && sb.dialogue.trim()) {
      // 优先用 ttsSegments (逐句真实数据); 拿不到时 fallback 到 dialogue 解析 (退化成单条)
      let segments: Array<{ speaker: string; text: string; segmentPath?: string; isNarrator?: boolean; durationMs?: number }> = []
      if (sb.ttsSegments) {
        try {
          const parsed = JSON.parse(sb.ttsSegments)
          if (Array.isArray(parsed) && parsed.length > 0) segments = parsed
        } catch {
          logTaskWarn('ComposeTask', 'tts-segments-parse-failed', { storyboardId })
        }
      }
      if (segments.length === 0) {
        segments = parseDialogueSegments(sb.dialogue).segments.map(s => ({
          speaker: s.speaker || '',
          text: s.text,
          isNarrator: s.isNarrator,
        }))
      }

      if (segments.length > 0) {
        const srtDir = path.join(STORAGE_ROOT, 'subtitles')
        fs.mkdirSync(srtDir, {recursive: true })
        const srtFilename = `${uuid()}.srt`
        subtitlePath = path.join(srtDir, srtFilename)

        // 逐句累积时间轴 (videoProbe / videoDuration 见上方共用段)
        const GAP = 0.15      // 段间隔, 避免两句字幕连得太紧
        const LEAD_IN = 0.5   // 首句延后 0.5s 上屏 (跟旧实现 00:00:00,500 一致)
        const srtLines: string[] = []
        let cursor = LEAD_IN
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]
          // 段真实时长: 优先 durationMs (tts-concat 已回填), 否则 ffprobe segmentPath
          let segDuration = Number(seg.durationMs ?? 0) / 1000
          if (!(segDuration > 0) && seg.segmentPath) {
            const absSeg = toAbsPath(seg.segmentPath)
            if (fs.existsSync(absSeg)) {
              segDuration = await probeDuration(absSeg)
            }
          }
          // 兜底: 都没测到时按中文 4.5 字/秒估算 (跟 computeDialogueFloor 同量级)
          if (!(segDuration > 0)) {
            const chars = (seg.text || '').replace(/\s/g, '').length
            segDuration = Math.max(0.8, chars / 4.5)
          }

          const start = cursor
          let end = start + segDuration
          // 累积超出画面时提前截断, 避免字幕溢出
          if (start >= videoDuration) break
          // 最后一段: 结束时间对齐视频实际时长 (不超画面)
          if (i === segments.length - 1 && end > videoDuration) {
            end = videoDuration
          }

          const prefix = seg.speaker && !seg.isNarrator ? `${seg.speaker}：` : ''
          srtLines.push(
            String(srtLines.filter(l => /^\d+$/.test(l)).length + 1),
            `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`,
            `${prefix}${seg.text}`,
            '',
          )
          cursor = end + GAP
        }

        if (srtLines.length > 0) {
          fs.writeFileSync(subtitlePath, srtLines.join('\n'), 'utf-8')
          const srtRelative = `static/subtitles/${srtFilename}`
          db.update(schema.storyboards).set({ subtitleUrl: srtRelative, updatedAt: now() })
            .where(eq(schema.storyboards.id, storyboardId)).run()
          logTaskProgress('ComposeTask', 'srt-generated', {
            storyboardId,
            segmentCount: segments.length,
            cueCount: srtLines.filter(l => /^\d+$/.test(l)).length,
            videoDuration: Number(videoDuration.toFixed(3)),
          })
        }
      }
    }

    // 3. FFmpeg 合成
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, {recursive: true })
    const outputFilename = `${uuid()}.mp4`
    const outputPath = path.join(outputDir, outputFilename)

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)

      if (audioPath) {
        cmd = cmd.input(audioPath)
      }

      const filters: string[] = []

      if (subtitlePath && supportsSubtitleFilter()) {
        const escapedPath = subtitlePath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
        // Sprint 11 Task E: FontSize 20 → 32 (1080x1920 竖屏上 20 几乎看不清), 保留 Outline=2 黑边
        const forceStyle = 'FontSize=32\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2'
        filters.push(`subtitles=filename='${escapedPath}':force_style='${forceStyle}'`)
      } else if (subtitlePath) {
        logTaskProgress('ComposeTask', 'subtitle-filter-unavailable', {
          storyboardId,
          subtitlePath,
        })
      }

      if (filters.length > 0) {
        cmd = cmd.videoFilter(filters)
      }

      const outputOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']

      if (audioPath) {
        // Sprint 11 Task D (PM msg-20261016-001): 去 -shortest, 改显式对齐。
        //   修前问题: `-shortest` 让输出停在【较短的那一路】结束点 —
        //     音频比视频短 → 画面尾巴被截 (实测 shot 11: 6.58s → 4.67s, 截 29%)
        //     音频比视频长 → 音频被截 (话音没说完就没了)
        //   修后: 视频始终按【原视频真实时长】完整输出, 音频侧用 filter_complex 显式对齐:
        //     apad  → 音频不足时补静音 (避免话音刚落画面就静默)
        //     atrim → 音频超出时裁到视频时长 (而不是裁画面)
        //   时长基准 = 上方 videoProbe.durationSec (ffprobe 实测), 不用 sb.duration 估算值。
        //
        //   仍保留 `-map -0:a`: 显式 strip 输入 0 (H3 原视频) 的音轨,
        //   防止 H3 自带 BGM/环境音跟 TTS 配音叠加混进成品。
        const align = `[1:a]apad,atrim=0:${videoDuration.toFixed(3)},asetpts=N/SR/TB[aout]`
        outputOptions.push(
          '-filter_complex', align,
          '-map', '0:v',
          '-map', '[aout]',
          '-map', '-0:a',
          '-c:a', 'aac',
          '-ar', '48000',
        )
        logTaskProgress('ComposeTask', 'compose-align-audio', {
          storyboardId,
          videoDuration: Number(videoDuration.toFixed(3)),
          hasTts: true,
        })
      } else if (videoProbe.hasAudio) {
        // Sprint 11 Task C (PM msg-20261016-001): 无对白时【保留 H3 原声】。
        //   修前问题: audioPath 为 null 时走 `-an` 把原视频自带的环境音/BGM 一并删掉
        //     → 画面跟原始一模一样、声音还少了, 属于负优化。
        //     这也是用户"看不出来合成干了啥"的直接原因之一 (16/19 镜头走这条分支)。
        //   修后: 有对白 → TTS 替换原声 (维持现状, 不做 mix, 混音是独立需求);
        //         无对白 → 保留原声 (-c:a aac 统一编码, 避免不同编码拼接时出问题)。
        //   前提: 必须先 ffprobe 确认原视频真的有音轨, 否则 `-map 0:a` 会报错。
        //         依赖 Task A 修好后 H3 视频会带真实环境音, 保留原声才有实际内容
        //         (A 让原声有内容, C 不再删它, A+C 配套才完整)。
        outputOptions.push('-map', '0:v', '-map', '0:a', '-c:a', 'aac', '-ar', '48000')
        logTaskProgress('ComposeTask', 'compose-keep-original-audio', {
          storyboardId,
          videoDuration: Number(videoDuration.toFixed(3)),
          hasTts: false,
        })
      } else {
        // 原视频本身无音轨 (H3 静音输出), 保留不了也无可保留
        outputOptions.push('-an')
        logTaskProgress('ComposeTask', 'compose-no-audio-at-all', {
          storyboardId,
          videoDuration: Number(videoDuration.toFixed(3)),
          hasTts: false,
          originalHasAudio: false,
        })
      }

      cmd.outputOptions(outputOptions)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({ composedVideoUrl: composedRelative, status: 'compose_completed', updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      output: composedRelative,
    })
    return composedRelative
  } catch (err) {
    db.update(schema.storyboards)
      .set({ status: 'compose_failed', composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    throw err
  }
}

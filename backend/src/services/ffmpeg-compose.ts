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
import { getEpisodeSpeakerWhitelist } from '../utils/speaker-whitelist.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
// Sprint 11 Task C/D/E (PM msg-20261016-001): ffprobe 实测媒体信息, 不再用估算值
import { probeMedia, probeDuration, formatSrtTimestamp } from '../utils/ffprobe-helpers.js'
// ★ Sprint 38 T3-D (PM msg-20261110-165): 音驱动工作流清单 (决定源音轨能不能保留)
import { AutoDLComfyUIWorkflowAdapter } from './adapters/autodl-comfyui-workflow.js'
// ★ Sprint 39 T4 (PM msg-20261111-169): 字幕烧录时机开关 (compose = 在这里烧 (默认); merge = 在拼接阶段烧)
import { readMergeSettings } from './ffmpeg-merge.js'

/**
 * 容器里 Noto CJK 字体的安装目录 (Dockerfile Stage 3 装了 fonts-noto-cjk)。
 * Sprint 23 Task F: subtitles filter 强制带 fontsdir —— libass 靠 fontconfig 找系统字体,
 * 容器没装中文字体时中文全是豆腐块 (QA msg-20261024-081 的 P0)。
 * 实际安装路径以 CI 构建日志里那行 fc-list 为准。
 */
const SUBTITLE_FONTS_DIR = '/usr/share/fonts/opentype/noto'
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
 * ★ Sprint 38 T3-D (PM msg-20261110-165): 这个镜的【源音轨里有没有我们的人声】?
 *
 * 【背景】音驱动工作流 (zm_u24 / zm_u08 / image_audio_to_video_v2[_15s] / 803) 生成视频时,
 *   我们把配好的 TTS 当 ref_audio_0 传了进去 → 平台按【我们的音色】对口型
 *   → 源音轨里就是我们的人声, 而且嘴型跟着它走。
 *   合成阶段以前把源音轨【换成一份重新对齐到 0 秒的 TTS】→ 声音和嘴型就错开了
 *   (实测 drama19/ep20 镜#16 差 0.42s), 而且源音轨里的环境音 (雨声) 也一起被丢掉了。
 *
 * 【判定方式】结构性判定, 不是靠音量猜 (雨夜环境音的音量并不低):
 *   ① 该镜的视频是用【音驱动工作流】生成的 → 源音轨里必然有我们的人声 → 保留
 *   ② 视频生成时没有换过 workflow (fallbackReason 若是『换了 workflow』那类 → 不保留:
 *      换过去的 T2V/普通 Ref2V 不吃音频, 源音轨里没有人声, 保留了就等于把台词丢了)
 *   ③ 源视频压根没有音轨 → 保留不了 → 用 TTS
 *   ④ 非音驱动工作流 (lightx2v 家族) → 源音轨里没有人声 → 仍用 TTS 替换 (行为与现在一致)
 */
/** ★ Sprint 38 T3-D: 换过 workflow 的原因码 → 换过去的工作流可能不吃音频 → 源音轨里没有人声 */
const WORKFLOW_REPLACED_REASONS = ['mode_mismatch_no_images', 'model_not_supported', 'no_audio_fallback']

/**
 * ★ Sprint 38 T3-D: 判定【要不要保留源音轨】(纯函数 → 可离线断言)。
 *   保留 = 源音轨里就是我们的人声 (音驱动工作流生成 + 没换过 workflow + 源视频有音轨 + 本镜有对白)
 */
export function decideSourceVoice(input: {
  model?: string | null
  fallbackReason?: string | null
  sourceHasAudio?: boolean
  hasTts?: boolean
}): { keep: boolean; reason: string } {
  const model = String(input.model || '')
  if (!input.hasTts) return { keep: false, reason: 'no-tts' }
  if (!input.sourceHasAudio) return { keep: false, reason: 'source-has-no-audio-track' }
  if (!model) return { keep: false, reason: 'no-video-generation-record' }
  if (!(AutoDLComfyUIWorkflowAdapter.AUDIO_DRIVEN_WORKFLOWS as readonly string[]).includes(model)) {
    return { keep: false, reason: 'not-audio-driven-workflow' }
  }
  if (WORKFLOW_REPLACED_REASONS.includes(String(input.fallbackReason || ''))) {
    return { keep: false, reason: `workflow-replaced(${input.fallbackReason})` }
  }
  return { keep: true, reason: 'audio-driven-workflow' }
}

/** 取这个镜【当前这条视频】的生成记录 (model + 有没有换过 workflow) */
function getVideoGenerationInfo(
  storyboardId: number,
  videoUrl: string | null | undefined,
): { model: string; fallbackReason: string | null } | null {
  try {
    const rows = db.select({
      id: schema.videoGenerations.id,
      model: schema.videoGenerations.model,
      videoUrl: schema.videoGenerations.videoUrl,
      localPath: schema.videoGenerations.localPath,
      fallbackReason: schema.videoGenerations.fallbackReason,
    }).from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.storyboardId, storyboardId)).all()
    // 重新生成过的镜有多条记录 → 优先取【视频 url 对得上】的那条
    const match = rows.find(r => (r.videoUrl && videoUrl && r.videoUrl === videoUrl)
      || (r.localPath && videoUrl && r.localPath === videoUrl))
    const row: any = match || rows[rows.length - 1]
    if (!row) return null
    return { model: String(row.model || ''), fallbackReason: row.fallbackReason ? String(row.fallbackReason) : null }
  } catch {
    return null
  }
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
        // Sprint 18 (QA msg-20261021-078): 传剧本角色白名单 —— ttsSegments 缺失时走这条 fallback,
        //   同样的多角色不拆问题会让字幕退化成一整段
        segments = parseDialogueSegments(sb.dialogue, getEpisodeSpeakerWhitelist(sb.episodeId)).segments.map(s => ({
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

          // ★ Sprint 25 fix_1 (PM msg-20261027-111): 字幕一律【不带角色名前缀】(PM 2026-10-27 拍板, 选项 B)。
          //   原来这里按 seg.speaker 加 '林达：' 前缀 → 成片字幕形如 '林达：林达，送单的。' 看着重复。
          //   PM 已知并接受 B 的代价 ('林达，送单的。' 可能被误读成半句话 / 多角色快速对话分不清),
          //   明确要求【不要】自作主张改成智能去重 (选项 C)。
          //   ⚠️ 只影响显示层: 台词原文、时间轴、音频对齐、旁白判定全部不动。
          const prefix = ''
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

      // ★ Sprint 39 T4: 开关 = 'merge' 时【不烧】字幕 (由拼接阶段统一烧 → 字幕只过一次有损编码);
      //   SRT 仍然照常写出来 (拼接阶段要用它) → 单镜文件仍然是独立可播放的 mp4 ✔
      const burnSubtitles = readMergeSettings(sb.episodeId).subtitleStage !== 'merge'
      if (subtitlePath && burnSubtitles && supportsSubtitleFilter()) {
        const escapedPath = subtitlePath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
        // Sprint 11 Task E: FontSize 20 → 32, 保留 Outline=2 黑边
        //   ⚠️ Sprint 23 Task F (PM msg-20261027-095 决策 6): 字号【不动】—— 要不要按实际分辨率调
        //   (建议 40-44) 是另一个决策, PM 未拍板, 本单只修下面注释里的事实错误。
        //   原注释写『(1080x1920 竖屏上 20 几乎看不清)』, 但项目实际产出全是 16:9 横屏 1344x768 (实测),
        //   竖屏那个前提假设是错的 → 已改成实际分辨率的描述。
        //   fontsdir 强制指向 Noto CJK 字体目录: libass 通过 fontconfig 发现系统字体, 容器里没装中文字体时
        //   中文全是豆腐块 (QA msg-20261024-081 的 P0 —— 中文字幕从来没成功渲染过一次)。
        //   直接指目录比依赖 family name 匹配更稳: FontName 查不到也不影响 fontsdir 生效 (决策 6)。
        const forceStyle = 'FontSize=32\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2'
        filters.push(`subtitles=filename='${escapedPath}':fontsdir='${SUBTITLE_FONTS_DIR}':force_style='${forceStyle}'`)
      } else if (subtitlePath && burnSubtitles) {
        logTaskProgress('ComposeTask', 'subtitle-filter-unavailable', {
          storyboardId,
          subtitlePath,
        })
      }

      if (filters.length > 0) {
        cmd = cmd.videoFilter(filters)
      }

      // ★ Sprint 41 追加单 177 (PM msg-20261114-177): 补 '-movflags +faststart'
      //   → moov (元数据) 落在文件开头, 浏览器不用把整个文件下完就能起播 (原来 moov 在末尾 → 秒开变"下完才播")
      //   ★ 只改【容器里 moov 的位置】, 编码参数 (码率/画质/分辨率/音轨) 一个字没动 → 成片规格逐字不变
      //   (拼接成片本来就有 faststart, 单镜原始视频 provider 给的也有 → 只有 compose 产出的漏了)
      const outputOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-movflags', '+faststart']

      // ★ Sprint 38 T3-D (PM msg-20261110-165): 源音轨里有我们的人声 (音驱动工作流生成) →
      //   【保留源音轨】, 只烧字幕 —— 嘴型跟着源音轨走 (同步), 环境音也一起回来。
      //   以前这里一律用 TTS 替换源音轨 → 声音重新对齐到 0 秒 → 和嘴型错开 (实测镜#16 差 0.42s),
      //   而且源音轨里的雨声等环境音被丢掉了。
      const videoGenInfo = getVideoGenerationInfo(sb.id, sb.videoUrl)
      const sourceVoice = decideSourceVoice({
        model: videoGenInfo?.model,
        fallbackReason: videoGenInfo?.fallbackReason,
        sourceHasAudio: !!videoProbe.hasAudio,
        hasTts: !!audioPath,
      })
      const keepSourceVoice = sourceVoice.keep

      if (keepSourceVoice) {
        // 源音轨也显式对齐到【视频真实时长】(音频短 → 补静音, 长 → 裁掉), 音画总时长一致
        const align = `[0:a]apad,atrim=0:${videoDuration.toFixed(3)},asetpts=N/SR/TB[aout]`
        outputOptions.push(
          '-filter_complex', align,
          '-map', '0:v',
          '-map', '[aout]',
          '-c:a', 'aac',
          '-ar', '48000',
        )
        logTaskProgress('ComposeTask', 'compose-keep-source-voice', {
          storyboardId,
          videoDuration: Number(videoDuration.toFixed(3)),
          model: videoGenInfo?.model,
          hasTts: true,
          reason: sourceVoice.reason,
          hint: '音驱动工作流: 源音轨里是我们的人声 (嘴型跟着它走) → 保留源音轨, 只烧字幕',
        })
      } else if (audioPath) {
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
          // ★ Sprint 38 T3-D: 为什么没用源音轨 (便于以后排查)
          sourceVoiceReason: sourceVoice.reason,
          sourceVoiceModel: videoGenInfo?.model,
          sourceHasAudioTrack: !!videoProbe.hasAudio,
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

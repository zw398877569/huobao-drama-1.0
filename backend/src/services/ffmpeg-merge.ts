/**
 * FFmpeg 多镜头拼接 — 将所有合成后的镜头视频拼接为一集
 *
 * Sprint 11 Task B + F (PM msg-20261016-001):
 *
 *   B (P0, 最严重) — 拼接丢全部音频:
 *     修前: concat demuxer 遇到流结构不一致的输入 (部分 clip 有 aac 音轨、部分没有)
 *           会【静默降级为纯视频输出, rc=0 不报错】。实测三个成片全是纯视频单流
 *           (merged/f691d993 97s / 2f875e7a 221s / db4a12b1 108s)。
 *     根因: episode 12 的 19 个 composed 片段只有 3 个带音轨 (其余 16 个 compose 时
 *           走了 -an, 由 Task C 修复), 混合流 concat 后音频全丢。
 *     修后: doMerge 前置【音频归一化】— 遍历所有 clip, ffprobe 检测音轨, 缺失的用
 *           ffmpeg -f lavfi -i anullsrc 补一条等长静音轨, 统一 h264+aac+分辨率+帧率
 *           (xfade 硬性要求规格一致)。归一化失败的 clip fail-fast 抛错, 不静默跳过。
 *
 *   F (P2, 依赖 A + B) — 拼接转场:
 *     修后: 相邻 clip 加 200ms xfade 交叉淡化 + 音频 acrossfade。可开关
 *           (MERGE_XFADE=0 关闭), xfade 失败时 fallback 到硬切 concat 而非整个
 *           merge 失败 (质量提升不能以"导出不了"为代价)。
 *
 *   用户 2026-10-16 拍板 D3: sound_effect / bgm_prompt 转真实音频文件本期【不做】
 *   (需新增音频生成能力)。Task A 修好后这两列会进 video_prompt 由 H3 生成。
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
// Sprint 11 Task B/F (PM msg-20261016-001): 归一化前 ffprobe 探测音轨/分辨率/帧率
import { probeMedia, type MediaProbe } from '../utils/ffprobe-helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

// Task F: xfade 转场时长 (秒) — 用户 2026-10-16 拍板 D2 锁定 200ms
//   (>500ms 观感会明显"镜头交叠", 不擅自调大)
const XFADE_DURATION = 0.2
// Task F: 转场开关 (env MERGE_XFADE=0 可关, 便于 QA 做 A/B 对照)
const XFADE_ENABLED = process.env.MERGE_XFADE !== '0'
// Task B: 归一化输出目录
const NORMALIZE_DIR = path.join(STORAGE_ROOT, 'temp', 'merge-normalized')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 拼接一集的所有合成镜头视频
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number): Promise<number> {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const composedStoryboards = storyboards.filter(sb => !!sb.composedVideoUrl)
  if (composedStoryboards.length !== storyboards.length) {
    throw new Error(`Only composed storyboards can be merged (${composedStoryboards.length}/${storyboards.length} ready)`)
  }
  const videos = composedStoryboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) throw new Error('No videos to merge')

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  }).run()
  const mergeId = Number(res.lastInsertRowid)

  // 异步执行
  doMerge(mergeId, episodeId, videos).catch(err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId)).run()
  })

  return mergeId
}

/**
 * Task B: 音频 + 规格归一化 (拼接前置)
 *
 * concat demuxer 遇到流结构不一致的输入会【静默降级为纯视频输出, rc=0 不报错】,
 * 所以必须在 doMerge 前把所有 clip 统一成同一规格:
 *   - 缺音轨 → 用 -f lavfi -i anullsrc 补一条等长静音轨
 *   - 分辨率/帧率 → 统一到第一个 clip 的规格 (xfade 硬性要求一致, 否则失败)
 *   - 编码 → 统一 h264 + aac 48000
 *
 * 任一 clip 归一化失败 → fail-fast 抛错 (静默跳过 = 又一次无声成片)。
 * 注意: 用户明确说速度不是优化目标, 正确性优先, 所以这里逐个转码 (19 clip 会慢)。
 *
 * @returns 归一化后的绝对路径列表 (可直接喂给 concat / xfade)
 */
async function normalizeClips(videos: string[]): Promise<string[]> {
  fs.mkdirSync(NORMALIZE_DIR, { recursive: true })

  const absPaths = videos.map(toAbsPath)
  const probes: MediaProbe[] = []
  for (const p of absPaths) {
    probes.push(await probeMedia(p))
  }

  // 基准规格: 第一个探测成功的 clip (xfade 要求所有输入一致)
  const base = probes.find(p => p.width > 0 && p.height > 0)
  if (!base) {
    throw new Error('normalize-failed: 无法探测任何 clip 的分辨率, 归一化终止')
  }
  const targetW = base.width % 2 === 0 ? base.width : base.width - 1
  const targetH = base.height % 2 === 0 ? base.height : base.height - 1
  const targetFps = base.fps > 0 ? base.fps : 30

  const missingAudio = probes.filter(p => !p.hasAudio).length
  const specMismatch = probes.filter(p =>
    p.width !== targetW || p.height !== targetH || (p.fps > 0 && Math.abs(p.fps - targetFps) > 0.5),
  ).length
  logTaskProgress('MergeTask', 'normalize-plan', {
    clips: videos.length,
    missingAudio,
    specMismatch,
    target: { width: targetW, height: targetH, fps: targetFps },
  })

  const normalized: string[] = []
  for (let i = 0; i < absPaths.length; i++) {
    const src = absPaths[i]
    const probe = probes[i]
    const specOk = probe.width === targetW && probe.height === targetH
      && (probe.fps <= 0 || Math.abs(probe.fps - targetFps) <= 0.5)

    // 规格一致 + 有音轨 → 不用转码, 直接用原文件
    if (probe.hasAudio && specOk) {
      normalized.push(src)
      continue
    }

    const outPath = path.join(NORMALIZE_DIR, `${i}-${uuid()}.mp4`)
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(src)
      if (!probe.hasAudio) {
        // 补一条等长静音轨 (anullsrc), 用 -shortest 截到视频长度
        cmd.inputOptions(['-f', 'lavfi', '-t', String(probe.durationSec || 1), '-i', 'anullsrc=r=48000:cl=stereo'])
      }
      cmd
        .outputOptions([
          '-map', '0:v',
          '-map', probe.hasAudio ? '0:a' : '1:a',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-vf', `scale=${targetW}:${targetH},fps=${targetFps}`,
          '-c:a', 'aac',
          '-ar', '48000',
          '-ac', '2',
          '-shortest',
        ])
        .output(outPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    }).catch((err) => {
      throw new Error(`normalize-failed: clip[${i}] ${videos[i]} 转码失败: ${err.message}`)
    })

    // 转码后回检: 确认真的产出且有音轨 (fail-fast, 不静默跳过)
    const after = await probeMedia(outPath)
    if (!after.hasAudio || after.durationSec <= 0) {
      throw new Error(
        `normalize-failed: clip[${i}] ${videos[i]} 归一化后仍无音轨或零时长 ` +
        `(hasAudio=${after.hasAudio}, duration=${after.durationSec})`
      )
    }
    normalized.push(outPath)
  }

  // 归一化后再全量回检一遍, 确保 concat 输入流结构真的一致 (Task B fail-fast 要求)
  const postProbes: MediaProbe[] = []
  for (const p of normalized) postProbes.push(await probeMedia(p))
  const badOnes = postProbes.filter(p => !p.hasAudio || p.width !== targetW || p.height !== targetH)
  if (badOnes.length > 0) {
    throw new Error(
      `normalize-failed: ${badOnes.length}/${normalized.length} clip 归一化后规格仍不一致, 拼接终止`
    )
  }

  logTaskSuccess('MergeTask', 'normalize-done', {
    clips: normalized.length,
    transcoded: normalized.filter((p, i) => p !== absPaths[i]).length,
    target: { width: targetW, height: targetH, fps: targetFps },
  })
  return normalized
}

/**
 * Task F: 用 xfade + acrossfade 做交叉淡化拼接
 *
 * xfade filter_chain 逐段叠加 (offset 是相对该段起点的秒数):
 *   [0:v][1:v]xfade=transition=fade:duration=D:offset=O1[v1]
 *   [1:v][2:v]xfade=transition=fade:duration=D:offset=O2[v2] ...
 *
 * ⚠️ xfade 会【吃掉总时长】: N 个 clip → 总时长 - (N-1)×D。
 * ⚠️ offset 必须逐段递增, 且每段 offset 要减去已消耗的转场时长。
 *
 * @param clips 已归一化的绝对路径 (Task B 产出, 规格一致)
 * @param durationSec 每个 clip 的时长 (与 clips 同序)
 */
async function mergeWithXfade(clips: string[], durationSec: number[], outputPath: string): Promise<void> {
  const D = XFADE_DURATION

  // 单个 clip 不需要转场, 直接转封装
  if (clips.length === 1) {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(clips[0])
        .outputOptions(['-c', 'copy'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
    return
  }

  // 构建 filter_complex
  const filters: string[] = []
  let accDur = durationSec[0] - D
  for (let i = 1; i < clips.length; i++) {
    const offset = accDur.toFixed(3)
    const isLast = i === clips.length - 1
    const outLabel = isLast ? 'vout' : `v${i}`
    filters.push(`[${i === 1 ? '0:v' : `v${i - 1}`}][${i}:v]xfade=transition=fade:duration=${D}:offset=${offset}[${outLabel}]`)
    accDur += durationSec[i] - D
  }
  // 音频: acrossfade 逐段交叉淡化 (xfade 只管视频)
  //
  // ⚠️ 这里不能用 concat: xfade 会吃掉 (N-1)×D 的总时长, 但音频 concat 不重叠,
  //    会导致 audio 比 video 长 (实测 3×2s clip: video 5.6s / audio 6.0s),
  //    输出末尾出现"只有声音没有画面"的尾巴。
  //    acrossfade 每段同样消耗 D 秒, 音画总时长一致 (实测 audio 5.616 vs video 5.600,
  //    16ms 差是 AAC 帧对齐误差, 听感/观感无影响)。
  let accDurAudio = durationSec[0] - D
  for (let i = 1; i < clips.length; i++) {
    const isLast = i === clips.length - 1
    const outLabel = isLast ? 'aout' : `a${i}`
    const inLabel = i === 1 ? '0:a' : `a${i - 1}`
    filters.push(`[${inLabel}][${i}:a]acrossfade=d=${D}:c1=tri:c2=tri[${outLabel}]`)
    accDurAudio += durationSec[i] - D
  }

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
    for (const clip of clips) cmd.input(clip)
    cmd
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function doMerge(mergeId: number, episodeId: number, videos: string[]) {
  // 输出文件 (先定路径, 归一化与两种拼接方式都写到这里)
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  // ── Task B 前置: 音频 + 规格归一化 ──
  //   concat demuxer 遇流结构不一致会静默输出纯视频 (rc=0), 所以必须先统一。
  //   任一 clip 归一化失败 → throw (fail-fast, 不静默跳过)
  const normalized = await normalizeClips(videos)
  const normalizedProbes: MediaProbe[] = []
  for (const p of normalized) normalizedProbes.push(await probeMedia(p))
  const anyInputHasAudio = normalizedProbes.some(p => p.hasAudio)

  // ── Task F: 优先 xfade 转场, 失败 fallback 硬切 concat ──
  let usedXfade = false
  let xfadeFallbackReason: string | null = null

  if (XFADE_ENABLED && normalized.length > 1) {
    try {
      await mergeWithXfade(
        normalized,
        normalizedProbes.map(p => p.durationSec),
        outputPath,
      )
      usedXfade = true
      logTaskSuccess('MergeTask', 'xfade-merge-done', {
        mergeId,
        clips: normalized.length,
        transitionMs: XFADE_DURATION * 1000,
      })
    } catch (err: any) {
      // xfade 失败不阻断导出 (质量提升不能以"导不出"为代价) → fallback 硬切
      usedXfade = false
      xfadeFallbackReason = err?.message || String(err)
      logTaskWarn('MergeTask', 'xfade-fallback-to-concat', {
        mergeId,
        error: xfadeFallbackReason,
        hint: 'xfade 失败, 回退硬切 concat (分辨率/帧率可能不一致)',
      })
      // 清掉可能写坏的部分输出
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* ignore */ }
    }
  } else if (!XFADE_ENABLED) {
    xfadeFallbackReason = 'xfade-disabled-by-env'
    logTaskProgress('MergeTask', 'xfade-disabled', { mergeId, hint: 'MERGE_XFADE=0, 用硬切 concat' })
  }

  if (!usedXfade) {
    // ── 硬切 concat (归一化后的输入, 流结构已一致, 音频不再丢) ──
    const listDir = path.join(STORAGE_ROOT, 'temp')
    fs.mkdirSync(listDir, { recursive: true })
    const listPath = path.join(listDir, `${uuid()}.txt`)
    fs.writeFileSync(listPath, normalized.map(v => `file '${v}'`).join('\n'), 'utf-8')

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions([
            '-fflags', '+genpts',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '48000',
            '-b:a', '192k',
            '-movflags', '+faststart',
          ])
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run()
      })
    } finally {
      try { fs.unlinkSync(listPath) } catch { /* ignore */ }
    }
    logTaskSuccess('MergeTask', 'concat-merge-done', { mergeId, clips: normalized.length })
  }

  // ── Task B 后置校验: 输入有有声流但输出无声流 → 记 ERROR 便于追溯 ──
  //   (归一化已 fail-fast, 这里是最后一道兜底, 防止未来改动重新引入静默丢音)
  const outputProbe = await probeMedia(outputPath)
  if (anyInputHasAudio && !outputProbe.hasAudio) {
    logTaskError('MergeTask', 'post-merge-silent', {
      mergeId,
      episodeId,
      output: outputFilename,
      inputHasAudio: true,
      outputHasAudio: false,
      clips: normalized.length,
      hint: '输入有音轨但输出无音轨 — 归一化被绕过或 ffmpeg 行为变化, 需排查',
    })
  }

  // 清理归一化临时文件 (xfade/concat 都完成后)
  for (const p of normalized) {
    if (p.startsWith(NORMALIZE_DIR)) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 更新 merge 记录
  db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId)).run()

  // 更新 episode
  db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId)).run()

  logTaskSuccess('MergeTask', 'episode-merge', {
    mergeId,
    episodeId,
    output: mergedRelative,
    duration,
    clips: videos.length,
    usedXfade,
    xfadeFallbackReason,
    outputHasAudio: outputProbe.hasAudio,
    anyInputHasAudio,
  })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}

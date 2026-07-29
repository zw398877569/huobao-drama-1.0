/**
 * FFmpeg frame extraction — pull a still image from a video clip.
 *
 * Used by the P1 状态门控 "视频生成后自动分析" step: after a video is
 * generated, we need to feed its last frame (or any specific time) into
 * the vision LLM so it can write `observed_final_state` for the
 * storyboard. This service produces that frame as a JPEG on disk;
 * callers then base64-encode it and pass to the LLM (see
 * `services/evaluation.ts` for the data-URL pattern).
 *
 * Design:
 *   - Pure file-system / ffmpeg ops, no DB, no LLM.
 *   - Output path is a project-relative "static/..." path so the
 *     result is served by the same static handler as everything else
 *     and can be fed back to the LLM via /static/... URL.
 *   - Tolerates short clips (≤0.5s) by falling back to the first frame.
 *   - Tolerates ffmpeg not being installed: throws a clear error.
 */

import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

let ffmpegVerified = false
function ensureFfmpegAvailable(): void {
  if (ffmpegVerified) return
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    ffmpegVerified = true
  } catch {
    throw new Error('ffmpeg 未安装或不在 PATH 中。Docker 镜像自带 ffmpeg；本地请 `brew install ffmpeg`。')
  }
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function toRelativePath(absPath: string): string {
  const rel = path.relative(DATA_ROOT, absPath)
  if (!rel.startsWith('..')) return rel
  const rel2 = path.relative(STORAGE_ROOT, absPath)
  if (!rel2.startsWith('..')) return rel2
  return absPath // already absolute; caller will deal with it
}

/**
 * Get video duration in seconds via ffprobe.
 * Returns 0 if the file can't be probed.
 */
export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        logTaskWarn('FrameExtract', 'probe-failed', { videoPath, error: err.message })
        resolve(0)
        return
      }
      const seconds = Number(data?.format?.duration || 0)
      resolve(Number.isFinite(seconds) ? seconds : 0)
    })
  })
}

/**
 * Extract a single still frame from a video at the given time (seconds
 * from start). Output is JPEG quality 85. Returns the project-relative
 * path (e.g. `static/frames/abc.jpg`) so it can be served as a static
 * asset and re-loaded by the LLM via its public URL.
 *
 * Internally uses ffmpeg's `thumbnail` filter as a fallback when the
 * requested timestamp lands on a near-black / fade-in / fade-out frame
 * (rare but happens on generated videos). The primary path is `-ss` +
 * `-frames:v 1` which is the fastest and most predictable.
 */
export function extractFrameAt(
  videoPath: string,
  timeSec: number,
  opts?: { subDir?: string; quality?: number }
): Promise<string> {
  ensureFfmpegAvailable()
  const subDir = opts?.subDir ?? 'frames'
  const quality = opts?.quality ?? 85
  const absVideo = toAbsPath(videoPath)
  if (!fs.existsSync(absVideo)) {
    throw new Error(`视频文件不存在: ${videoPath}`)
  }

  const filename = `${uuid()}.jpg`
  const absDir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(absDir, { recursive: true })
  const absOut = path.join(absDir, filename)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (rel: string) => { if (settled) return; settled = true; resolve(rel) }
    const fail = (e: Error) => { if (settled) return; settled = true; reject(e) }

    ffmpeg(absVideo)
      .seekInput(timeSec)
      .outputOptions([
        '-frames:v 1',
        '-q:v 2', // maps to JPEG quality ~ 85
        '-pix_fmt yuv420p',
        '-y',
      ])
      .on('error', (err) => {
        // Fallback: try the thumbnail filter, which picks a
        // "representative" frame from the whole video. Better than
        // nothing if the seek landed on a black/transition frame.
        ffmpeg(absVideo)
          .outputOptions(['-vf', 'thumbnail', '-frames:v 1', '-q:v 2', '-pix_fmt yuv420p', '-y'])
          .on('error', (err2) => fail(new Error(`ffmpeg 抽帧失败: ${err.message} / ${err2.message}`)))
          .on('end', () => finish(toRelativePath(absOut)))
          .save(absOut)
      })
      .on('end', () => finish(toRelativePath(absOut)))
      .save(absOut)
  })
}

/**
 * Extract the LAST frame of a video. This is the primary entry point
 * used by 状态门控 "视频生成后自动分析" — it gives the vision LLM a
 * snapshot of the shot's actual end-state, which is what the next
 * shot's prompt should chain off of.
 *
 * For clips shorter than 0.5s the function falls back to the FIRST
 * frame (the seek-to-end trick fails on very short videos).
 */
export async function extractLastFrame(
  videoPath: string,
  opts?: { subDir?: string; quality?: number; minDurationForLast?: number }
): Promise<{ framePath: string; atSeconds: number; usedFallback: boolean }> {
  ensureFfmpegAvailable()
  const minDur = opts?.minDurationForLast ?? 0.5
  const duration = await getVideoDuration(videoPath)

  // Edge case: very short clips. Just take the first frame.
  if (!duration || duration < minDur) {
    const framePath = await extractFrameAt(videoPath, 0, opts)
    return { framePath, atSeconds: 0, usedFallback: true }
  }

  // Seek 0.1s before the end. `-ss` before `-i` is fast (keyframe seek).
  // We use 0.1s not 0s because the very last frame is often a black
  // tail on generated videos; 0.1s back is more representative.
  const seekTo = Math.max(0, duration - 0.1)
  const framePath = await extractFrameAt(videoPath, seekTo, opts)
  return { framePath, atSeconds: seekTo, usedFallback: false }
}

/**
 * One-shot helper: extract a frame from a video URL/path. Used by
 * manual debug routes / dev tools. Returns the absolute path on disk
 * (caller can convert with toRelativePath if needed).
 */
export function extractDebugFrame(videoPath: string, timeSec: number): Promise<string> {
  return extractFrameAt(videoPath, timeSec, { subDir: 'frames-debug' })
}

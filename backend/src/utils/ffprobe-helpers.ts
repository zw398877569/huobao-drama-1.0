/**
 * ffmpeg-compose / ffmpeg-merge 共用的媒体探测 helper
 *
 * Sprint 11 Task C/D/E/B/F (PM msg-20261016-001):
 *   - C 无对白镜头合成时保留 H3 原声 (需先探测原视频有无音轨, 无音轨时 -map 0:a 会报错)
 *   - D 去 -shortest 改显式对齐 (需 ffprobe 实测原视频真实时长, 不能用 storyboard.duration 估算值)
 *   - E 分句字幕时间轴 (需 ffprobe 实测每个 TTS segment 真实时长, 不能靠估算)
 *   - B 拼接前音频归一化 (需探测每个 clip 有无音轨 + 分辨率/帧率, 供 xfade 统一)
 */
import ffmpeg from 'fluent-ffmpeg'
import { logTaskWarn } from './task-logger.js'

export interface MediaProbe {
  durationSec: number
  hasAudio: boolean
  width: number
  height: number
  fps: number
}

/**
 * 探测媒体文件完整信息 (时长 / 音轨 / 分辨率 / 帧率)。
 * 探测失败返回全 0 值 + hasAudio=false, 由调用方决定是 fail-fast 还是降级。
 */
export function probeMedia(filePath: string): Promise<MediaProbe> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        logTaskWarn('MediaProbe', 'probe-failed', { filePath, error: err.message })
        resolve({ durationSec: 0, hasAudio: false, width: 0, height: 0, fps: 0 })
        return
      }
      const streams = (data?.streams ?? []) as Array<Record<string, any>>
      const hasAudio = streams.some(s => s.codec_type === 'audio')
      const video = streams.find(s => s.codec_type === 'video') ?? {}
      const durationSec = Number(data?.format?.duration || 0)

      // 帧率解析: r_frame_rate 是 "30000/1001" 这类分数, 需除零保护
      let fps = 0
      const rFrameRate = String(video.r_frame_rate || video.avg_frame_rate || '')
      if (rFrameRate.includes('/')) {
        const [num, den] = rFrameRate.split('/').map(Number)
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
          fps = Math.round((num / den) * 100) / 100  // 保留 2 位小数, 避免 29.97 变 29.970000000000002
        }
      } else if (rFrameRate) {
        const parsed = Number(rFrameRate)
        if (Number.isFinite(parsed)) fps = Math.round(parsed * 100) / 100
      }

      resolve({
        durationSec: Number.isFinite(durationSec) ? durationSec : 0,
        hasAudio,
        width: Number(video.width || 0),
        height: Number(video.height || 0),
        fps,
      })
    })
  })
}

/**
 * 只探测时长 (秒)。ffprobe 对音频文件同样返回 format.duration, 可用于 TTS segment。
 * 探测失败返回 0。
 */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        logTaskWarn('MediaProbe', 'duration-probe-failed', { filePath, error: err.message })
        resolve(0)
        return
      }
      const seconds = Number(data?.format?.duration || 0)
      resolve(Number.isFinite(seconds) ? seconds : 0)
    })
  })
}

/**
 * 把秒数格式化为 SRT 时间戳 HH:MM:SS,mmm
 */
export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

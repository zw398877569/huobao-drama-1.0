/**
 * ★ Sprint 41 单 179 (PM msg-20261114-179): 拼接产物的【像素格式】与【免重编码】判据
 *
 * 【为什么要有这一份】
 *   Chrome / 绝大多数浏览器只硬解 yuv420p (4:2:0) 的 H.264 → 4:4:4 没有硬件解码器
 *   → 整片走软件解码 → 【网页里播成片卡顿】, 下载到本地播就正常 (用户不敢在网页里预览)。
 *   ★ libx264 不写 `-pix_fmt` 时默认就是 yuv444p → 拼接这一步把 compose 的 yuv420p 变成了 yuv444p。
 *
 * 【为什么单独一个模块】
 *   判据是纯计算 (不碰 DB / 不碰 ffmpeg 子进程) → 抽出来可以离线断言,
 *   也避免把这段逻辑混进已经很长的 ffmpeg-merge.ts。
 */

/** 拼接产物的目标像素格式 (浏览器硬解需要 4:2:0) */
export const TARGET_PIX_FMT = 'yuv420p'
/** 目标音轨规格 */
export const TARGET_AUDIO_CODEC = 'aac'
export const TARGET_AUDIO_SAMPLE_RATE = 48000
export const TARGET_AUDIO_CHANNELS = 2

export interface ClipCodecProbe {
  width: number
  height: number
  fps: number
  /** 像素格式 (如 'yuv420p' / 'yuv444p') */
  pixFmt: string
  hasAudio: boolean
  /** 音轨编码 (如 'aac') */
  audioCodec: string
  /** 音轨采样率 (Hz) */
  audioSampleRate: number
  /** 音轨声道数 */
  audioChannels: number
}

/**
 * 判断这个片段能不能【直接复制】不重编码。
 *
 * ★ 判准要全: 分辨率 / 帧率 / 像素格式 / 音轨(编码 + 采样率 + 声道) 都与目标一致才算。
 *   ★ 差一个像素格式就不能 copy —— copy 不会转换格式, yuv444p 原样拷进来问题就还在
 *     (别为了少转码把 yuv444p 放进最终成片 → 那样卡顿照旧)。
 *
 * @returns ok=true 可以直接用原文件; reason 说明为什么不能复制 (给 flow-log 看)
 */
export function canCopyClipWithoutTranscode(
  probe: ClipCodecProbe,
  target: { width: number; height: number; fps: number },
): { ok: boolean; reason: string } {
  if (!probe.hasAudio) return { ok: false, reason: '没有音轨' }
  if (probe.width !== target.width || probe.height !== target.height) return { ok: false, reason: '分辨率不一致' }
  if (probe.fps > 0 && target.fps > 0 && Math.abs(probe.fps - target.fps) > 0.5) return { ok: false, reason: '帧率不一致' }
  if ((probe.pixFmt || '').toLowerCase() !== TARGET_PIX_FMT) {
    return { ok: false, reason: `像素格式不是 ${TARGET_PIX_FMT} (实际 ${probe.pixFmt || '未知'})` }
  }
  if ((probe.audioCodec || '').toLowerCase() !== TARGET_AUDIO_CODEC) {
    return { ok: false, reason: `音轨编码不是 ${TARGET_AUDIO_CODEC} (实际 ${probe.audioCodec || '未知'})` }
  }
  if (probe.audioSampleRate !== TARGET_AUDIO_SAMPLE_RATE) {
    return { ok: false, reason: `音轨采样率不是 ${TARGET_AUDIO_SAMPLE_RATE}` }
  }
  if (probe.audioChannels !== TARGET_AUDIO_CHANNELS) {
    return { ok: false, reason: `音轨声道数不是 ${TARGET_AUDIO_CHANNELS}` }
  }
  return { ok: true, reason: '规格全部达标' }
}

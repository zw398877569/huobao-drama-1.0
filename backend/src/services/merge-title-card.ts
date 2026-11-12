/**
 * ★ Sprint 40 T4 (PM msg-20261112-171): 片头 / 集数卡 —— 默认关
 *
 * 【为什么要有】拼出来的成片第一帧就是第一个镜头, 没有片头 → 观众不知道这是第几集。
 *
 * 【关键约束】
 *   ★ 默认关闭: 不开时成片与改动前逐帧/逐样本一致 (PM 决策 D4)
 *   ★ 中文字体直接用容器里已装好的 Noto CJK (Sprint 23 Task F 装的 fonts-noto-cjk),
 *     **不往仓库里塞字体文件** (字体有版权 + 体积大)
 *   ★ 片头作为拼接链的【第 0 个片段】参与 (不是拼在成片外面) → 时长/镜缝编号都要跟着算
 */
import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'

export interface MergeTitleCardConfig {
  /** 是否开启片头 (默认关) */
  enabled: boolean
  /** 主标题 (默认 = 剧名) */
  title: string
  /** 副标题 (默认 = 第 N 集) */
  subtitle: string
  /** 卡片时长 (秒) */
  durationSec: number
  /** 背景色 (#RRGGBB 或 ffmpeg 颜色名) */
  background: string
  /** 文字颜色 */
  textColor: string
  /** 主标题字号 (px) */
  fontSize: number
}

export const DEFAULT_MERGE_TITLE_CARD: MergeTitleCardConfig = {
  enabled: false,
  title: '',
  subtitle: '',
  durationSec: 2,
  background: '#101014',
  textColor: '#ffffff',
  fontSize: 64,
}

/** 容器里 Noto CJK 的可能路径 (Debian fonts-noto-cjk 装这几个) */
export const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
]

/** 找一个能用的中文字体文件 (找不到 → null → 退回 fontconfig 按 family name 找) */
export function findCjkFont(candidates: string[] = CJK_FONT_CANDIDATES): string | null {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[0-9a-zA-Z_]+)$/

/** 校验片头配置 (非法值挡住 → 不建 merge 记录) */
export function validateTitleCardConfig(input: any): {
  ok: boolean; config: MergeTitleCardConfig; errors: string[]
} {
  const config: MergeTitleCardConfig = { ...DEFAULT_MERGE_TITLE_CARD }
  const errors: string[] = []
  if (input == null) return { ok: true, config, errors }
  if (typeof input !== 'object') return { ok: false, config, errors: ['片头配置格式不对 (需要是一个对象)'] }

  if (input.enabled != null) config.enabled = !!input.enabled
  if (input.title != null) config.title = String(input.title).slice(0, 80)
  if (input.subtitle != null) config.subtitle = String(input.subtitle).slice(0, 60)
  if (input.durationSec != null) {
    const v = Number(input.durationSec)
    if (!Number.isFinite(v)) errors.push('片头时长 不是数字')
    else if (v < 1 || v > 10) errors.push('片头时长 超出范围 (1~10 秒)')
    else config.durationSec = v
  }
  if (input.background != null) {
    const v = String(input.background)
    if (!COLOR_RE.test(v)) errors.push('片头背景色不合法 (用 #RRGGBB 或颜色名)')
    else config.background = v
  }
  if (input.textColor != null) {
    const v = String(input.textColor)
    if (!COLOR_RE.test(v)) errors.push('片头文字颜色不合法 (用 #RRGGBB 或颜色名)')
    else config.textColor = v
  }
  if (input.fontSize != null) {
    const v = Number(input.fontSize)
    if (!Number.isFinite(v)) errors.push('片头字号 不是数字')
    else if (v < 16 || v > 240) errors.push('片头字号 超出范围 (16~240)')
    else config.fontSize = Math.round(v)
  }
  return { ok: errors.length === 0, config, errors }
}

/** #RRGGBB → 0xRRGGBB (ffmpeg color 的十六进制写法更稳) */
export function toFfmpegColor(color: string): string {
  const c = String(color || '').trim()
  if (c.startsWith('#')) return `0x${c.slice(1)}`
  return c
}

/**
 * 滤镜参数里的路径转义 (只处理反斜杠/冒号/单引号)。
 * ★ 文本内容【不走滤镜参数】→ 用 textfile= 读 UTF-8 文本文件 (drawtext 的 text= 转义规则很坑:
 *   单引号里的反斜杠是字面量, 冒号/单引号/百分号各有一堆坑) → 文本文件是最稳的做法。
 */
export function escapeFilterPath(filePath: string): string {
  return String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
}

/**
 * 生成片头卡的 -vf 滤镜串 (纯函数 → 可离线断言)。
 *
 * @param clipLengthSec 实际生成的片段长度 (= 卡片时长 + 交给第 1 个镜头的转场时长)
 *   ★ 为什么要多留转场时长: xfade 会把两个片段重叠 D 秒 → 成片总时长 = 片段总长 - 重叠;
 *     卡片多留 D → 扣掉后正好 = 原时长 + 卡片时长 (工单验收: 总时长 = 原时长 + 2 秒)
 * @param visibleSec 卡片真正"完整可见"的时长 (= 卡片时长), 文字按这个区域居中
 */
export function buildTitleCardFilter(
  cfg: MergeTitleCardConfig,
  opts: {
    width: number
    height: number
    clipLengthSec: number
    visibleSec: number
    /** 主标题的 UTF-8 文本文件 (drawtext textfile=) */
    titleTextFile?: string | null
    /** 副标题的 UTF-8 文本文件 */
    subtitleTextFile?: string | null
  },
): string {
  const font = findCjkFont()
  const fontOpt = font ? `fontfile='${font}'` : `font='Noto Sans CJK SC'`
  const bg = toFfmpegColor(cfg.background)
  const fg = toFfmpegColor(cfg.textColor)
  // 可见区域在整段里的占比 (文字按可见区域居中, 不是按整段居中)
  const frac = opts.clipLengthSec > 0 ? opts.visibleSec / opts.clipLengthSec : 1
  const filters: string[] = []

  if (cfg.title && opts.titleTextFile) {
    filters.push(
      `drawtext=${fontOpt}:textfile='${escapeFilterPath(opts.titleTextFile)}':fontsize=${cfg.fontSize}:fontcolor=${fg}:` +
      `x=(w-text_w)/2:y=(h*${frac.toFixed(4)})/2-text_h/2:expansion=none`
    )
  }
  if (cfg.subtitle && opts.subtitleTextFile) {
    const subSize = Math.max(16, Math.round(cfg.fontSize * 0.45))
    filters.push(
      `drawtext=${fontOpt}:textfile='${escapeFilterPath(opts.subtitleTextFile)}':fontsize=${subSize}:fontcolor=${fg}:` +
      `x=(w-text_w)/2:y=(h*${frac.toFixed(4)})/2+${Math.round(cfg.fontSize * 0.75)}-text_h/2:expansion=none`
    )
  }
  // 开头淡入 (从黑 → 片头)
  const fadeDur = Math.min(0.5, Math.max(0.15, opts.visibleSec / 4)).toFixed(2)
  filters.push(`fade=t=in:st=0:d=${fadeDur}`)
  return filters.join(',')
}

/**
 * 生成片头卡视频 (无真实声音 → 配一条静音轨, 这样它能进 acrossfade 音频链)。
 * 产物与其它片段同分辨率/同帧率 → 能直接进 xfade。
 */
export async function generateTitleCard(opts: {
  title: string
  subtitle: string
  durationSec: number
  background: string
  textColor: string
  fontSize: number
  width: number
  height: number
  fps: number
  /** 交给第 1 个镜头的转场时长 (卡片要多留这么久) */
  transitionDurSec: number
  crf: number
  preset: string
  outputPath: string
}): Promise<void> {
  const clipLength = Number(opts.durationSec) + Number(opts.transitionDurSec)
  // 文本写文件 (drawtext 的 text= 转义太坑 → textfile= 读 UTF-8 最稳)
  const textDir = path.dirname(opts.outputPath)
  fs.mkdirSync(textDir, { recursive: true })
  const titleFile = path.join(textDir, `${path.basename(opts.outputPath)}.title.txt`)
  const subtitleFile = path.join(textDir, `${path.basename(opts.outputPath)}.subtitle.txt`)
  if (opts.title) fs.writeFileSync(titleFile, opts.title, 'utf-8')
  if (opts.subtitle) fs.writeFileSync(subtitleFile, opts.subtitle, 'utf-8')

  const vf = buildTitleCardFilter(
    {
      enabled: true,
      title: opts.title,
      subtitle: opts.subtitle,
      durationSec: opts.durationSec,
      background: opts.background,
      textColor: opts.textColor,
      fontSize: opts.fontSize,
    },
    {
      width: opts.width,
      height: opts.height,
      clipLengthSec: clipLength,
      visibleSec: opts.durationSec,
      titleTextFile: opts.title ? titleFile : null,
      subtitleTextFile: opts.subtitle ? subtitleFile : null,
    },
  )

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${toFfmpegColor(opts.background)}:s=${opts.width}x${opts.height}:r=${opts.fps}:d=${clipLength}`)
      .input('anullsrc=r=48000:cl=stereo')
      .outputOptions([
        '-vf', vf,
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', opts.preset,
        '-crf', String(opts.crf),
        '-pix_fmt', 'yuv420p',
        '-r', String(opts.fps),
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-shortest',
        '-t', String(clipLength),
      ])
      .output(opts.outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

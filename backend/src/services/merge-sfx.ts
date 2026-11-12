/**
 * ★ Sprint 40 T3 (PM msg-20261112-171): 音效点睛 —— 【纯逻辑模块】
 *
 * 【产品决策】音效不做自动匹配 (PM 决策 D5: 自动匹配要语义理解, 容易错配且难排查),
 *   只做【手动逐镜缝选择】; 素材复用 T2 的目录约定 (data/media/sfx/) 与素材库接口。
 *
 * 【音效要叠在镜缝处, 不是镜头中间】
 *   两个镜头的切点 = 交叉淡化的中点 (xfade 的 offset + 转场时长/2)。
 *   叠在镜头中间会显得突兀 (音效和画面动作对不上)。
 *
 * 【超长截断】
 *   音效比"从切点到片尾"的剩余时间还长 → 截断到剩余时长;
 *   比剩余时间短 → 直接放完 (不循环)。
 *   ★ 不循环还有个好处: 循环型素材 (如 keyboard-typing-loop) 不会引入循环爆音。
 *
 * 【默认不加音效 → 成片与改动前逐样本一致】(PM 决策 D4): 不加时不加任何滤镜。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** data 根目录 (容器内 = /app/data) */
export const DATA_ROOT = path.resolve(__dirname, '../../../data')
/** 音效素材目录 (PM 决策 D1: data/media/sfx/) */
export const SFX_DIR = path.join(DATA_ROOT, 'media', 'sfx')

export interface MergeSfxGap {
  /** 镜缝序号 (0 = 第1镜与第2镜之间) */
  index: number
  /** 音效文件名 (data/media/sfx/ 下的纯文件名) */
  file: string
}

export interface MergeSfxConfig {
  /** 音效音量 (dB) —— 默认 -14 (PM 建议: 比人声低但听得见) */
  volumeDb: number
  /** 逐镜缝选的音效 (没选的镜缝 = 不加) */
  gaps: MergeSfxGap[]
}

export const DEFAULT_MERGE_SFX: MergeSfxConfig = { volumeDb: -14, gaps: [] }

/** 素材文件名 → 绝对路径 (只允许纯文件名 → 防路径穿越; 目录里没有 → null) */
export function resolveSfxPath(file: string, sfxDir: string = SFX_DIR): string | null {
  if (!file) return null
  const base = path.basename(file)
  if (base !== file) return null
  const abs = path.join(sfxDir, base)
  try {
    if (!fs.existsSync(abs)) return null
  } catch {
    return null
  }
  return abs
}

/**
 * 校验音效配置 (非法值挡住 → 不建 merge 记录)。
 * @param requireFileExists 读持久化设置时传 false (素材被删了 → 静默降级为"不加音效")
 */
export function validateSfxConfig(
  input: any,
  sfxDir: string = SFX_DIR,
  requireFileExists: boolean = true,
): { ok: boolean; config: MergeSfxConfig; errors: string[] } {
  const config: MergeSfxConfig = { volumeDb: DEFAULT_MERGE_SFX.volumeDb, gaps: [] }
  const errors: string[] = []
  if (input == null) return { ok: true, config, errors }
  if (typeof input !== 'object') return { ok: false, config, errors: ['音效配置格式不对 (需要是一个对象)'] }

  if (input.volumeDb != null) {
    const v = Number(input.volumeDb)
    if (!Number.isFinite(v)) errors.push('音效音量 不是数字')
    else if (v < -60 || v > 0) errors.push(`音效音量 超出范围 (-60~0)`)
    else config.volumeDb = v
  }

  if (input.gaps != null) {
    if (!Array.isArray(input.gaps)) {
      errors.push('音效列表格式不对 (需要是数组)')
    } else {
      const byIndex = new Map<number, string>()
      for (const g of input.gaps) {
        const idx = Number(g?.index)
        if (!Number.isInteger(idx) || idx < 0) { errors.push('音效的镜缝序号不合法 (需要是非负整数)'); continue }
        const file = String(g?.file || '')
        if (!file) continue                       // 空 = 这个镜缝不加音效
        if (path.basename(file) !== file) { errors.push('音效文件名不合法 (只填文件名, 不要带路径)'); continue }
        if (requireFileExists && !resolveSfxPath(file, sfxDir)) {
          errors.push(`音效素材不存在: ${file} (要放到 data/media/sfx/ 目录里)`)
          continue
        }
        byIndex.set(idx, file)                  // 同一个镜缝重复传 → 最后一个赢
      }
      config.gaps = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, file]) => ({ index, file }))
    }
  }

  return { ok: errors.length === 0, config, errors }
}

export interface SfxPlacement {
  /** 镜缝序号 (链内编号: 开了片头时 0 = 片头↔第1镜) */
  gapIndex: number
  /** 音效文件名 */
  file: string
  /** 音效在成片时间轴上的起点 (秒) —— 切点 */
  startSec: number
  /** 从切点到片尾还剩多少秒 (音效要截断到这个长度) */
  remainingSec: number
}

export interface SfxMixChain {
  /** 要追加到 filter_complex 的片段 */
  filters: string[]
  /** 最终音频输出 label */
  audioOutLabel: string
  /** 每个音效输入的信息 (调用方据此把文件加进 ffmpeg 命令) */
  inputs: Array<{ label: string; gapIndex: number; startSec: number }>
}

/**
 * 生成音效混音的 filter 链 (纯函数 → 可离线断言)。
 *
 * 每个音效:
 *   [输入:a]aformat(统一 48k 立体声) → volume(dB) → atrim(截到剩余时长) → adelay(延迟到切点)
 * 最后:
 *   [主音轨][sfx0][sfx1]amix(normalize=0, duration=first)
 *     - normalize=0: 两路音量是相加 (默认 1 会各减一半)
 *     - duration=first: 以主音轨长度为准 → ★ 音效再长也不会把成片撑长
 */
export function buildSfxMixChain(
  inputLabel: string,
  sfx: MergeSfxConfig,
  placements: SfxPlacement[],
  firstInputIndex: number,
): SfxMixChain {
  const filters: string[] = []
  const inputs: SfxMixChain['inputs'] = []
  const labels: string[] = []

  placements.forEach((p, i) => {
    const label = `sfx${i}`
    const delayMs = Math.max(0, Math.round(Number(p.startSec) * 1000))
    const remain = Math.max(0.05, Number(p.remainingSec))
    filters.push(
      `[${firstInputIndex + i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,` +
      `volume=volume=${sfx.volumeDb}dB,atrim=end=${remain.toFixed(3)},asetpts=N/SR/TB,adelay=${delayMs}:all=1[${label}]`
    )
    labels.push(label)
    inputs.push({ label, gapIndex: p.gapIndex, startSec: Number(p.startSec) })
  })

  const out = `${inputLabel}_sfx`
  const mixInputs = [`[${inputLabel}]`, ...labels.map(l => `[${l}]`)].join('')
  filters.push(`${mixInputs}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0[${out}]`)

  return { filters, audioOutLabel: out, inputs }
}

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
// ★ Sprint 38 T1-F (PM msg-20261110-165): PM 2026-11-10 拍板改成 400ms ——
//   24fps + 模型运动幅度小 + 0.2s 的短叠化 (观感接近硬切) 把镜间跳变凸显出来了;
//   0.4s 仍在『>500ms 会镜头交叠』的顾虑之内, 先试一版。
//   可用环境变量 MERGE_XFADE_MS 调 (100~800), 方便 PM 再试 0.3 / 0.5 而不用改代码。
//   ★ 视频 xfade 与音频 acrossfade 用的是同一个 D (音画总时长必须一致, 见下面的 acrossfade)。
const XFADE_DURATION = (() => {
  const raw = Number(process.env.MERGE_XFADE_MS)
  if (Number.isFinite(raw) && raw >= 100 && raw <= 800) return raw / 1000
  return 0.4
})()
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
export async function mergeEpisodeVideos(
  episodeId: number,
  dramaId: number,
  options?: {
    transitions?: MergeTransitionConfig
    grade?: MergeGradeConfig
    subtitleStage?: MergeSubtitleStage
  },
): Promise<number> {
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

  // 异步执行 (★ Sprint 39 T2: 逐镜缝转场配置透传给拼接执行)
  doMerge(mergeId, episodeId, videos, options?.transitions, options?.grade, options?.subtitleStage, composedStoryboards).catch(err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId)).run()
  })

  return mergeId
}

/**
 * ★ Sprint 38 T1-B (PM msg-20261110-165): 从各 clip 的探测结果里挑【最常见】的规格当归一化基准。
 *
 * 【为什么】原来取【第一个 clip】当基准 → 混分辨率时, 多数派片段全被上采样放大
 *   (放大不增细节, 成片整体发软), 而且每个不符的片段都要转一遍码 (实测 19 段转了 18 段)。
 *   取最常见的那档 → 多数派不用转码, 少数派才转。
 *
 * 【口径】数量多的优先; 数量相同时按【首次出现顺序】(Map 保序 + sort 稳定) → 与旧行为最接近。
 *   宽高取偶数 (h264 要求), 帧率探测不到按 30 算。
 *
 * 导出成纯函数 → 可以离线断言 (不用跑 ffmpeg)。
 */
export function rankSpecsByFrequency(
  probes: Array<{ width?: number; height?: number; fps?: number }>,
): Array<{ key: string; count: number; spec: { width: number; height: number; fps: number } }> {
  const counts = new Map<string, { width: number; height: number; fps: number; count: number }>()
  for (const p of probes || []) {
    const pw = Number(p?.width || 0), ph = Number(p?.height || 0), pf = Number(p?.fps || 0)
    if (!(pw > 0 && ph > 0)) continue
    const w = pw % 2 === 0 ? pw : pw - 1
    const h = ph % 2 === 0 ? ph : ph - 1
    const f = pf > 0 ? pf : 30
    const key = `${w}x${h}@${f}`
    const cur = counts.get(key)
    if (cur) cur.count++
    else counts.set(key, { width: w, height: h, fps: f, count: 1 })
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => ({ key, count: v.count, spec: { width: v.width, height: v.height, fps: v.fps } }))
}

/**
 * ★ Sprint 39 T1 (PM msg-20261111-169): 成片编码参数 —— 可配, 且默认值【比改动前更好】。
 *
 * 【为什么】改动前: crf 23 + preset medium → 成片细节偏软 (文件也偏小)。
 * 【原则】D1 质量优先: 禁止用【降低画质】换速度 → preset 不允许被降级;
 *   crf 默认从 23 提到 18 (画质档位更高 → 码率/体积/细节保留都明显更好), 编码变慢是预期代价。
 * 【可配】环境变量 MERGE_CRF (10~40, 默认 18) / MERGE_PRESET (默认 medium)。
 *   ★ preset 传了比 medium 更快的档 (fast/faster/veryfast/superfast/ultrafast) → 忽略并回落 medium
 *     (防止有人为了提速悄悄把画质调差) —— 回落时会记一条 flow-log。
 */
const DEFAULT_MERGE_CRF = 18
const DEFAULT_MERGE_PRESET = 'medium'
/** 比 medium 更快 = 画质更差的 preset 名单 (AC: 不允许用它们换速度) */
const FASTER_THAN_MEDIUM_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast']

export interface MergeEncodeParams {
  crf: number
  preset: string
  /** 传了但被挡下来的 preset (null = 没传或没被挡) */
  rejectedPreset?: string | null
}

/** 解析成片编码参数 (env 可配; preset 不可被降级) */
export function resolveMergeEncodeParams(env: Record<string, string | undefined> = process.env): MergeEncodeParams {
  const rawCrf = Number(env.MERGE_CRF)
  const crf = Number.isFinite(rawCrf) && rawCrf >= 10 && rawCrf <= 40 ? rawCrf : DEFAULT_MERGE_CRF
  const rawPreset = String(env.MERGE_PRESET || '').trim().toLowerCase()
  if (!rawPreset) return { crf, preset: DEFAULT_MERGE_PRESET, rejectedPreset: null }
  if (FASTER_THAN_MEDIUM_PRESETS.includes(rawPreset)) {
    return { crf, preset: DEFAULT_MERGE_PRESET, rejectedPreset: rawPreset }
  }
  return { crf, preset: rawPreset, rejectedPreset: null }
}

/**
 * ★ Sprint 39 T3 (PM msg-20261111-169): 全片统一调色 (可选, 默认关) —— 消除各镜之间的色调/亮度漂移。
 *
 * 【默认 = 改动前】enabled=false → 完全不加滤镜 → 成片逐帧一致。
 * 【用 ffmpeg 自带的 eq 滤镜】不引入任何外部素材 (不下载 LUT, 不往仓库加二进制资源)。
 * 【持久化】按集存一份 JSON (data/merge-settings/episode-<id>.json) → 用户下次再拼同一集, 参数仍然生效。
 */
export interface MergeGradeConfig {
  enabled: boolean
  /** 亮度 -1 ~ 1 (0 = 不动) */
  brightness: number
  /** 对比度 0.5 ~ 2 (1 = 不动) */
  contrast: number
  /** 饱和度 0 ~ 3 (1 = 不动) */
  saturation: number
}
export const DEFAULT_MERGE_GRADE: MergeGradeConfig = { enabled: false, brightness: 0, contrast: 1, saturation: 1 }
export type MergeSubtitleStage = 'compose' | 'merge'
export interface MergeSettings {
  grade: MergeGradeConfig
  /** ★ Sprint 39 T4: 字幕烧录时机 —— compose = 合成阶段烧 (默认, 改动前的行为); merge = 拼接阶段烧 (字幕只过 一次有损编码) */
  subtitleStage: MergeSubtitleStage
}
const MERGE_SETTINGS_DIR = path.join(DATA_ROOT, 'merge-settings')
/** ★ Sprint 39 T4: 拼接阶段烧字幕时用的字体目录与样式 (与 compose 阶段逐字一致 → 字幕看起来一样) */
const SUBTITLE_FONTS_DIR = '/usr/share/fonts/opentype/noto'
const SUBTITLE_FORCE_STYLE = 'FontSize=32\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2'

/** 校验调色参数 (非法值挡住 → 不影响拼接) */
export function validateGradeConfig(input: any): { ok: boolean; config: MergeGradeConfig; errors: string[] } {
  const config: MergeGradeConfig = { ...DEFAULT_MERGE_GRADE }
  const errors: string[] = []
  if (input == null) return { ok: true, config, errors }
  if (typeof input !== 'object') return { ok: false, config, errors: ['调色配置格式不对 (需要是一个对象)'] }
  config.enabled = !!input.enabled
  const ranges: Array<[keyof MergeGradeConfig, number, number]> = [
    ['brightness', -1, 1], ['contrast', 0.5, 2], ['saturation', 0, 3],
  ]
  for (const [k, min, max] of ranges) {
    // 没传这一项 → 保持默认值 (只校验传了的)
    if (input[k] == null) continue
    const v = Number(input[k])
    if (!Number.isFinite(v)) { errors.push(`${k} 不是数字`); continue }
    if (v < min || v > max) { errors.push(`${k} 超出范围 (${min}~${max})`); continue }
    (config as any)[k] = v
  }
  return { ok: errors.length === 0, config, errors }
}

function mergeSettingsPath(episodeId: number) {
  return path.join(MERGE_SETTINGS_DIR, `episode-${episodeId}.json`)
}

/** 读本集的拼接设置 (读不到 → 默认值: 调色关闭) */
export function readMergeSettings(episodeId: number): MergeSettings {
  try {
    const raw = fs.readFileSync(mergeSettingsPath(episodeId), 'utf-8')
    const parsed = JSON.parse(raw)
    const v = validateGradeConfig(parsed?.grade)
    return {
      grade: v.ok ? v.config : { ...DEFAULT_MERGE_GRADE },
      subtitleStage: parsed?.subtitleStage === 'merge' ? 'merge' : 'compose',
    }
  } catch {
    return { grade: { ...DEFAULT_MERGE_GRADE }, subtitleStage: 'compose' }
  }
}

/** 写本集的拼接设置 (调色参数持久化 → 下次再拼同一集仍然生效) */
export function writeMergeSettings(episodeId: number, patch: Partial<MergeSettings>): MergeSettings {
  const current = readMergeSettings(episodeId)
  const next: MergeSettings = {
    grade: patch.grade ?? current.grade,
    subtitleStage: patch.subtitleStage ?? current.subtitleStage,
  }
  try {
    fs.mkdirSync(MERGE_SETTINGS_DIR, { recursive: true })
    fs.writeFileSync(mergeSettingsPath(episodeId), JSON.stringify({ ...next, updatedAt: now() }, null, 2), 'utf-8')
  } catch (err: any) {
    logTaskWarn('MergeTask', 'merge-settings-persist-failed', { episodeId, error: err?.message })
  }
  return next
}

/**
 * ★ Sprint 39 T4 (PM msg-20261111-169): 字幕烧录时机 —— 合成阶段烧 (默认) / 拼接阶段烧。
 *
 * 【为什么】现在字幕在【合成】阶段就烧进画面, 拼接时整片又被重编码一次 → 字幕被压了两遍
 *   (小字糊掉)。改成在【拼接】阶段烧 → 字幕只过【一次】有损编码。
 *
 * 【做法】各镜的 SRT 是按本镜时间轴生成的 (compose 阶段写好了) → 拼接时按每镜在成片里的
 *   起点把时间轴整体平移 → 拼成一份整片 SRT → 在拼接的 filter 里一次性烧上去。
 *   ★ 字幕内容/时间轴/样式/位置与现状一致 (同一份 SRT, 只是整体平移)。
 */

/** 把一段 SRT 的所有时间戳整体平移 offsetSec 秒 */
export function shiftSrtTimestamps(content: string, offsetSec: number): string {
  return String(content || '').replace(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
    (_m, h: string, mi: string, sec: string, ms: string) => {
      const total = Number(h) * 3600 + Number(mi) * 60 + Number(sec) + Number(ms) / 1000 + offsetSec
      const tt = Math.max(0, total)
      const hh = String(Math.floor(tt / 3600)).padStart(2, '0')
      const mm = String(Math.floor((tt % 3600) / 60)).padStart(2, '0')
      const ss = String(Math.floor(tt % 60)).padStart(2, '0')
      const mmm = String(Math.round((tt - Math.floor(tt)) * 1000)).padStart(3, '0')
      return `${hh}:${mm}:${ss},${mmm}`
    },
  )
}

/** 把多段 (已平移的) SRT 拼成一份整片 SRT 并重新编号 (cue 号必须连续) */
export function mergeSrtBlocks(blocks: string[]): string {
  const cues: string[] = []
  for (const b of blocks || []) {
    for (const raw of String(b || '').split(/\n\s*\n/)) {
      const cue = raw.trim()
      if (!cue) continue
      cues.push(cue.replace(/^\d+\n/, ''))
    }
  }
  return cues.map((c, i) => `${i + 1}\n${c}`).join('\n\n')
}

/**
 * ★ Sprint 39 T2 (PM msg-20261111-169): 逐镜缝转场 —— 类型 + 时长都可单独配 (不是全片一刀切)。
 *
 * 【默认 = 改动前的行为】不传配置 → 全部镜缝用 fade + XFADE_DURATION(400ms) → 与改动前逐字一致。
 * 【音频跟随视频】同一镜缝的 acrossfade 时长 = 该镜缝的 xfade 时长 → 音画总时长一致。
 */
export interface MergeTransitionGap {
  /** 镜缝索引: 0 = 第 1 镜与第 2 镜之间 */
  index: number
  type: string
  durationSec: number
}
export interface MergeTransitionConfig {
  defaultType?: string
  defaultDurationSec?: number
  /** 逐镜缝覆盖 (只写要改的) */
  gaps?: MergeTransitionGap[]
}

/** xfade 支持的转场类型 (取 ffmpeg 4.3+ 一直有的那批, 避开版本差异大的新类型) */
export const XFADE_TRANSITION_TYPES: readonly string[] = [
  'fade', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'circlecrop', 'rectcrop', 'circleopen', 'circleclose',
  'vertopen', 'vertclose', 'horzopen', 'horzclose',
  'dissolve', 'pixelize', 'radial', 'distance',
]
export const XFADE_MIN_DURATION = 0.1
export const XFADE_MAX_DURATION = 2.0

/**
 * 校验逐镜缝转场配置 → { ok, config, errors }
 *   ★ 非法值【在这里就被挡住】(返回可读提示), 不让整次拼接失败、也不产生半成品成片。
 */
export function validateTransitionConfig(input: any): { ok: boolean; config: MergeTransitionConfig; errors: string[] } {
  const errors: string[] = []
  const config: MergeTransitionConfig = {}
  if (input == null) return { ok: true, config, errors }
  if (typeof input !== 'object') {
    return { ok: false, config, errors: ['转场配置格式不对 (需要是一个对象)'] }
  }
  const rawDefaultType = input.defaultType != null ? String(input.defaultType) : undefined
  if (rawDefaultType != null && rawDefaultType !== '') {
    if (!XFADE_TRANSITION_TYPES.includes(rawDefaultType)) {
      errors.push(`不支持的转场类型 "${rawDefaultType}" (可选: ${XFADE_TRANSITION_TYPES.join(' / ')})`)
    } else {
      config.defaultType = rawDefaultType
    }
  }
  const rawDefaultDur = input.defaultDurationSec != null ? Number(input.defaultDurationSec) : undefined
  if (rawDefaultDur != null && !Number.isNaN(rawDefaultDur)) {
    if (rawDefaultDur < XFADE_MIN_DURATION || rawDefaultDur > XFADE_MAX_DURATION) {
      errors.push(`默认转场时长 ${rawDefaultDur}s 超出范围 (${XFADE_MIN_DURATION}~${XFADE_MAX_DURATION}s)`)
    } else {
      config.defaultDurationSec = rawDefaultDur
    }
  }
  const gaps: MergeTransitionGap[] = []
  const rawGaps = Array.isArray(input.gaps) ? input.gaps : []
  for (const g of rawGaps) {
    const idx = Number(g?.index)
    if (!Number.isInteger(idx) || idx < 0) {
      errors.push(`镜缝索引不合法: ${JSON.stringify(g?.index)} (应为 0 起的整数)`)
      continue
    }
    const type = String(g?.type || config.defaultType || 'fade')
    if (!XFADE_TRANSITION_TYPES.includes(type)) {
      errors.push(`第 ${idx + 1} 个镜缝: 不支持的转场类型 "${type}" (可选: ${XFADE_TRANSITION_TYPES.join(' / ')})`)
      continue
    }
    const dur = Number(g?.durationSec)
    if (!Number.isFinite(dur) || dur < XFADE_MIN_DURATION || dur > XFADE_MAX_DURATION) {
      errors.push(`第 ${idx + 1} 个镜缝: 转场时长 ${g?.durationSec}s 不合法 (${XFADE_MIN_DURATION}~${XFADE_MAX_DURATION}s)`)
      continue
    }
    gaps.push({ index: idx, type, durationSec: dur })
  }
  config.gaps = gaps
  return { ok: errors.length === 0, config, errors }
}

/**
 * 生成【逐镜缝】的转场列表 (长度 = 镜缝数)。
 *   默认 = fade + XFADE_DURATION (与改动前一致); 逐镜缝覆盖优先。
 */
export function buildTransitionList(
  config: MergeTransitionConfig | null | undefined,
  gapCount: number,
): Array<{ type: string; durationSec: number }> {
  const defaultType = config?.defaultType || 'fade'
  const defaultDur = config?.defaultDurationSec != null ? config.defaultDurationSec : XFADE_DURATION
  const overrides = new Map<number, MergeTransitionGap>()
  for (const g of config?.gaps || []) overrides.set(g.index, g)
  const out: Array<{ type: string; durationSec: number }> = []
  for (let i = 0; i < Math.max(0, gapCount); i++) {
    const g = overrides.get(i)
    out.push({
      type: g?.type || defaultType,
      durationSec: g?.durationSec != null ? g.durationSec : defaultDur,
    })
  }
  return out
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
async function normalizeClips(videos: string[], encode: MergeEncodeParams): Promise<string[]> {
  fs.mkdirSync(NORMALIZE_DIR, { recursive: true })

  const absPaths = videos.map(toAbsPath)
  const probes: MediaProbe[] = []
  for (const p of absPaths) {
    probes.push(await probeMedia(p))
  }

  // ★ Sprint 38 T1-B (PM msg-20261110-165): 基准取【最常见的规格】, 不是第一个 clip ——
  //   混分辨率时用第一个 clip 当基准 → 【多数派】片段全被上采样放大 (放大不增细节, 成片整体发软;
  //   实测 19 个片段里 17 个是 1344x768, 基准却是镜#1 的 1920x1056 → 18 个片段全被放大 + 全转一遍码),
  //   而且每个不符的片段都要走一遍 libx264 转码 (归一化阶段 2.5 分钟)。
  //   取最常见的那档 → 多数派不用转码, 少数派才转 (混分辨率时才有转码)。
  //   帧率同理 (原来也取第一个 clip 的 fps)。
  const ranked = rankSpecsByFrequency(probes)
  const base = ranked[0]?.spec
  if (!base) {
    throw new Error('normalize-failed: 无法探测任何 clip 的分辨率, 归一化终止')
  }
  const targetW = base.width
  const targetH = base.height
  const targetFps = base.fps

  const missingAudio = probes.filter(p => !p.hasAudio).length
  const specMismatch = probes.filter(p =>
    p.width !== targetW || p.height !== targetH || (p.fps > 0 && Math.abs(p.fps - targetFps) > 0.5),
  ).length
  logTaskProgress('MergeTask', 'normalize-plan', {
    clips: videos.length,
    missingAudio,
    specMismatch,
    target: { width: targetW, height: targetH, fps: targetFps },
    // ★ T1-B: 基准选择理由 + 各规格的 clip 数 (便于以后排查『为什么转了这么多段』)
    targetReason: 'most-common-spec',
    specCounts: ranked.map(r => ({ spec: r.key, count: r.count })),
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
          // ★ Sprint 39 T1: 中间产物也要保住细节 (它会被最终编码再压一次) → 用同一套质量参数
          '-preset', encode.preset,
          '-crf', String(encode.crf),
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
async function mergeWithXfade(
  clips: string[],
  durationSec: number[],
  outputPath: string,
  encode: MergeEncodeParams,
  transitions: Array<{ type: string; durationSec: number }>,
  grade?: MergeGradeConfig,
  mergedSrtPath?: string | null,
): Promise<void> {
  // ★ Sprint 39 T2: 逐镜缝的转场 (默认全是 fade + XFADE_DURATION → 与改动前逐字一致)
  const D = XFADE_DURATION
  const fmtDur = (d: number) => String(Number(Number(d).toFixed(3)))
  const gap = (i: number) => transitions[i - 1] || { type: 'fade', durationSec: D }

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
  let accDur = durationSec[0] - gap(1).durationSec
  for (let i = 1; i < clips.length; i++) {
    const g = gap(i)
    const offset = accDur.toFixed(3)
    const isLast = i === clips.length - 1
    const outLabel = isLast ? 'vout' : `v${i}`
    filters.push(`[${i === 1 ? '0:v' : `v${i - 1}`}][${i}:v]xfade=transition=${g.type}:duration=${fmtDur(g.durationSec)}:offset=${offset}[${outLabel}]`)
    accDur += durationSec[i] - g.durationSec
  }
  // 音频: acrossfade 逐段交叉淡化 (xfade 只管视频)
  //
  // ⚠️ 这里不能用 concat: xfade 会吃掉 (N-1)×D 的总时长, 但音频 concat 不重叠,
  //    会导致 audio 比 video 长 (实测 3×2s clip: video 5.6s / audio 6.0s),
  //    输出末尾出现"只有声音没有画面"的尾巴。
  //    acrossfade 每段同样消耗 D 秒, 音画总时长一致 (实测 audio 5.616 vs video 5.600,
  //    16ms 差是 AAC 帧对齐误差, 听感/观感无影响)。
  // ★ 音频的交叉淡化时长【跟随该镜缝的视频转场时长】→ 音画总时长一致 (AC)
  let accDurAudio = durationSec[0] - gap(1).durationSec
  for (let i = 1; i < clips.length; i++) {
    const g = gap(i)
    const isLast = i === clips.length - 1
    const outLabel = isLast ? 'aout' : `a${i}`
    const inLabel = i === 1 ? '0:a' : `a${i - 1}`
    filters.push(`[${inLabel}][${i}:a]acrossfade=d=${fmtDur(g.durationSec)}:c1=tri:c2=tri[${outLabel}]`)
    accDurAudio += durationSec[i] - g.durationSec
  }

  // ★ Sprint 39 T3: 全片统一调色 —— 套在【所有转场之后】(一次性作用于整片, 不是只作用在某几段)
  let videoOut = 'vout'
  if (grade?.enabled) {
    filters.push(`[vout]eq=brightness=${grade.brightness}:contrast=${grade.contrast}:saturation=${grade.saturation}[vgraded]`)
    videoOut = 'vgraded'
  }
  // ★ Sprint 39 T4: 拼接阶段烧字幕 (在转场与调色之后, 一次性套整片)
  if (mergedSrtPath) {
    const esc = mergedSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    filters.push(`[${videoOut}]subtitles=filename='${esc}':fontsdir='${SUBTITLE_FONTS_DIR}':force_style='${SUBTITLE_FORCE_STYLE}'[vsub]`)
    videoOut = 'vsub'
  }

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
    for (const clip of clips) cmd.input(clip)
    cmd
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-map', `[${videoOut}]`,
        '-map', '[aout]',
        '-c:v', 'libx264',
        // ★ Sprint 39 T1: crf/preset 可配 (env), 默认 crf 18 + preset medium (比改动前好)
        '-preset', encode.preset,
        '-crf', String(encode.crf),
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

async function doMerge(
  mergeId: number,
  episodeId: number,
  videos: string[],
  transitionConfig?: MergeTransitionConfig,
  gradeConfig?: MergeGradeConfig,
  subtitleStage?: MergeSubtitleStage,
  storyboards?: Array<{ subtitleUrl?: string | null }>,
) {
  // 输出文件 (先定路径, 归一化与两种拼接方式都写到这里)
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  // ★ Sprint 39 T1: 解析编码参数 (env 可配); preset 被降级时留痕
  const encode = resolveMergeEncodeParams()
  // ★ Sprint 39 T2: 逐镜缝转场列表 (默认 = fade + 400ms; 逐镜缝覆盖优先) → 日志里要能查
  const transitions = buildTransitionList(transitionConfig, Math.max(0, videos.length - 1))
  if (encode.rejectedPreset) {
    logTaskWarn('MergeTask', 'merge-preset-rejected', {
      mergeId, episodeId,
      requested: encode.rejectedPreset,
      used: encode.preset,
      hint: '比 medium 更快的 preset 会降低画质 → 已忽略 (AC: 禁止用降 preset 换速度)',
    })
  }

  // ── Task B 前置: 音频 + 规格归一化 ──
  //   concat demuxer 遇流结构不一致会静默输出纯视频 (rc=0), 所以必须先统一。
  //   任一 clip 归一化失败 → throw (fail-fast, 不静默跳过)
  const normalized = await normalizeClips(videos, encode)
  const normalizedProbes: MediaProbe[] = []
  for (const p of normalized) normalizedProbes.push(await probeMedia(p))
  const anyInputHasAudio = normalizedProbes.some(p => p.hasAudio)

  // ── ★ Sprint 39 T4: 字幕烧录时机 ──
  //   'compose' (默认) = 合成阶段已经烧进画面了 → 拼接阶段【不】再烧 (否则叠两层字幕)
  //   'merge' = 合成阶段没烧 → 拼接阶段把各镜 SRT 平移后拼成整片 SRT, 一次性烧上去 (只过一次有损编码)
  const stage: MergeSubtitleStage = subtitleStage === 'merge' ? 'merge' : 'compose'
  let mergedSrtPath: string | null = null
  if (stage === 'merge' && storyboards && storyboards.length) {
    mergedSrtPath = buildFilmSrt(storyboards, normalizedProbes.map(p => p.durationSec), transitions)
    if (mergedSrtPath) {
      logTaskProgress('MergeTask', 'film-srt-built', {
        mergeId, episodeId, path: mergedSrtPath,
        clips: storyboards.length,
        hint: '字幕改在拼接阶段烧 → 只过一次有损编码',
      })
    }
  }

  // ── Task F: 优先 xfade 转场, 失败 fallback 硬切 concat ──
  let usedXfade = false
  let xfadeFallbackReason: string | null = null

  if (XFADE_ENABLED && normalized.length > 1) {
    try {
      await mergeWithXfade(
        normalized,
        normalizedProbes.map(p => p.durationSec),
        outputPath,
        encode,
        transitions,
        gradeConfig,
        mergedSrtPath,
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
            // ★ Sprint 39 T1: 同上 (硬切回退路径也要用同一套质量参数)
            '-preset', encode.preset,
            '-crf', String(encode.crf),
            // ★ Sprint 39 T3: 硬切回退路径也要套全片调色 (与 xfade 路径一致)
            ...(gradeConfig?.enabled
              ? ['-vf', `eq=brightness=${gradeConfig.brightness}:contrast=${gradeConfig.contrast}:saturation=${gradeConfig.saturation}`]
              : []),
            // ★ Sprint 39 T4: 回退路径也要烧字幕 (与 xfade 路径一致)
            ...(mergedSrtPath
              ? ['-vf', `subtitles=filename='${mergedSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}':fontsdir='${SUBTITLE_FONTS_DIR}':force_style='${SUBTITLE_FORCE_STYLE}'`]
              : []),
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

  // ── ★ Sprint 39 T5 (PM msg-20261111-169): 拼接流程日志补全 ──
  //   ★ 没有配置时也记录默认值 (不然事后分不清『没配』还是『没记』)
  //   ★ 逐镜缝的转场记成【一条结构化记录】里的列表, 不是一行一镜 (19 镜就 19 行 → 日志体积异常膨胀)
  let outputSizeBytes = 0
  try { outputSizeBytes = fs.statSync(outputPath).size } catch { /* 忽略 */ }
  const avgBitrateKbps = duration > 0 ? Math.round((outputSizeBytes * 8) / duration / 1000) : 0

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
    // 逐镜缝转场 (一条记录里装下整个列表)
    transitions: transitions.map((t, i) => ({
      gap: i + 1,                       // 第 1 个镜缝 = 第1镜与第2镜之间
      type: t.type,
      durationMs: Math.round(t.durationSec * 1000),
    })),
    transitionCount: transitions.length,
    // 全片调色 (默认关闭也要记)
    grade: {
      enabled: !!gradeConfig?.enabled,
      brightness: gradeConfig?.brightness ?? DEFAULT_MERGE_GRADE.brightness,
      contrast: gradeConfig?.contrast ?? DEFAULT_MERGE_GRADE.contrast,
      saturation: gradeConfig?.saturation ?? DEFAULT_MERGE_GRADE.saturation,
    },
    // 字幕烧录时机 (T4: compose = 合成阶段烧 (默认) / merge = 拼接阶段烧)
    subtitleStage: stage,
    // 最终成片的编码参数
    encode: {
      codec: 'h264',
      preset: encode.preset,
      crf: encode.crf,
      width: outputProbe.width,
      height: outputProbe.height,
      fps: outputProbe.fps,
      audio: 'aac/48000/192k',
      avgBitrateKbps,
      sizeBytes: outputSizeBytes,
    },
    // 是否走了兜底路径 (转场失败 → 硬切 concat)
    usedFallbackPath: !usedXfade,
  })
}

/**
 * ★ Sprint 39 T4: 把各镜的 SRT 按【在成片里的起点】平移后拼成一份整片 SRT。
 *   起点 = 前面的镜的时长之和 - 被转场吃掉的时长 (与 xfade 的 offset 同一套算法)。
 */
function buildFilmSrt(
  storyboards: Array<{ subtitleUrl?: string | null }>,
  durations: number[],
  transitions: Array<{ type: string; durationSec: number }>,
): string | null {
  const blocks: string[] = []
  let start = 0
  for (let i = 0; i < storyboards.length; i++) {
    if (i > 0) start += (durations[i - 1] || 0) - (transitions[i - 1]?.durationSec || 0)
    const rel = storyboards[i]?.subtitleUrl
    if (!rel) continue
    try {
      const p = toAbsPath(rel)
      if (!fs.existsSync(p)) continue
      const shifted = shiftSrtTimestamps(fs.readFileSync(p, 'utf-8'), start)
      if (shifted.trim()) blocks.push(shifted)
    } catch { /* 单镜 SRT 读不到就跳过, 不阻断整片 */ }
  }
  if (!blocks.length) return null
  const merged = mergeSrtBlocks(blocks)
  if (!merged.trim()) return null
  const dir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, `${uuid()}-film.srt`)
  fs.writeFileSync(outPath, merged + '\n', 'utf-8')
  return outPath
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}

/**
 * ★ Sprint 40 T2 (PM msg-20261112-171): BGM 铺底 + 对白 ducking —— 【纯逻辑模块】
 *
 * 【为什么要拆出来】
 *   这一块是纯计算 (校验 + ffmpeg filter 链拼装), 不碰数据库、不碰 ffmpeg 子进程 →
 *   拆成独立模块后可以离线断言 (不用起服务、不用连 DB), 也避免把大段逻辑混进 ffmpeg-merge.ts。
 *
 * 【ducking 的做法 —— 必须是"动态压低", 不能是"固定压低"】
 *   工单明确不接受把 BGM 固定压低冒充 ducking (那样人声一停 BGM 还是那么低, 整片发闷)。
 *   这里用 ffmpeg 的 sidechaincompress: 【对白轨当 sidechain key】——
 *   对白一响 BGM 自动降下去, 人声一停 (release 毫秒后) BGM 自动回升。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** data 根目录 (容器内 = /app/data; 与后端其它模块保持一致) */
export const DATA_ROOT = path.resolve(__dirname, '../../../data')
/** BGM 素材目录 (PM 决策 D1: data/media/bgm/) */
export const BGM_DIR = path.join(DATA_ROOT, 'media', 'bgm')

export interface MergeBgmConfig {
  /** 素材文件名 (data/media/bgm/ 下的纯文件名; 空字符串 = 不加 BGM = 与改动前逐样本一致) */
  file: string
  /** BGM 音量 (dB, 负值 = 压低) */
  volumeDb: number
  /** ducking 阈值 (线性幅度): 对白超过这个值就开始压 BGM */
  threshold: number
  /** ducking 压缩比 (越大压得越狠) */
  ratio: number
  /** ducking 起控时间 (毫秒): 多快压下去 */
  attack: number
  /** ducking 释放时间 (毫秒): 人声停了多久回升 */
  release: number
}

/** 默认值: 不加 BGM; 音量 -18dB (人声优先); ducking 温和但能听出效果 */
export const DEFAULT_MERGE_BGM: MergeBgmConfig = {
  file: '',
  volumeDb: -18,
  threshold: 0.03,
  ratio: 8,
  attack: 15,
  release: 350,
}

/**
 * 素材文件名 → 绝对路径。
 * ★ 只允许【纯文件名】(不允许带目录) → 防路径穿越; 目录里没有 → null (当作没配 BGM)。
 */
export function resolveBgmPath(file: string, bgmDir: string = BGM_DIR): string | null {
  if (!file) return null
  const base = path.basename(file)
  if (base !== file) return null
  const abs = path.join(bgmDir, base)
  try {
    if (!fs.existsSync(abs)) return null
  } catch {
    return null
  }
  return abs
}

/**
 * 校验 BGM 配置 (非法值挡住 → 不建 merge 记录, 不产生 failed 脏数据)。
 * @param requireFileExists 读持久化设置时传 false
 *   (素材被删了 → 静默降级为"不加 BGM", 但不该把用户配的音量/duck 参数一起丢掉)
 */
export function validateBgmConfig(
  input: any,
  bgmDir: string = BGM_DIR,
  requireFileExists: boolean = true,
): { ok: boolean; config: MergeBgmConfig; errors: string[] } {
  const config: MergeBgmConfig = { ...DEFAULT_MERGE_BGM }
  const errors: string[] = []
  if (input == null) return { ok: true, config, errors }
  if (typeof input !== 'object') return { ok: false, config, errors: ['BGM 配置格式不对 (需要是一个对象)'] }

  if (input.file != null) {
    const f = String(input.file)
    if (!f) {
      config.file = ''
    } else if (path.basename(f) !== f) {
      errors.push('BGM 文件名不合法 (只填文件名, 不要带路径)')
    } else if (requireFileExists && !resolveBgmPath(f, bgmDir)) {
      errors.push(`BGM 素材不存在: ${f} (要放到 data/media/bgm/ 目录里)`)
    } else {
      config.file = f
    }
  }

  const ranges: Array<[keyof MergeBgmConfig, number, number]> = [
    ['volumeDb', -60, 0],
    ['threshold', 0.001, 1],
    ['ratio', 1, 20],
    ['attack', 0.01, 2000],
    ['release', 0.01, 9000],
  ]
  for (const [k, min, max] of ranges) {
    if (input[k] == null) continue
    const v = Number(input[k])
    if (!Number.isFinite(v)) { errors.push(`${k} 不是数字`); continue }
    if (v < min || v > max) { errors.push(`${k} 超出范围 (${min}~${max})`); continue }
    (config as any)[k] = v
  }
  return { ok: errors.length === 0, config, errors }
}

/**
 * ★ Sprint 40 T2 (PM msg-20261112-171): 【API 生成音乐】—— 本期只留口子, 不做实现 (PM 决策 D3)
 *
 * 前端入口已存在但是【禁用态】(disabled + 说明文案) —— 不允许做成"点了没反应"或"假成功"的按钮。
 *
 * TODO(未来实现, 需求方拍板后开工):
 *   1) 新增 POST /api/v1/media-library/bgm/generate
 *      —— 走【生成式音乐 API】: 供应商/模型与 AIConfig 里新增的音乐类配置一致
 *         (和 TTS/音色配置同一套 baseUrl + apiKey + model 取法, 不要另起一套凭证);
 *      —— 入参: 时长 / 风格 / 情绪提示词 (可选), 落盘文件名由服务端生成 (uuid + 扩展名);
 *   2) 生成结果【落到 data/media/bgm/】(与用户自备素材同一个目录 → 前端下拉自动出现, 无需额外接口);
 *      ★ 素材不进 git / 不进镜像 (PM 决策 D1) —— 与手工放进去的素材完全同权;
 *   3) 接口返回 { file, durationSec } → 前端把该 file 写进 mergeBgm.file 并调
 *      POST /merge/episodes/:id/merge/settings 落库 → 自动选中, 用户直接点拼接即可;
 *   4) 生成的音频同样要支持【循环铺满 + 对白 ducking】(复用 buildBgmMixChain, 不要另写一套混音逻辑);
 *      建议生成时约束成【无缝循环】的纯音乐 (无 vocals), 否则 ducking 的 sidechain key 会被伴奏干扰。
 */
export interface BgmMixChain {
  /** 要追加到 filter_complex 的片段 (顺序即拼接顺序) */
  filters: string[]
  /** 最终音频输出 label (拼接时 map 这个) */
  audioOutLabel: string
  /** BGM 铺到的时长 (秒) = 成片时长 */
  coveredSec: number
}

/**
 * BGM 铺底 + 对白 ducking 的 filter 链 (纯函数 → 可离线断言)。
 *
 * 链路:
 *   [对白]asplit=2            → 一路进 amix, 一路当 sidechain key
 *   [BGM]aformat→volume→atrim → 统一 48k 立体声 / 音量 / 截到成片时长
 *   [BGM][对白key]sidechaincompress → ★ 动态压低 (有人说话就降, 人声停了回升)
 *   [对白][压过的BGM]amix     → 最终音轨 (normalize=0: 默认 1 会把两路都减半)
 *
 * ★ 不加 BGM 时这个函数根本不会被调用 → filter 链与改动前【逐字一致】(PM 决策 D4)。
 */
export function buildBgmMixChain(
  dialogueLabel: string,
  bgm: MergeBgmConfig,
  bgmInputIndex: number,
  totalDurationSec: number,
): BgmMixChain {
  const bgmRaw = 'bgmraw'
  const bgmDuck = 'bgmd'
  // ★ 输出 label 只用字母数字下划线: 输入 label 可能是 '0:a' 这种带冒号的流说明符,
  //   直接拼成输出 label 会在 -map "[0:a_bgm]" 时被当成流说明符解析 → 踩坑 (真跑 ffmpeg 才发现)
  const base = String(dialogueLabel).replace(/[^A-Za-z0-9_]/g, '_')
  const dlgMain = `${base}_dlg`
  const dlgKey = `${base}_key`
  const out = `${base}_bgm`
  // 截到成片时长 + 0.25s 余量: 预估时长与实际成片有 AAC 帧对齐误差, 留余量免得尾部缺音;
  // 多出来的部分由 amix(duration=first) 按对白长度截掉 → 不会溢出成片。
  const trimEnd = Math.max(0, Number(totalDurationSec) + 0.25).toFixed(3)
  return {
    coveredSec: Number(totalDurationSec),
    audioOutLabel: out,
    filters: [
      `[${dialogueLabel}]asplit=2[${dlgMain}][${dlgKey}]`,
      `[${bgmInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,volume=volume=${bgm.volumeDb}dB,atrim=end=${trimEnd},asetpts=N/SR/TB[${bgmRaw}]`,
      `[${bgmRaw}][${dlgKey}]sidechaincompress=threshold=${bgm.threshold}:ratio=${bgm.ratio}:attack=${bgm.attack}:release=${bgm.release}[${bgmDuck}]`,
      `[${dlgMain}][${bgmDuck}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[${out}]`,
    ],
  }
}

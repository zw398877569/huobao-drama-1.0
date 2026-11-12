/**
 * ★ Sprint 40 T2 (PM msg-20261112-171): 素材库【只读】接口
 *
 * 【为什么】BGM / 音效素材要有一个统一的【目录约定】(PM 决策 D1):
 *   data/media/bgm/   —— 背景音乐
 *   data/media/sfx/   —— 音效
 *   素材由 PM 手工放进目录, DEV 只实现机制 (D2: 用户自备素材与授权库素材是同一套机制)。
 *
 * 【硬约束】
 *   ★ 目录不存在 → 按【空列表】处理, 不报错、不 500 (D1 明确要求)
 *   ★ 【只读】: 本文件只有 GET, 没有任何写/删接口 —— 素材的增删是人工放文件, 不是接口操作
 *   ★ 素材【不进 git 仓库、不进 Docker 镜像】(D1) → 运行时从 data 目录读
 *   ★ 纯函数部分 (listAudioFiles) 不碰 ffprobe → 可离线断言
 */
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { success, badRequest } from '../utils/response.js'
import { probeDuration } from '../utils/ffprobe-helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** data 根目录 (容器内 = /app/data, 与后端其它模块保持一致) */
export const DATA_ROOT = path.resolve(__dirname, '../../../data')
/** 素材根目录 */
export const MEDIA_ROOT = path.join(DATA_ROOT, 'media')
export const MEDIA_KINDS = ['bgm', 'sfx'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** 认得的音频扩展名 (小写比较) */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'])
/** 一次最多探测多少个文件的时长 (每个 ffprobe 都是一个子进程, 太多会把请求拖死) */
const MAX_PROBE_FILES = 200
/** ffprobe 并发上限 */
const PROBE_CONCURRENCY = 6

export interface MediaLibraryItem {
  /** 纯文件名 (不含目录) */
  name: string
  /** 字节大小 */
  sizeBytes: number
  /** 时长 (秒, 探测失败 = 0) */
  durationSec: number
}

export interface MediaLibrary {
  kind: MediaKind
  /** 相对项目根的目录 (给前端显示用: data/media/bgm) */
  dir: string
  items: MediaLibraryItem[]
}

/**
 * 列出目录下的音频文件名 (纯函数, 同步, 不碰 ffprobe → 可离线断言)。
 * ★ 目录不存在 / 读不了 → 返回空数组 (不抛错) —— PM 决策 D1。
 */
export function listAudioFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/** 并发受限的 map (避免一次起几十个 ffprobe) */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 构建某个 kind 的素材库 (文件名 + 字节大小 + 时长)。
 * ★ 目录不存在 → 空 items (不报错)。
 */
export async function buildMediaLibrary(
  kind: MediaKind,
  dir: string = path.join(MEDIA_ROOT, kind),
): Promise<MediaLibrary> {
  const names = listAudioFiles(dir)
  const items = await mapLimit(names.slice(0, MAX_PROBE_FILES), PROBE_CONCURRENCY, async (name) => {
    const abs = path.join(dir, name)
    let sizeBytes = 0
    try { sizeBytes = fs.statSync(abs).size } catch { /* 读不到大小就当 0 */ }
    return { name, sizeBytes, durationSec: await probeDuration(abs) } satisfies MediaLibraryItem
  })
  return { kind, dir: `data/media/${kind}`, items }
}

const app = new Hono()

/**
 * GET /media-library            → 返回 { bgm: {...}, sfx: {...} } (两种都列)
 * GET /media-library?kind=bgm   → 只列 bgm
 * ★ 只读接口 (本文件没有 POST/PUT/DELETE)。
 */
app.get('/media-library', async (c) => {
  const kindParam = c.req.query('kind')
  if (kindParam) {
    if (!MEDIA_KINDS.includes(kindParam as MediaKind)) {
      return badRequest(c, `kind 不合法 (可选: ${MEDIA_KINDS.join(' / ')})`)
    }
    return success(c, await buildMediaLibrary(kindParam as MediaKind))
  }
  const [bgm, sfx] = await Promise.all([
    buildMediaLibrary('bgm'),
    buildMediaLibrary('sfx'),
  ])
  return success(c, { bgm, sfx })
})

export default app

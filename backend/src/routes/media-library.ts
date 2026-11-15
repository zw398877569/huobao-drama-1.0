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
// ★ Sprint 46 T1 (PM msg-20261115-186): 上传校验拆到 services/media-upload.ts (纯函数 → 可离线断言)
//   白名单从那边引入 —— 上传与扫描必须用【同一份】清单, 否则会出现"传得上去但列不出来"。
import {
  AUDIO_EXTENSIONS as AUDIO_EXTENSION_LIST,
  MAX_UPLOAD_BYTES,
  isSupportedAudioFile,
  sanitizeUploadFilename,
  saveUploadedMediaFile,
  validateUploadSize,
} from '../services/media-upload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** data 根目录 (容器内 = /app/data, 与后端其它模块保持一致) */
export const DATA_ROOT = path.resolve(__dirname, '../../../data')
/** 素材根目录 */
export const MEDIA_ROOT = path.join(DATA_ROOT, 'media')
export const MEDIA_KINDS = ['bgm', 'sfx'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** 认得的音频扩展名 (小写比较) */
const AUDIO_EXTENSIONS = new Set(AUDIO_EXTENSION_LIST)
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
// ★ Sprint 41 追加单 178 (PM msg-20261114-178): 内部路径必须是 '/' ——
//   外面 index.ts 已经用 api.route('/media-library', mediaLibrary) 挂了一层前缀,
//   写成 '/media-library' → 实际完整路径变成 /api/v1/media-library/media-library
//   → 前端调 /api/v1/media-library 匹配不到 → 落到 Nuxt 的 catch-all 返回 index.html
//   → 前端 JSON 解析炸 (Unexpected token '<') → ★ BGM/音效面板一直拿不到数据
//   (其它路由都是 app.get('/') / app.get('/xxx') 这种【相对挂载前缀】的写法)
/**
 * ★ Sprint 46 T1 (PM msg-20261115-186): POST /media-library/upload —— 上传音频素材 (BGM / 音效通用)
 *   ★ 内部路径必须是【相对挂载前缀】('/upload') → 完整路径 = /api/v1/media-library/upload
 *     (写成 '/media-library/upload' 会变成 /api/v1/media-library/media-library/upload → 前端 404)
 *   ★ 落点必须是 data/media/{kind}/ (跟列表扫描【同一个目录】) → 否则"传上去了但下拉框里不出现"
 *   ★ 返回的 name 是【纯文件名】→ 前端落库就存它 (带路径会被后端判非法 → 静默不铺 BGM)
 *   ★ 重名不覆盖 → 409 + 明确提示 (别让用户以为选的是新文件)
 */
app.post('/upload', async (c) => {
  const kindParam = c.req.query('kind') || 'bgm'
  if (!MEDIA_KINDS.includes(kindParam as MediaKind)) {
    return badRequest(c, `kind 不合法 (可选: ${MEDIA_KINDS.join(' / ')})`)
  }
  const kind = kindParam as MediaKind

  // ★ 先看 Content-Length → 超大直接拒, 别把整个 body 读进内存
  const lenHeader = c.req.header('content-length')
  if (lenHeader) {
    const len = Number(lenHeader)
    if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES + 1024 * 1024) {
      return badRequest(c, `文件太大 (上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`)
    }
  }

  let body: Record<string, any>
  try {
    body = await c.req.parseBody()
  } catch (e: any) {
    return badRequest(c, `上传内容解析失败: ${e?.message || e}`)
  }
  const file = body['file']
  if (!file || typeof file === 'string' || !(file instanceof File)) {
    return badRequest(c, '没有收到文件 (表单字段名要用 file)')
  }

  const nameCheck = sanitizeUploadFilename(file.name)
  if (!nameCheck.ok) return badRequest(c, nameCheck.message)
  const filename = nameCheck.filename

  if (!isSupportedAudioFile(filename)) {
    const ext = path.extname(filename) || filename
    return badRequest(c, `格式不支持【${ext}】—— 只支持 ${AUDIO_EXTENSION_LIST.join(' ')}`)
  }

  const sizeCheck = validateUploadSize(file.size)
  if (!sizeCheck.ok) return badRequest(c, sizeCheck.message)

  const data = Buffer.from(await file.arrayBuffer())
  const saved = saveUploadedMediaFile(kind, filename, data)
  if (!saved.ok) {
    if (saved.code === 'duplicate') {
      return c.json({ code: 409, message: saved.message }, 409)
    }
    return badRequest(c, saved.message)
  }

  const durationSec = await probeDuration(saved.file.absPath)
  return success(c, {
    kind,
    name: saved.file.filename,
    sizeBytes: saved.file.sizeBytes,
    durationSec,
    dir: `data/media/${kind}`,
  })
})

app.get('/', async (c) => {
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

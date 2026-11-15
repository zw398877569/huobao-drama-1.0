/**
 * ★ Sprint 46 T1 (PM msg-20261115-186): 素材库【上传】(BGM / 音效 通用)
 *
 * 【为什么要单独一个模块】
 *   素材上传最关键的是【落点必须和扫描点一致】:
 *   列表接口只扫 data/media/{kind}/ 下的音频文件 → 上传也必须落到同一个目录,
 *   否则【传上去了但下拉框里不出现】, 用户会以为上传失败。
 *   所以这里把"目录"和"白名单"跟 routes/media-library.ts 放在同一套常量上 (见下方注释)。
 *
 * 【为什么校验是纯函数】
 *   扩展名白名单 / 大小上限 / 文件名净化 / 重名判断都能离线断言,
 *   路由层只负责 HTTP (解析 formData / 拼错误码) —— 逻辑不混在路由里。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** data 根目录 (容器内 = /app/data; 与后端其它模块保持一致) */
export const DATA_ROOT = path.resolve(__dirname, '../../../data')
/** 素材根目录 (data/media/) */
export const MEDIA_ROOT = path.join(DATA_ROOT, 'media')

/** ★ 必须与 routes/media-library.ts 的扫描白名单【逐字一致】——
 *   白名单不一致会出现"传得上去但列不出来"或"列得出来但传不上去"的鬼哭狼嚎。 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']

/** 上传大小上限: 50MB (PM 单只给了 200MB 被拒的例子 → 这里取一个用户端不会误伤的阈值) */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export type MediaKind = 'bgm' | 'sfx'

/** 文件名是否在白名单里 (纯函数) */
export function isSupportedAudioFile(filename: string): boolean {
  return AUDIO_EXTENSIONS.includes(path.extname(String(filename || '')).toLowerCase())
}

/**
 * 文件名净化: 只接受【纯文件名】(不带任何目录分隔符)。
 * ★ 返回的 filename 会直接拼到目录上 → 路径穿越必须在这一步堵死。
 */
export function sanitizeUploadFilename(originalName: string): { ok: true; filename: string } | { ok: false; message: string } {
  const raw = String(originalName || '').trim()
  if (!raw) return { ok: false, message: '没有拿到文件名' }
  if (raw === '.' || raw === '..') return { ok: false, message: '文件名不合法' }
  // 含分隔符 → 一律拒 (不静默取 basename: 用户传的是 "a/b.mp3" 时要告诉他, 而不是存成 b.mp3)
  if (raw.includes('/') || raw.includes('\\')) return { ok: false, message: '文件名不合法 (不能带路径)' }
  if (/[\u0000-\u001f]/.test(raw)) return { ok: false, message: '文件名不合法 (含控制字符)' }
  if (raw.length > 200) return { ok: false, message: '文件名太长 (最多 200 个字符)' }
  if (path.basename(raw) !== raw) return { ok: false, message: '文件名不合法 (不能带路径)' }
  return { ok: true, filename: raw }
}

/** 大小校验 (纯函数) */
export function validateUploadSize(sizeBytes: number, maxBytes: number = MAX_UPLOAD_BYTES): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, message: '文件是空的' }
  if (sizeBytes > maxBytes) {
    return { ok: false, message: `文件太大 (上限 ${Math.round(maxBytes / 1024 / 1024)}MB)` }
  }
  return { ok: true }
}

/** 某个 kind 的素材目录绝对路径 */
export function mediaKindDir(kind: MediaKind, root: string = MEDIA_ROOT): string {
  return path.join(root, kind)
}

export interface SavedMediaFile {
  /** 纯文件名 (落库就存这个 —— 带路径会被后端判非法 → 静默不铺 BGM) */
  filename: string
  /** 绝对路径 */
  absPath: string
  sizeBytes: number
}

/**
 * 落盘: 目录不存在就建 → 用 wx 标志原子写入 (同名直接失败, 不覆盖)。
 * @returns ok=false 时 message 可直接给用户看
 */
export function saveUploadedMediaFile(
  kind: MediaKind,
  filename: string,
  data: Buffer,
  root: string = MEDIA_ROOT,
): { ok: true; file: SavedMediaFile } | { ok: false; message: string; code?: 'duplicate' } {
  const dir = mediaKindDir(kind, root)
  const absPath = path.join(dir, filename)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e: any) {
    return { ok: false, message: `素材目录建不出来: ${e?.message || e}` }
  }
  try {
    // wx = 文件已存在就抛 EEXIST (不覆盖已有素材)
    fs.writeFileSync(absPath, data, { flag: 'wx' })
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      return { ok: false, code: 'duplicate', message: `素材库里已经有同名文件【${filename}】—— 换个名字再传 (不会覆盖已有素材)` }
    }
    return { ok: false, message: `写入失败: ${e?.message || e}` }
  }
  let sizeBytes = data.byteLength
  try {
    sizeBytes = fs.statSync(absPath).size
  } catch { /* 读不到就用 buffer 长度 */ }
  // 落地后复核一次大小 (防"声明的大小"和"实际写进去的大小"不一致)
  const sizeCheck = validateUploadSize(sizeBytes)
  if (!sizeCheck.ok) {
    try { fs.unlinkSync(absPath) } catch { /* 删不掉就留着, 反正超限文件不会被列进白名单 */ }
    return { ok: false, message: sizeCheck.message }
  }
  return { ok: true, file: { filename, absPath, sizeBytes } }
}

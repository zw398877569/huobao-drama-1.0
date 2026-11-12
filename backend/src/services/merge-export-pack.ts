/**
 * ★ Sprint 40 T1 (PM msg-20261112-171): 导出【素材包】(ZIP) —— 人工精修的输入。
 *
 * 【为什么】OpenChatCut 之类通用剪辑器不知道「哪一镜是谁在说哪句台词」→ 光给它一堆 mp4
 *   它只能按顺序拼, 台词/角色/道具全丢了 → 所以这个包的核心是 manifest.json
 *   (剧/集/每镜的时长·起点·场景·角色·台词·道具·提示词), clips/ 与 subtitles/ 是素材。
 *
 * 【不重编码】clips/ 里是 compose 产出的 mp4 【直接复制】→ 文件与源逐字节一致
 *   (可被 md5/ffprobe 验证)。本项目不引 zip 依赖 → 手写了一个 STORE 方式的最小 ZIP 写入器
 *   (backend/src/utils/zip.ts): mp4/srt 本身已是压缩格式, 再 deflate 几乎不省空间。
 *
 * 【不导出半成品】本集还有镜没合成完 → 直接报错并列出缺哪几镜 (不导一个缺镜的包)。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { probeMedia } from '../utils/ffprobe-helpers.js'
import { parseDialogueSegments } from '../utils/dialogue-parser.js'
import { getEpisodeSpeakerWhitelist } from '../utils/speaker-whitelist.js'
import { createZipFile, type ZipEntry } from '../utils/zip.js'
import { readMergeSettings } from './ffmpeg-merge.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../data')
const PACK_DIR = path.join(DATA_ROOT, 'temp', 'export-packs')
/** 导出包在临时目录的保留时长 (1 小时) —— 过期自动清, 不长期占磁盘 */
const PACK_TTL_MS = 60 * 60 * 1000

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(DATA_ROOT, 'static', relativePath)
}

function pad2(n: number) { return String(n).padStart(2, '0') }

/** 清掉过期的导出包 */
export function cleanupOldExportPacks(nowMs = Date.now()): number {
  let removed = 0
  try {
    for (const f of fs.readdirSync(PACK_DIR)) {
      const p = path.join(PACK_DIR, f)
      try {
        const st = fs.statSync(p)
        if (nowMs - st.mtimeMs > PACK_TTL_MS) { fs.unlinkSync(p); removed++ }
      } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 → 没有可清的 */ }
  return removed
}

export interface MergePackClip {
  index: number
  storyboard_id: number
  file: string
  subtitle_file: string | null
  duration_sec: number
  start_in_pack_sec: number
  scene: { id: number | null; name: string | null }
  characters: Array<{ id: number; name: string }>
  dialogue: Array<{ speaker: string; text: string }>
  props: Array<{ id: number; name: string }>
  video_prompt: string | null
  note: string | null
}

export interface MergePackManifest {
  generated_at: string
  drama: { id: number; title: string | null; style: string | null }
  episode: { id: number; number: number | null; title: string | null }
  total_duration_sec: number
  clip_count: number
  bgm: string | null
  clips: MergePackClip[]
}

export interface MergePackResult {
  zipPath: string
  zipName: string
  clipCount: number
  totalDurationSec: number
}

/**
 * 构建本集的素材包 (ZIP)。
 * @throws 本集还有镜没合成完 → 抛错 (message 里列出缺哪几镜)
 */
export async function buildMergeExportPack(episodeId: number): Promise<MergePackResult> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  if (!sbs.length) throw new Error('本集没有镜头, 无法导出素材包')

  // ★ 没合成完的镜 → 明确报错并列出缺哪几镜 (不导半成品包)
  const missing = sbs.filter(sb => !sb.composedVideoUrl)
  if (missing.length) {
    throw new Error(
      `还有 ${missing.length} 个镜头没合成完, 不能导出素材包: `
      + missing.map(sb => `#${sb.storyboardNumber}`).join('、')
    )
  }

  // 场景 / 角色 / 道具 的名字
  const sceneIds = [...new Set(sbs.map(sb => sb.sceneId).filter(Boolean) as number[])]
  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).where(inArray(schema.scenes.id, sceneIds)).all()
    : []
  const sceneName = new Map<number, string>(scenes.map(s => [s.id, s.location || '']))

  // ★ 角色/道具 都在【关联表】里 (storyboards 表上没有这两个列):
  //   角色 = storyboardCharacters, 道具 = storyboardProps
  //   ★ 踩过一次坑: 一开始去读 sb.character_ids (那列根本不存在) → manifest 里 characters[] 全是空的
  const sbIds = sbs.map(sb => sb.id)
  const charLinks = db.select().from(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, sbIds)).all()
  const charIdsBySb = new Map<number, number[]>()
  for (const l of charLinks) {
    const arr = charIdsBySb.get(l.storyboardId) || []
    arr.push(l.characterId)
    charIdsBySb.set(l.storyboardId, arr)
  }
  const allCharIds = [...new Set([...charIdsBySb.values()].flat())]
  const chars = allCharIds.length
    ? db.select().from(schema.characters).where(inArray(schema.characters.id, allCharIds)).all()
    : []
  const charName = new Map<number, string>(chars.map(c => [c.id, c.name]))

  const propLinks = db.select().from(schema.storyboardProps)
    .where(inArray(schema.storyboardProps.storyboardId, sbIds)).all()
  const propIdsBySb = new Map<number, number[]>()
  for (const l of propLinks) {
    const arr = propIdsBySb.get(l.storyboardId) || []
    arr.push(l.propId)
    propIdsBySb.set(l.storyboardId, arr)
  }
  const allPropIds = [...new Set([...propIdsBySb.values()].flat())]
  const props = allPropIds.length
    ? db.select().from(schema.props).where(inArray(schema.props.id, allPropIds)).all()
    : []
  const propName = new Map<number, string>(props.map(p => [p.id, p.name]))

  const whitelist = getEpisodeSpeakerWhitelist(episodeId)

  const entries: ZipEntry[] = []
  const clips: MergePackClip[] = []
  let start = 0
  for (let i = 0; i < sbs.length; i++) {
    const sb = sbs[i]
    const base = `sb-${pad2(i + 1)}`
    const videoAbs = toAbsPath(sb.composedVideoUrl as string)
    if (!fs.existsSync(videoAbs)) {
      throw new Error(`镜#${sb.storyboardNumber} 的合成视频不在了 (${sb.composedVideoUrl}), 不能导出素材包`)
    }
    const probe = await probeMedia(videoAbs)
    const duration = Number((probe.durationSec || 0).toFixed(3))
    const fileName = `${base}.mp4`
    entries.push({ name: `clips/${fileName}`, filePath: videoAbs })

    // SRT: 有才放 (没造空文件); manifest 里对应字段写 null
    let subtitleFile: string | null = null
    if (sb.subtitleUrl) {
      const srtAbs = toAbsPath(sb.subtitleUrl)
      if (fs.existsSync(srtAbs)) {
        subtitleFile = `subtitles/${base}.srt`
        entries.push({ name: subtitleFile, filePath: srtAbs })
      }
    }

    const parsed = parseDialogueSegments(sb.dialogue, whitelist)
    clips.push({
      index: i + 1,
      storyboard_id: sb.id,
      file: `clips/${fileName}`,
      subtitle_file: subtitleFile,
      duration_sec: duration,
      start_in_pack_sec: Number(start.toFixed(3)),
      scene: { id: sb.sceneId ?? null, name: sb.sceneId ? (sceneName.get(sb.sceneId) || null) : null },
      characters: (charIdsBySb.get(sb.id) || []).map(id => ({ id, name: charName.get(id) || '' })),
      // ★ 台词原文: 不改写 / 不翻译 / 不合并说话人
      dialogue: parsed.segments.map(sg => ({ speaker: sg.speaker, text: sg.text })),
      props: (propIdsBySb.get(sb.id) || []).map(id => ({ id, name: propName.get(id) || '' })),
      video_prompt: sb.videoPrompt || null,
      note: sb.description || sb.title || null,
    })
    start += duration
  }

  let bgmEntry: string | null = null
  // BGM: 配了就复制一份进包里 (还没配 → 没有 bgm/ 目录)
  const bgmFile = (readMergeSettings(episodeId) as any).bgm?.file
  if (bgmFile) {
    const bgmAbs = path.isAbsolute(bgmFile)
      ? bgmFile
      : path.join(DATA_ROOT, 'media', 'bgm', path.basename(bgmFile))
    if (fs.existsSync(bgmAbs)) {
      bgmEntry = `bgm/${path.basename(bgmAbs)}`
      entries.push({ name: bgmEntry, filePath: bgmAbs })
    }
  }

  const manifest: MergePackManifest = {
    generated_at: now(),
    drama: { id: ep.dramaId, title: drama?.title || null, style: drama?.style || null },
    episode: { id: ep.id, number: ep.episodeNumber ?? null, title: ep.title || null },
    total_duration_sec: Number(start.toFixed(3)),
    clip_count: clips.length,
    bgm: bgmEntry,
    clips,
  }
  entries.push({ name: 'manifest.json', filePath: writeTempFile('manifest.json', JSON.stringify(manifest, null, 2)) })

  cleanupOldExportPacks()
  const zipName = `episode-${episodeId}-export-pack.zip`
  const zipPath = path.join(PACK_DIR, zipName)
  createZipFile(entries, zipPath)
  return { zipPath, zipName, clipCount: clips.length, totalDurationSec: Number(start.toFixed(3)) }
}

function writeTempFile(name: string, content: string): string {
  fs.mkdirSync(PACK_DIR, { recursive: true })
  const p = path.join(PACK_DIR, `.tmp-${name}`)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

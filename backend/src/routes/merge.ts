import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import fs from 'fs'
import { Readable } from 'stream'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import {
  mergeEpisodeVideos, validateTransitionConfig, validateGradeConfig,
  readMergeSettings, writeMergeSettings,
} from '../services/ffmpeg-merge.js'
// ★ Sprint 40 T2: BGM 校验 (纯逻辑模块)
import { validateBgmConfig } from '../services/merge-bgm.js'
// ★ Sprint 40 T1 (PM msg-20261112-171): 导出素材包 (manifest.json + clips/ + subtitles/ + bgm/)
import { buildMergeExportPack } from '../services/merge-export-pack.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const app = new Hono()

/**
 * ★ Sprint 38 追加单 166: 取【最新一条】merge (按 id 倒序) ——
 *   重新拼接会新增一条记录 → 页面要显示的是【新的那一条】(成片 url + 下载链接都换新的)。
 */
export function pickLatestMerge<T extends { id: number }>(merges: T[]): T | undefined {
  return (merges || []).slice().sort((a, b) => b.id - a.id)[0]
}

/**
 * ★ Sprint 38 T2-C (PM msg-20261110-165): 本集有没有【处理中】的 merge 可以复用?
 *   (纯函数 → 可离线断言; 处理中 = processing / pending)
 */
export function pickReusableMerge(
  merges: Array<{ id: number; status?: string | null }>,
): { id: number; status?: string | null } | null {
  const running = (merges || []).filter(m => m.status === 'processing' || m.status === 'pending')
  return running.length ? running[running.length - 1] : null
}

// POST /episodes/:id/merge — 拼接全集视频
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }

  // ★ Sprint 39 T2 (PM msg-20261111-169): 逐镜缝转场配置校验 ——
  //   非法类型 / 非法时长【在这里就被挡住】(可读提示), 不建 merge 记录 → 不产生 failed 脏数据/半成品成片
  const t = validateTransitionConfig(body?.transitions)
  if (!t.ok) {
    logTaskWarn('MergeAPI', 'episode-merge-invalid-transitions', {
      episodeId, dramaId: ep.dramaId, errors: t.errors,
      hint: '转场配置不合法 → 已拒绝, 没有新建 merge 记录',
    })
    return badRequest(c, `转场配置不合法: ${t.errors.join('; ')}`)
  }

  // ★ Sprint 39 T3 (PM msg-20261111-169): 全片调色参数 —— 校验 + 持久化 (下次再拼同一集仍然生效)
  const currentSettings = readMergeSettings(episodeId)
  let grade = currentSettings.grade
  // ★ Sprint 39 T4: 字幕烧录时机 (compose = 合成阶段烧 (默认) / merge = 拼接阶段烧)
  let subtitleStage = currentSettings.subtitleStage
  if (body?.subtitleStage != null) {
    const st = String(body.subtitleStage)
    if (st !== 'compose' && st !== 'merge') {
      logTaskWarn('MergeAPI', 'episode-merge-invalid-subtitle-stage', {
        episodeId, dramaId: ep.dramaId, subtitleStage: st,
        hint: '字幕烧录时机不合法 → 已拒绝, 没有新建 merge 记录',
      })
      return badRequest(c, `字幕烧录时机不合法: ${st} (可选: compose / merge)`)
    }
    subtitleStage = st as 'compose' | 'merge'
    writeMergeSettings(episodeId, { subtitleStage })
  }
  // ★ Sprint 40 T2 (PM msg-20261112-171): BGM 铺底 + 对白 ducking —— 校验 + 持久化
  //   (不传 bgm → 沿用已保存的; 传了但非法 → 400 且不建 merge 记录)
  let bgm = currentSettings.bgm
  if (body?.bgm != null) {
    const b = validateBgmConfig(body.bgm)
    if (!b.ok) {
      logTaskWarn('MergeAPI', 'episode-merge-invalid-bgm', {
        episodeId, dramaId: ep.dramaId, errors: b.errors,
        hint: 'BGM 配置不合法 → 已拒绝, 没有新建 merge 记录',
      })
      return badRequest(c, `BGM 配置不合法: ${b.errors.join('; ')}`)
    }
    bgm = b.config
    writeMergeSettings(episodeId, { bgm })
  }
  if (body?.grade != null) {
    const g = validateGradeConfig(body.grade)
    if (!g.ok) {
      logTaskWarn('MergeAPI', 'episode-merge-invalid-grade', {
        episodeId, dramaId: ep.dramaId, errors: g.errors,
        hint: '调色配置不合法 → 已拒绝, 没有新建 merge 记录',
      })
      return badRequest(c, `调色配置不合法: ${g.errors.join('; ')}`)
    }
    grade = g.config
    writeMergeSettings(episodeId, { grade })
  }

  // ★ Sprint 38 T2-C (PM msg-20261110-165): 本集已有【处理中】的 merge → 直接复用那一条 ——
  //   不新建记录、不再起第二个 ffmpeg (两个 ffmpeg 抢 CPU; 而且用户以为没点上会再点一次)。
  //   以前这个接口无去重 → 连点两次就是两条记录 + 两个 ffmpeg 抢资源。
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId)).all()
  const running = pickReusableMerge(merges)
  if (running) {
    const row = running
    logTaskProgress('MergeAPI', 'episode-merge-reuse', {
      episodeId,
      dramaId: ep.dramaId,
      mergeId: row.id,
      status: row.status,
      hint: '本集已有处理中的拼接 → 复用这一条, 不新建记录也不再起 ffmpeg',
    })
    return success(c, { merge_id: row.id, status: row.status, reused: true })
  }

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId })
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId, { transitions: t.config, grade, subtitleStage, bgm })
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /episodes/:id/merge/export-pack — 导出【素材包】(ZIP)
//   ★ Sprint 40 T1: 给人工精修 (OpenChatCut 之类) 用的输入包。
//     manifest.json 是核心 (通用剪辑器不知道哪一镜是谁在说哪句台词);
//     clips/ 是 compose 产出的 mp4 【直接复制】, 不重编码 (可被 md5 验证)。
//   ★ 本集还有镜没合成完 → 400 + 列出缺哪几镜 (不导半成品包)。
app.get('/episodes/:id/merge/export-pack', async (c) => {
  const episodeId = Number(c.req.param('id'))
  try {
    const pack = await buildMergeExportPack(episodeId)
    logTaskSuccess('MergeAPI', 'episode-export-pack', {
      episodeId,
      zip: pack.zipName,
      clipCount: pack.clipCount,
      totalDurationSec: pack.totalDurationSec,
    })
    const stat = fs.statSync(pack.zipPath)
    const stream = Readable.toWeb(fs.createReadStream(pack.zipPath)) as unknown as ReadableStream
    return c.body(stream, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${pack.zipName}"`,
      'Content-Length': String(stat.size),
    })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-export-pack', { episodeId, error: err?.message || String(err) })
    return badRequest(c, err?.message || '导出素材包失败')
  }
})

// GET /episodes/:id/merge/settings — 读本集的拼接设置 (★ Sprint 39 T3: 调色参数等, 持久化)
//   前端进页面时拉一次 → 用户改完的调色参数下次再拼同一集仍然生效
app.get('/episodes/:id/merge/settings', async (c) => {
  const episodeId = Number(c.req.param('id'))
  return success(c, readMergeSettings(episodeId))
})

// POST /episodes/:id/merge/settings — 【只保存设置, 不启动拼接】
//   ★ Sprint 40 T2: BGM 选择 + 音量 + duck 参数改完就存 → 刷新页面 / 下次拼接仍然生效
//   (拼接本身会带上 bgm 参数; 这个接口让用户不点拼接也能把设置留住)
app.post('/episodes/:id/merge/settings', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }

  if (body?.bgm != null) {
    const b = validateBgmConfig(body.bgm)
    if (!b.ok) {
      logTaskWarn('MergeAPI', 'merge-settings-invalid-bgm', {
        episodeId, dramaId: ep.dramaId, errors: b.errors,
        hint: 'BGM 配置不合法 → 没有保存',
      })
      return badRequest(c, `BGM 配置不合法: ${b.errors.join('; ')}`)
    }
    writeMergeSettings(episodeId, { bgm: b.config })
  }

  return success(c, readMergeSettings(episodeId))
})

// GET /episodes/:id/merge — 查询拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()

  const latest = pickLatestMerge(merges)
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

export default app

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { mergeEpisodeVideos, validateTransitionConfig } from '../services/ffmpeg-merge.js'
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
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId, { transitions: t.config })
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
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

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

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
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId)
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

  const latest = merges[merges.length - 1]
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

export default app

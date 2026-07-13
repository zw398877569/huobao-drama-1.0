/**
 * Agnes 调试路由 — 用真实配置 key 直接 curl agnes 三种端点
 * 用于诊断 video poll 链路(日志(15)(16) 问题)
 *
 * 访问: GET /api/v1/_debug/agnes-poll?taskId=task_xxx&videoId=video_xxx
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

const app = new Hono()

// 用真实 agnes video 配置打三种端点
app.get('/agnes-poll', async (c) => {
  const taskId = c.req.query('taskId')
  const videoId = c.req.query('videoId')
  if (!taskId) return badRequest(c, 'taskId required')

  // 读真实 apiKey
  const [cfg] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'video'))
    .all().filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  if (!cfg) return badRequest(c, 'No active video config')
  if (cfg.provider !== 'agnes') return badRequest(c, `Provider is ${cfg.provider}, not agnes`)

  const baseUrl = cfg.baseUrl
  const apiKey = cfg.apiKey

  const results: any = {
    baseUrl,
    taskId,
    videoId,
    attempts: [],
  }

  // 端点 1: /v1/videos/<task_id>
  try {
    const url = joinProviderUrl(baseUrl, '/v1', `/videos/${taskId}`)
    const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } })
    const text = await r.text()
    results.attempts.push({
      endpoint: 'GET /v1/videos/<task_id>',
      url: url.replace(apiKey, '***'),
      status: r.status,
      contentType: r.headers.get('content-type'),
      body: text.slice(0, 1500),
    })
  } catch (e: any) {
    results.attempts.push({ endpoint: 'GET /v1/videos/<task_id>', error: e.message })
  }

  // 端点 2: /agnesapi?video_id=<video_id> 或 <task_id>
  if (videoId || taskId) {
    try {
      const id = videoId || taskId
      const url = `${baseUrl.replace(/\/+$/, '')}/agnesapi?video_id=${id}`
      const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } })
      const text = await r.text()
      results.attempts.push({
        endpoint: 'GET /agnesapi?video_id=...',
        url: url.replace(apiKey, '***'),
        status: r.status,
        contentType: r.headers.get('content-type'),
        body: text.slice(0, 1500),
      })
    } catch (e: any) {
      results.attempts.push({ endpoint: 'GET /agnesapi?video_id=...', error: e.message })
    }
  }

  // 端点 3: /v1/videos/<task_id> 带 model_name 参数(文档推荐方式 2)
  try {
    const url = `${joinProviderUrl(baseUrl, '/v1', `/videos/${taskId}`)}?model_name=agnes-video-v2.0`
    const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } })
    const text = await r.text()
    results.attempts.push({
      endpoint: 'GET /v1/videos/<task_id>?model_name=...',
      url: url.replace(apiKey, '***'),
      status: r.status,
      contentType: r.headers.get('content-type'),
      body: text.slice(0, 1500),
    })
  } catch (e: any) {
    results.attempts.push({ endpoint: 'GET /v1/videos/<task_id>?model_name=...', error: e.message })
  }

  return success(c, results)
})

export default app

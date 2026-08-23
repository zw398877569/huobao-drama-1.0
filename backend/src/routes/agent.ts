/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { createAgent, validAgentTypes } from '../agents/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
// POST /agent/storyboard_breaker/storyboard/:id — 重新生成本镜头(单镜头增量,不覆盖其他镜头)
app.post('/storyboard_breaker/storyboard/:id', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  if (!storyboardId) {
    return badRequest(c, 'storyboard id is required')
  }
  const body = await c.req.json()
  const { drama_id, episode_id } = body
  if (!episode_id || !drama_id) {
    logTaskError('Agent', 'storyboard_breaker-incremental', { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  logTaskStart('Agent', 'storyboard_breaker-incremental', {
    dramaId: drama_id,
    episodeId: episode_id,
    storyboardId,
  })

  // incremental 模式:createAgent 只暴露 readStoryboardContext + updateStoryboard,防止 agent 误调 saveStoryboards 全量覆盖
  const agent = createAgent('storyboard_breaker', episode_id, drama_id, { toolsMode: 'incremental' })
  if (!agent) {
    return badRequest(c, 'Agent not found')
  }

  const message = `请重新生成本镜头(id=${storyboardId})的所有 17 字段(标题、景别、机位、运镜、地点、时间、动作、结果、氛围、image_prompt、video_prompt、bgm_prompt、sound_effect、description、dialogue、duration、character_ids)。

注意:
- 这是单镜头增量更新,只能调 update_storyboard 修改 storyboard_id=${storyboardId},不要触碰其他任何镜头
- 不要凭空创造新的 scene_id,只能从 read_storyboard_context 返回的 scenes 中选
- character_ids 只能从 read_storyboard_context 返回的角色中选
- video_prompt 必须把 dialogue 字段所有对白按时间顺序嵌入对应时间段
- 17 字段同全量模式的 4 轴 + 6 维 + 首帧延续约束`

  const startTime = performance.now()
  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: 20 },
    )
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', 'storyboard_breaker-incremental', { elapsedSeconds: elapsed, storyboardId })

    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))
    logTaskProgress('Agent', 'tool-summary', {
      agentType: 'storyboard_breaker-incremental',
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', 'storyboard_breaker-incremental tool-results', normalizedToolResults)
    return success(c, {
      type: 'done',
      text: result.text || '',
      storyboardId,
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', 'storyboard_breaker-incremental', { storyboardId, elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent execution failed')
  }
})

app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  const agent = createAgent(agentType, episode_id, drama_id)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent not found')
  }

  const startTime = performance.now()

  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: 20 },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent execution failed')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  return success(c, { agent_type: agentType, valid: true })
})

export default app

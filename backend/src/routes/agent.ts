/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, validAgentTypes } from '../agents/index.js'
import { parseConfigIdWithModel } from '../services/ai.js'
import { runGenerateShotPrompts } from '../agents/tools/storyboard-tools.js'
import { runStep1, runStep2, runStep3, runAllStepsLegacy } from '../services/storyboard-planner-service.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

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

  // 2026-09-28 QA msg-20260925-003 ISSUE-011 (P1): message 缺失时 agent.generate 抛 'role user must have content property'
  // 提前校验, 返 400 + 清晰错误, 不让 AI SDK 模糊错冒上来
  if (!message || (typeof message === 'string' && !message.trim())) {
    logTaskError('Agent', agentType, { reason: 'missing message', dramaId: drama_id, episodeId: episode_id })
    return badRequest(c, 'message is required (string with non-empty content)')
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

// ─── 两阶段分镜拆解 ────────────────────────────────────────────────────────────

// POST /agent/storyboard_breaker/planning — V4 架构: 老 endpoint 保留 (向后兼容)
// 内部 redirect 到 runAllStepsLegacy (auto mode, 跳过 user review). 老 UI 老按钮 'AI 拆解分镜' 用户无感.
// SSE 协议兼容老前端 (event: status / progress / done / error 跟旧版相同).
app.post('/storyboard_breaker/planning', async (c) => {
  const body = await c.req.json()
  const { drama_id, episode_id } = body
  if (!episode_id || !drama_id) {
    return badRequest(c, 'drama_id and episode_id are required')
  }

  // Sprint 6 PM msg-20260930-001 Task B — text_config_id 可选 (用户测 DeepSeek 分镜)
  // 复合格式 "configId:modelName" 或纯数字 configId; null 时走 getActiveConfig('text') fallback
  const parsed = parseConfigIdWithModel(body.text_config_id)
  const opts: { textConfigId?: number; modelOverride?: string } = {}
  if (parsed.configId) opts.textConfigId = parsed.configId
  if (parsed.model) opts.modelOverride = parsed.model

  logTaskStart('Agent', 'storyboard_breaker-planning-v4', {
    dramaId: drama_id, episodeId: episode_id,
    textConfigId: opts.textConfigId ?? null,
    modelOverride: opts.modelOverride ?? null,
    note: 'V4 老 endpoint redirect to 3-step service (auto mode)',
  })

  return streamSSE(c, async (stream) => {
    const startTime = performance.now()
    try {
      // V4 架构: 老 endpoint 内部调 runAllStepsLegacy 连续跑 3 步 (跳过 user review)
      //   SSE event 跟旧版兼容 (status / done), 老前端解析逻辑不变.
      const result = await runAllStepsLegacy({
        dramaId: drama_id, episodeId: episode_id,
        textConfigId: opts.textConfigId, modelOverride: opts.modelOverride,
        onProgress: async (p) => {
          // 把 p 字段放在前面, 显式 phase/status/tip 后覆盖 (避免 TS2783 'phase specified more than once')
          await stream.writeSSE({
            event: 'status',
            data: JSON.stringify({ ...p, phase: p.phase, status: p.status, tip: p.tip ?? '' }),
          }).catch(() => { /* SSE 已关闭, 静默 */ })
        },
      })
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
      const totalDuration = result.shot_details.reduce((s, d) => s + (d.duration || 10), 0)
      logTaskSuccess('Agent', 'storyboard_breaker-planning-v4', { elapsedSeconds: elapsed })

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          phase: 'planning',
          status: 'done',
          shotCount: result.shot_plan.length,
          totalDuration,
          densityWarnings: 0,
          safetyWarnings: 0,
          elapsed,
          createdStoryboardIds: result.createdStoryboardIds,
        }),
      })
    } catch (err: any) {
      // 2026-09-28 QA msg-20260925-007 ISSUE-015 (P2): M3 安全过滤触发 (input new_sensitive (len) 风格)
      //   不是 dev bug, 是 M3 对输入触发 content filter. 给清晰 hint + SSE event, 避免误以为是 dev bug
      const errMsg = err?.message || String(err)
      const isSafetyFilter = /new_sensitive|input.*sensitive|content_policy|safety_filter|policy_violation|敏感/i.test(errMsg)
      if (isSafetyFilter) {
        logTaskWarn('Agent', 'm3-safety-filter-rejection', {
          error: errMsg,
          hint: 'M3 对当前输入触发安全过滤. 检查: 1) 上游脚本是否含敏感词 (鲜血/武器/死亡/燃烧) 2) agent 系统 prompt 是否有敏感示例 3) 考虑改用 deepseek-chat (sanitizer 专用配置)'
        })
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'm3-safety-filter',
            message: errMsg,
            hint: 'M3 安全过滤. 检查输入或换模型 (见 flow log warn)'
          }),
        })
      } else {
        logTaskError('Agent', 'storyboard_breaker-planning-v4', { error: errMsg })
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: errMsg }),
        })
      }
    } finally {
      await stream.close()
    }
  })
})

// POST /agent/storyboard_breaker/planning/step1 — V4 wizard interactive mode
// 跑 step1 LLM plan, 存 episodes.planning_data.step1, 返回 shot_plan JSON
// body: { drama_id, episode_id, text_config_id? }
app.post('/storyboard_breaker/planning/step1', async (c) => {
  const body = await c.req.json()
  const { drama_id, episode_id } = body
  if (!episode_id || !drama_id) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const parsed = parseConfigIdWithModel(body.text_config_id)
  const opts: { textConfigId?: number; modelOverride?: string } = {}
  if (parsed.configId) opts.textConfigId = parsed.configId
  if (parsed.model) opts.modelOverride = parsed.model

  try {
    const result = await runStep1({
      dramaId: drama_id, episodeId: episode_id, ...opts,
    })
    return success(c, {
      shot_plan: result.shot_plan,
      total_duration: result.total_duration,
      scene_distribution: result.scene_distribution,
    })
  } catch (err: any) {
    logTaskError('Agent', 'storyboard_breaker-planning-step1', { error: err?.message || String(err) })
    return badRequest(c, err?.message || 'step1 failed')
  }
})

// POST /agent/storyboard_breaker/planning/step2 — V4 wizard interactive mode (Q4 B 拍板)
// 跑 step2 LLM details, 存 episodes.planning_data.step2, 返回 shot_details JSON
// body: { drama_id, episode_id, text_config_id?, shot_plan? }  (shot_plan 可选, 传则覆盖 planning_data.step1)
app.post('/storyboard_breaker/planning/step2', async (c) => {
  const body = await c.req.json()
  const { drama_id, episode_id, shot_plan } = body
  if (!episode_id || !drama_id) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const parsed = parseConfigIdWithModel(body.text_config_id)
  const opts: { textConfigId?: number; modelOverride?: string; shotPlanOverride?: any[] } = {}
  if (parsed.configId) opts.textConfigId = parsed.configId
  if (parsed.model) opts.modelOverride = parsed.model
  if (Array.isArray(shot_plan)) opts.shotPlanOverride = shot_plan

  try {
    const result = await runStep2({
      dramaId: drama_id, episodeId: episode_id, ...opts,
    })
    return success(c, { shot_details: result.shot_details })
  } catch (err: any) {
    logTaskError('Agent', 'storyboard_breaker-planning-step2', { error: err?.message || String(err) })
    return badRequest(c, err?.message || 'step2 failed')
  }
})

// POST /agent/storyboard_breaker/planning/step3 — V4 wizard interactive mode (Q5 A 拍板)
// step3 persist zod + DB 事务 (Task B 加), 写 episodes.planning_data.step3_storyboard_ids
// body: { drama_id, episode_id, shot_details? }  (shot_details 可选, 传则覆盖 planning_data.step2)
app.post('/storyboard_breaker/planning/step3', async (c) => {
  const body = await c.req.json()
  const { drama_id, episode_id, shot_details } = body
  if (!episode_id || !drama_id) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const opts: { shotDetailsOverride?: any[] } = {}
  if (Array.isArray(shot_details)) opts.shotDetailsOverride = shot_details

  try {
    const result = await runStep3({
      dramaId: drama_id, episodeId: episode_id, ...opts,
    })
    return success(c, { createdStoryboardIds: result.createdStoryboardIds })
  } catch (err: any) {
    logTaskError('Agent', 'storyboard_breaker-planning-step3', { error: err?.message || String(err) })
    return badRequest(c, err?.message || 'step3 failed')
  }
})


// POST /agent/storyboard_breaker/execute — 阶段 2: 直接写入（不经过 LLM）
// shot_plan 由前端/用户提供，直接调代码侧函数生成 17 字段并保存
app.post('/storyboard_breaker/execute', async (c) => {
  const body = await c.req.json()
  const { drama_id, episode_id, shot_plan, replace } = body
  if (!episode_id || !drama_id || !shot_plan) {
    return badRequest(c, 'drama_id, episode_id, and shot_plan are required')
  }

  logTaskStart('Agent', 'storyboard_breaker-execute', { dramaId: drama_id, episodeId: episode_id, shotCount: shot_plan.length })

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ phase: 'execute', status: 'running' }) })

      const startTime = performance.now()
      const result = await runGenerateShotPrompts({
        episodeId: episode_id,
        dramaId: drama_id,
        shot_plan,
        keepExisting: replace === false,
        onProgress: ({ shot, total }) => {
          void stream.writeSSE({ event: 'progress', data: JSON.stringify({ shot, total, tip: `正在生成镜头 #${shot}/${total}` }) })
        },
      })
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)

      logTaskSuccess('Agent', 'storyboard_breaker-execute', { elapsedSeconds: elapsed, ...result })
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ phase: 'execute', status: 'done', ...result, elapsed }),
      })
    } catch (err: any) {
      logTaskError('Agent', 'storyboard_breaker-execute', { error: err.message })
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: err.message }) })
    } finally {
      await stream.close()
    }
  })
})

export default app

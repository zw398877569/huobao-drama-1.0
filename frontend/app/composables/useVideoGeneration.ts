import { toast } from 'vue-sonner'
import { videoAPI, composeAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

// 2026-10-19 Sprint 13 Task B (PM msg-20261019-073): 批量视频提交间隔 5s。
//   修前: pendingIds.forEach 一次性提交所有待生成镜头, 无间隔 —— 跟后端定时计划
//         (batch-video-scheduler.ts triggerPlanImpl) 同样的风险。
//   修后: 串行 + 间隔, 与后端 SUBMIT_INTERVAL_MS 语义对齐。
//         后端可用 env VIDEO_SUBMIT_INTERVAL_MS 覆盖; 前端固定 5000ms (不必读 env)。
//   为什么需要 (PM 实测): episode 15 plan 15 (11 镜) 实跑, plan 记 11/11 成功,
//         实际 video_generations completed=10 / failed=1 / processing=1,
//         失败那条是 `AutoDL ComfyUI: no task_id in response`, 重试 3 次全失败。
//         5 个任务 created_at 跨度仅 690ms —— 几乎同时打向 ComfyUI。
//   注意: 生成阶段仍并发 (genVid 内部是 fire-and-forget, 等的是「提交成功」不是「生成完成」),
//         间隔只兜底提交节奏。代价是 11 镜多花 50s 提交时间, 总耗时几乎不变。
const BATCH_SUBMIT_INTERVAL_MS = 5000

type Deps = {
  ctx: {
    sbs: Ref<any[]>
    epId: ComputedRef<number>
    dramaId: number
  },
  refresh: () => Promise<void>,
  getFirstFrame: (s: any) => string | null,
  getLastFrame: (s: any) => string | null,
  getRefs: (s: any) => string[],
  hasVid: (s: any) => boolean,
  watchAsyncResult: (check: () => boolean, attempts?: number, delay?: number) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
}

export function useVideoGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, hasVid, watchAsyncResult, sleep } = deps

  const pendingVideoIds = ref<number[]>([])
  const pendingComposeIds = ref<number[]>([])
  const failedVideoMessages = ref<Record<number, string>>({})
  const failedComposeMessages = ref<Record<number, string>>({})

  // Sprint 14 (PM msg-20261019-074): 降级提示, key = storyboardId, value = 展示文案。
  //   后端 video_generations.fallback_reason 落库, 这里只做「原因码 -> 中文」映射。
  //   注意 no_audio_fallback 故意不展示 —— 那是「本镜没配音所以不做口型同步」的正常兜底,
  //   刷一屏 tag 只会让用户以为出错了 (用户 2026-10-19 拍板)。
  const videoFallbackNotes = ref<Record<number, string>>({})

  const FALLBACK_NOTE_TEXT: Record<string, string> = {
    mode_mismatch_ref2v: '模式不匹配·已转多图参考',
    mode_mismatch_no_images: '无参考图·已转文生视频',
  }

  function videoFallbackNote(id: number) {
    return videoFallbackNotes.value[id]
  }

  function applyFallbackReason(storyboardId: number, reason?: string | null) {
    const next = { ...videoFallbackNotes.value }
    const text = reason ? FALLBACK_NOTE_TEXT[reason] : undefined
    if (text) next[storyboardId] = text
    else delete next[storyboardId]
    videoFallbackNotes.value = next
  }

  /** 刷新页面后降级 tag 还在: 拉本剧集视频记录, 每个镜头只留最新一条的降级原因 */
  async function loadVideoFallbackNotes() {
    try {
      const rows = await videoAPI.list({ drama_id: ctx.dramaId })
      const list = Array.isArray(rows) ? rows : (rows?.data || [])
      const latest: Record<number, { id: number; reason: string | null }> = {}
      for (const r of list) {
        const sbId = Number(r?.storyboardId ?? r?.storyboard_id)
        if (!sbId) continue
        if (!latest[sbId] || Number(r?.id) > latest[sbId].id) {
          latest[sbId] = { id: Number(r?.id), reason: r?.fallbackReason ?? r?.fallback_reason ?? null }
        }
      }
      const next: Record<number, string> = {}
      for (const [sbId, info] of Object.entries(latest)) {
        const text = info.reason ? FALLBACK_NOTE_TEXT[info.reason] : undefined
        if (text) next[Number(sbId)] = text
      }
      videoFallbackNotes.value = next
    } catch {
      // 拉不到就保持现状, 不打断页面 (降级 tag 是辅助信息, 不是主流程)
    }
  }

  function isPendingVideo(id: number) {
    return pendingVideoIds.value.includes(id)
  }
  function videoFailMessage(id: number) {
    return failedVideoMessages.value[id]
  }
  function isPendingCompose(id: number) {
    return pendingComposeIds.value.includes(id)
  }
  function composeFailMessage(id: number) {
    return failedComposeMessages.value[id]
  }

  async function genVid(sb: any, configId?: number | string | null) {
    let prompt = sb.video_prompt || sb.videoPrompt || ''
    // 有首帧时自动附加首帧一致性约束（Pavo AI 的镜头运动要求）
    const first = getFirstFrame(sb)
    const last = getLastFrame(sb)
    const refs = getRefs(sb)
    if (first && prompt) {
      prompt += '；保持首帧画面构图一致，镜头运动从首帧状态开始'
    }
    const params: Record<string, any> = {
      storyboard_id: sb.id,
      drama_id: ctx.dramaId,
      prompt,
      duration: Number(sb.duration || 5),
    }
    // config_id 走复合格式 '<id>:<model>': 后端 parseConfigIdWithModel 拆开
    if (configId != null) params.config_id = configId
    if (first && last) { Object.assign(params, { reference_mode: 'first_last', first_frame_url: first, last_frame_url: last }) }
    else if (refs.length) { Object.assign(params, { reference_mode: 'multiple', reference_image_urls: [first, ...refs].filter(Boolean) }) }
    else if (first) { Object.assign(params, { reference_mode: 'single', image_url: first }) }
    try {
      delete failedVideoMessages.value[sb.id]
      applyFallbackReason(sb.id, null)  // Sprint 14: 重新生成前先清掉上一轮的降级 tag
      if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
      const generation = await videoAPI.generate(params)
      toast.success('视频生成中')
      await refresh()
      pollVideoGeneration(generation?.id, sb.id)
    } catch (e: any) {
      pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
      toast.error(e.message)
    }
  }

  async function pollVideoGeneration(generationId: string | number | undefined, storyboardId: number) {
    if (!generationId) {
      await watchAsyncResult(() => {
        const target = ctx.sbs.value.find(s => s.id === storyboardId)
        // 成功: 有视频; 失败: status=failed — 两种终态都退出轮询
        const isFailed = target?.status === 'failed'
        const done = !!(target?.video_url || target?.videoUrl) || isFailed
        if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        if (isFailed) toast.error(target?.error_msg || target?.errorMsg || '视频生成失败')
        return done
      }, 60, 4000)
      return
    }
    for (let i = 0; i < 120; i++) {
      await sleep(4000)
      try {
        const res = await videoAPI.get(generationId)
        await refresh()
        // Sprint 14: adapter 换过 workflow 时把原因码转成 tag (no_audio_fallback 会被映射表过滤掉)
        applyFallbackReason(storyboardId, res?.fallbackReason ?? res?.fallback_reason)
        if (res?.status === 'completed') {
          pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
          delete failedVideoMessages.value[storyboardId]
          toast.success('视频生成完成')
          return
        }
        if (res?.status === 'failed') {
          pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
          failedVideoMessages.value = {
            ...failedVideoMessages.value,
            [storyboardId]: res?.error_msg || res?.errorMsg || '视频生成失败',
          }
          toast.error(failedVideoMessages.value[storyboardId])
          return
        }
      } catch {}
    }
    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
    failedVideoMessages.value = {
      ...failedVideoMessages.value,
      [storyboardId]: '视频生成超时',
    }
    toast.error('视频生成超时')
  }

  function batchVideos(configId?: number | string | null) {
    const pendingIds = ctx.sbs.value.filter(s => !hasVid(s)).map(s => s.id)
    if (!pendingIds.length) return

    // Sprint 13 Task B: 串行 + 间隔提交 (替代原 pendingIds.forEach 一次性全量提交)。
    //   间隔放在 for 循环里, 最后一镜之后不等 (跟后端 triggerPlanImpl 逻辑对称)。
    //   用 deps 注入的 sleep helper, 不自己造 setTimeout Promise。
    const submitAll = async () => {
      for (let i = 0; i < pendingIds.length; i++) {
        const id = pendingIds[i]
        const sb = ctx.sbs.value.find(item => item.id === id)
        if (sb) await genVid(sb, configId)
        if (i < pendingIds.length - 1) await sleep(BATCH_SUBMIT_INTERVAL_MS)
      }
    }

    // UI 反馈: 间隔期间用户可能以为卡住, 提前告知为什么要等 (工单明确要求)
    toast.info(`开始批量生成 ${pendingIds.length} 个视频, 每隔 ${BATCH_SUBMIT_INTERVAL_MS / 1000}s 提交一个`)

    pendingVideoIds.value = [...new Set([...pendingVideoIds.value, ...pendingIds])]
    void submitAll()
    // watchAsyncResult 只轮询完成状态, 与提交节奏无关, 不用改 (工单 do_not_touch)
    void watchAsyncResult(() => pendingIds.every(id => {
      const target = ctx.sbs.value.find(s => s.id === id)
      // 成功: 有视频; 失败: status=failed — 两种终态都算完成
      const isFailed = target?.status === 'failed'
      const done = !!(target?.video_url || target?.videoUrl) || isFailed
      if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== id)
      if (isFailed) toast.error(target?.error_msg || target?.errorMsg || '视频生成失败')
      return done
    }), 80, 4000)
  }

  async function doCompose(sb: any) {
    try {
      delete failedComposeMessages.value[sb.id]
      if (!isPendingCompose(sb.id)) pendingComposeIds.value.push(sb.id)
      await composeAPI.shot(sb.id)
      toast.success('合成完成')
      pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
      refresh()
    } catch (e: any) {
      pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
      failedComposeMessages.value = {
        ...failedComposeMessages.value,
        [sb.id]: e.message,
      }
      toast.error(e.message)
    }
  }

  async function batchCompose() {
    await composeAPI.all(ctx.epId.value)
    pendingComposeIds.value = [...new Set(ctx.sbs.value.filter(sb => !!sb.video_url || !!sb.videoUrl).map(sb => sb.id))]
    toast.success('批量合成已开始')
    pollComposeStatus()
  }

  async function pollComposeStatus() {
    for (let i = 0; i < 120; i++) {
      await sleep(3000)
      try {
        const res = await composeAPI.status(ctx.epId.value)
        await refresh()
        const items = Array.isArray(res?.items) ? res.items : []
        const processingIds = items.filter((item: any) => item.status === 'compose_processing').map((item: any) => item.id)
        pendingComposeIds.value = processingIds

        const failedItems = items.filter((item: any) => item.status === 'compose_failed')
        if (failedItems.length) {
          const next = { ...failedComposeMessages.value }
          failedItems.forEach((item: any) => {
            next[item.id] = item.error_msg || item.errorMsg || '视频合成失败'
          })
          failedComposeMessages.value = next
        }

        if (!processingIds.length) {
          if (failedItems.length) toast.error(`有 ${failedItems.length} 个镜头合成失败`)
          else toast.success('批量合成完成')
          return
        }
      } catch {}
    }
  }

  return {
    pendingVideoIds, pendingComposeIds, failedVideoMessages, failedComposeMessages,
    isPendingVideo, videoFailMessage, isPendingCompose, composeFailMessage,
    videoFallbackNotes, videoFallbackNote, loadVideoFallbackNotes,
    genVid, batchVideos, doCompose, batchCompose, pollVideoGeneration, pollComposeStatus,
  }
}

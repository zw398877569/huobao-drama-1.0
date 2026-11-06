import { toast } from 'vue-sonner'
// ★ Sprint 33 T5 (PM msg-20261103-140): 过渡镜 —— 尾帧复用后一镜的首帧
import { isTransitionShot } from '~/utils/transition'
import { videoAPI, composeAPI, imageAPI } from '~/composables/useApi'
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

// ★ Sprint 36 (PM msg-20261106-157): 过渡镜等【后一镜首帧】(本镜的尾帧) 的策略常量。
//   ① 后一镜首帧已就绪        → 直接用 (first_last), 不等
//   ② 后一镜首帧正在生成中    → 等它 (明确上限 5 分钟 + 进度提示)
//   ③ 后一镜首帧不在生成中    → 最多再等 30 秒 (只给 DB 传播留余量), 然后降级 + 明确告警
const TRANSITION_WAIT_INTERVAL_MS = 3000
const TRANSITION_WAIT_ATTEMPTS_PENDING = 100 // 100 × 3s = 5 分钟 (首帧生成实测要 1~3 分钟)
const TRANSITION_WAIT_ATTEMPTS_IDLE = 10     // 10 × 3s = 30 秒 (跨标签页竞态余量, 不长等)
// 进度 toast 的自增序号: 每次等待用唯一 id (见 resolveTransitionTail 里的说明)
let transitionWaitSeq = 0

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
  // ★ Sprint 36: 判断【后一镜的首帧是否正在生成】→ 决定等多久 (正在生成给足时间, 没生成不干等)
  isPendingShotFrame?: (id: number, frameType: string) => boolean,
}

export function useVideoGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, hasVid, watchAsyncResult, sleep, isPendingShotFrame } = deps

  const pendingVideoIds = ref<number[]>([])
  const pendingComposeIds = ref<number[]>([])
  const failedVideoMessages = ref<Record<number, string>>({})
  const failedComposeMessages = ref<Record<number, string>>({})

  // Sprint 14 (PM msg-20261019-074): 降级提示, key = storyboardId, value = 展示文案。
  //   后端 video_generations.fallback_reason 落库, 这里只做「原因码 -> 中文」映射。
  //   注意 no_audio_fallback 故意不展示 —— 那是「本镜没配音所以不做口型同步」的正常兜底,
  //   刷一屏 tag 只会让用户以为出错了 (用户 2026-10-19 拍板)。
  const videoFallbackNotes = ref<Record<number, string>>({})

  // ★ Sprint 36 (PM msg-20261106-157): 过渡镜【没桥接上】的常驻提示 (key = storyboardId)。
  //   toast 一闪就没了 → 用户回头看视频只会觉得"这刀剪得好生硬", 根本不知道缺了后一镜首帧。
  //   所以除了 toast, 还要在镜头卡片上常驻一行。
  const videoBridgeNotes = ref<Record<number, string>>({})
  function videoBridgeNote(id: number) { return videoBridgeNotes.value[id] }

  const FALLBACK_NOTE_TEXT: Record<string, string> = {
    // ★ Sprint 34 (PM msg-20261103-144): 用户选了一个【我们没接入】的模型 id → 自动路由到别的工作流。
    //   这跟『mode 不匹配』是两种问题, 提示要区分开 (前者是 id 写错/没接入, 后者是模式选错)。
    model_not_supported: '所选模型未接入（已自动改用其它工作流），请检查设置里的模型 id 是否正确',
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

  /**
   * 后一镜 (同 episode 内 storyboard_number = 当前 + 1) —— 过渡镜的尾帧来源。
   */
  function findNextShot(sb: any) {
    const num = Number(sb?.storyboard_number ?? sb?.storyboardNumber ?? 0)
    if (!num) return null
    return ctx.sbs.value.find((s: any) => {
      const n = Number(s?.storyboard_number ?? s?.storyboardNumber ?? 0)
      return n === num + 1
    }) || null
  }

  /**
   * ★ Sprint 36 (PM msg-20261106-157): 后端权威判断【后一镜的首帧是否还在生成】。
   *
   * 【为什么不能只看前端 pendingShotFrameKeys】那是页面内存态: 页面刷新 / 换标签页就丢
   *   → 会误判成"没人在生成" → 白等 30 秒就降级, 而后端其实还在出图。
   *   /api/v1/images?storyboard_id=N 里有 image_generations 记录 (status=processing) → 那是权威信号。
   */
  async function isTailFrameGenerating(nextId: number): Promise<boolean> {
    try {
      const rows = await imageAPI.list({ storyboard_id: nextId })
      const list = Array.isArray(rows) ? rows : []
      return list.some((r: any) => {
        const ft = r?.frameType ?? r?.frame_type
        const st = String(r?.status ?? '')
        return ft === 'first_frame' && ['processing', 'pending', 'queued', 'running'].includes(st)
      })
    } catch {
      return false   // 查不到就按"没在生成"处理 (短等 + 明确告警), 不阻断主流程
    }
  }

  /**
   * ★ Sprint 36 (PM msg-20261106-157): 解析过渡镜的【尾帧】= 【后一镜的首帧】。
   *
   * 【修的是什么】旧实现把 params (含 reference_mode) 在【等待之前】就组装好了:
   *   等到后一镜首帧落库后也没有回头重算 params → 提交的永远是 single (没有尾帧)
   *   → 视频模型自己脑补尾帧 → 接缝硬切, 而用户全程只看到一句"正在等待", 没有任何提示。
   *   实测 (2026-11-06): drama19/ep20 镜#9 → flow-79a8a2c7 video-ref-slots total=1;
   *   同集镜#2 (后一镜早就绪) → total=2。
   *
   * 【现在的顺序】① 先解析尾帧 (必要时等) → ② 再组装 params → ③ 提交。
   *
   * 【等待策略】
   *   ① 已有尾帧        → 直接用, 不等
   *   ② 尾帧正在生成中  → 等它 (明确上限 5 分钟 + 进度提示)
   *   ③ 尾帧不在生成中  → 最多再等 30 秒 (只给 DB 传播留余量), 然后降级 + 明确告警
   */
  async function resolveTransitionTail(sb: any): Promise<{ tail: string | null; nextNum: number }> {
    const nextShot0 = findNextShot(sb)
    if (!nextShot0) return { tail: null, nextNum: 0 }
    const nextNum = Number(nextShot0.storyboard_number ?? nextShot0.storyboardNumber ?? 0)
    const nextId = nextShot0.id

    // ① 前端列表里已有 → 直接用 (不额外刷新, 不拖慢常见路径)
    let tail = getFirstFrame(nextShot0)
    if (tail) return { tail, nextNum }

    // ② 前端列表没有 → 刷一次服务端。
    //   ★ 这正是本次事故的根因窗口: DB 里后一镜首帧已落库, 但前端 ctx.sbs 还是旧的
    //     (差 0.4 秒) → 前端以为没有尾帧 → 提交 single → 接缝硬切。
    try { await refresh() } catch { /* 刷新失败不阻断, 继续走下面的轮询 */ }
    const freshNext = ctx.sbs.value.find((s: any) => s.id === nextId) || nextShot0
    tail = getFirstFrame(freshNext)
    if (tail) return { tail, nextNum }

    // ③ 还是没有 → 正在生成中就等它 (明确上限 5 分钟); 没在生成就不干等 (30 秒上限)
    const pending = (await isTailFrameGenerating(nextId)) || !!isPendingShotFrame?.(nextId, 'first_frame')
    const attempts = pending ? TRANSITION_WAIT_ATTEMPTS_PENDING : TRANSITION_WAIT_ATTEMPTS_IDLE
    const toastId = `transition-wait-${nextId}-${++transitionWaitSeq}`
    const startedAt = Date.now()
    toast.info(
      `正在等待后一镜#${nextNum}的首帧 (本镜的尾帧), 以保证接缝连续... (已等 0s)`,
      { id: toastId, duration: 600000 },
    )
    try {
      // watchAsyncResult 每轮都会 refresh() → ctx.sbs 是服务端最新状态
      await watchAsyncResult(() => {
        const cur = ctx.sbs.value.find((s: any) => s.id === nextId)
        const got = !!getFirstFrame(cur)
        if (!got) {
          const sec = Math.round((Date.now() - startedAt) / 1000)
          toast.info(
            `正在等待后一镜#${nextNum}的首帧 (本镜的尾帧), 以保证接缝连续... (已等 ${sec}s)`,
            { id: toastId, duration: 600000 },
          )
        }
        return got
      }, attempts, TRANSITION_WAIT_INTERVAL_MS)
    } finally {
      toast.dismiss(toastId)
    }
    tail = getFirstFrame(ctx.sbs.value.find((s: any) => s.id === nextId))
    return { tail, nextNum }
  }

  async function genVid(sb: any, configId?: number | string | null) {
    // ★ Sprint 36: 先置 pending —— 等后一镜首帧可能要几分钟, 期间按钮必须置灰,
    //   否则能重复点 → 重复提交 → 重复扣费。
    if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
    try {
      delete failedVideoMessages.value[sb.id]
      applyFallbackReason(sb.id, null)  // Sprint 14: 重新生成前先清掉上一轮的降级 tag
      await genVidInner(sb, configId)
    } catch (e: any) {
      pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
      toast.error(e.message)
    }
  }

  async function genVidInner(sb: any, configId?: number | string | null) {
    // ★ Sprint 29 follow-up Task C (PM msg-20261102-133): 【只取英文版】—— 不再重复翻译。
    //   数据方向 (PM 决策 D1): 中文版 = 源, 英文版 = 翻译产物; 翻译【只在保存时发生一次】。
    //   以前这里取中文版 → 后端 video-generation 再翻一次 → 每镜多一次 LLM 调用
    //   (2500~3000 字符 in + 同样多 out, 18 镜多花 3~5 分钟), 而且用户看到的英文
    //   跟实际送进模型的英文不是同一份 (两次翻译结果不同) → 微调没有依据。
    //   现在直接送库里那份英文 (用户保存中文时已经翻好写回了) → 所见即所得, 省一次翻译。
    //   ★ 零回归: 中文版为空时 (老剧集), 这里取到的跟改动前逐字一致。
    let prompt = sb.video_prompt || sb.videoPrompt || ''
    // 有首帧时自动附加首帧一致性约束（Pavo AI 的镜头运动要求）
    let first = getFirstFrame(sb)
    // ★ Sprint 33 T5 (PM msg-20261103-140): 过渡镜的【尾帧】= 【后一镜的首帧】(同一个 URL,
    //   不额外生成) → 过渡镜→后一镜 那一刀是同一张图 = 100% 连续, 不靠参考逼近。
    //   ★ 过渡镜【没有自己的尾帧】—— 它的尾帧就是后一镜的首帧。
    const isTransition = isTransitionShot(sb)
    // ★ Sprint 36: 尾帧必须【在组装 params 之前】定下来 (见 resolveTransitionTail 注释)。
    //   非过渡镜的 last 取值逻辑逐字不变 → 非过渡镜的请求体零变化。
    let last: string | null = isTransition ? null : getLastFrame(sb)
    let bridgeNote = ''
    if (isTransition) {
      const resolved = await resolveTransitionTail(sb)
      const nextNum = resolved.nextNum
      if (resolved.tail) {
        last = resolved.tail
      } else {
        // ★ 降级必须【明确告知 + 常驻可见】, 不能静默按单图提交
        bridgeNote = nextNum
          ? `本镜未桥接: 缺后一镜#${nextNum}的首帧 (本镜的尾帧), 接缝会是硬切。建议先生成后一镜#${nextNum}的首帧, 再重新生成本镜。`
          : '本镜未桥接: 本镜是过渡镜但没有后一镜可接, 无法保证接缝连续。'
      }
    }
    // ★ Sprint 36: 过渡镜解析过程中会 refresh() → ctx.sbs 换成了服务端新对象,
    //   所以过渡镜的首帧/参考图要从 live 行取。
    //   ★ 非过渡镜走不到这里 (不 refresh) → live === sb → 请求体与改动前【逐字一致】。
    const live = ctx.sbs.value.find((s: any) => s.id === sb.id) || sb
    if (isTransition && live !== sb) {
      first = getFirstFrame(live) || first
    }
    const refs = getRefs(isTransition ? live : sb)
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
    // ★ Sprint 36: 桥接结果落到卡片上 (常驻, 不是一闪而过的 toast)
    if (bridgeNote) {
      videoBridgeNotes.value = { ...videoBridgeNotes.value, [sb.id]: bridgeNote }
      toast.warning(bridgeNote)
    } else {
      delete videoBridgeNotes.value[sb.id]
    }
    const generation = await videoAPI.generate(params)
    toast.success('视频生成中')
    await refresh()
    pollVideoGeneration(generation?.id, sb.id)
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
    videoBridgeNotes, videoBridgeNote,
    genVid, batchVideos, doCompose, batchCompose, pollVideoGeneration, pollComposeStatus,
  }
}

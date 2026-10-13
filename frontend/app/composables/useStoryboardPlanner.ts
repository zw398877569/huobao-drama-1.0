/**
 * useStoryboardPlanner — V4 wizard 3 步拆解 (PM msg-20261010-003)
 *
 * V4 架构 (跟老 1 步 endpoint 并存):
 *   - 老 endpoint /api/v1/agent/storyboard_breaker/planning 内部 redirect 到 runAllStepsLegacy (auto mode, 跳过 user review)
 *   - 新 wizard 走 3 个新 endpoint:
 *     1. POST /api/v1/agent/storyboard_breaker/planning/step1 → 返回 shot_plan
 *     2. POST /api/v1/agent/storyboard_breaker/planning/step2 → 返回 shot_details (Q4 B 拍板: body 可传 shot_plan 覆盖)
 *     3. POST /api/v1/agent/storyboard_breaker/planning/step3 → 写 DB, 返回 createdStoryboardIds (Q5 A 拍板: body 可传 shot_details 覆盖)
 *
 * 老 1 步 button ('AI 拆解分镜') 保留 (向后兼容), 新 button '分步拆解' 触发 wizard modal.
 *
 * State machine:
 *   currentStep: 0 (closed) / 1 (planning done) / 2 (details done) / 3 (persisted)
 *   step1Plan: ShotPlanItem[]
 *   step2Details: ShotDetailsItem[]
 *   error: lastError
 *   loading: per-step loading flag
 */
import { ref, computed } from 'vue'
import { toast } from 'vue-sonner'
import { agentAPI } from './useApi'

export interface ShotPlanItem {
  shot_number: number
  scene_id: number
  duration: number
  intent_function: string
  action: string
  character_ids?: number[]
}

export interface ShotDetailsItem {
  shot_number: number
  scene_id?: number
  character_ids?: number[]
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  duration?: number
  action?: string
  dialogue?: string
  description?: string
  result?: string
  atmosphere?: string
  intent_function?: string
  image_prompt_permanent?: {
    character_traits: Array<{ category: string; value: string }>
    scene_aesthetic: string[]
    shot_type_ref: '全景' | '中景' | '近景' | '特写'
    angle: string
    movement: string
  }
  image_prompt_plot_state?: string
  video_prompt_permanent?: string
  video_prompt_plot_state?: string
}

export function useStoryboardPlanner(opts: {
  dramaId: number | (() => number)
  episodeId: number | (() => number)
  selectedTextConfigId?: () => string | null
  onComplete?: () => void
}) {
  // reactive state (QA msg-20261010-008 ISSUE-A: 重命名 loading → wizardLoading 直接导出,
  //   避免 page 端 destructure 时 rename 丢失 reactivity)
  const wizardOpen = ref(false)
  const currentStep = ref<0 | 1 | 2 | 3>(0)
  const step1Plan = ref<ShotPlanItem[]>([])
  const step2Details = ref<ShotDetailsItem[]>([])
  const wizardLoading = ref(false)
  const error = ref<string | null>(null)
  // QA msg-20261010-008 ISSUE-B: 每步状态机, 给 progress bar + modal status banner 用
  //   'pending' (初始) / 'running' (跑中) / 'done' (完成) / 'error' (失败)
  const stepStatus = ref<{ 1: 'pending' | 'running' | 'done' | 'error'; 2: 'pending' | 'running' | 'done' | 'error'; 3: 'pending' | 'running' | 'done' | 'error' }>({
    1: 'pending',
    2: 'pending',
    3: 'pending',
  })
  const totalDuration = computed(() =>
    (step1Plan.value || []).reduce((s, p) => s + (p.duration || 0), 0),
  )

  // helpers
  function getDramaId() {
    return typeof opts.dramaId === 'function' ? opts.dramaId() : opts.dramaId
  }
  function getEpisodeId() {
    return typeof opts.episodeId === 'function' ? opts.episodeId() : opts.episodeId
  }

  function getTextConfigId() {
    return opts.selectedTextConfigId?.() ?? null
  }

  function resetWizard() {
    wizardOpen.value = false
    currentStep.value = 0
    step1Plan.value = []
    step2Details.value = []
    wizardLoading.value = false
    error.value = null
    stepStatus.value = { 1: 'pending', 2: 'pending', 3: 'pending' }
  }

  // V4 wizard 重进 modal 恢复进度 (PM msg-20261010-027 Part B)
  //   先 await backend getPlanningState, 拿到 step1_plan / step2_details / current_step,
  //   再 resetWizard 清空旧 state, 最后用 backend state 设置前端 reactive.
  //   - 没跑过 wizard: backend state 全 null/0 → currentStep=0 全 pending (跟之前一样)
  //   - step 1 完成过: currentStep=1 + step1Plan=数据 + stepStatus[1]=done
  //   - step 3 完成过: currentStep=3 + 进度条全 done
  //   - backend planning_data 损坏/缺失: fallback currentStep=0 (safe default)
  async function fetchState(): Promise<void> {
    try {
      // useApi req() 已解包 json.data, s 直接就是 { step1_plan, step2_details, step3_storyboard_ids, current_step }
      // 不要加 .data 一层 (sprint 24 写了 (state as any).data?.X 实际 state.data undefined → 全走 ?? [] 兜底 → state 恢复永远 step 0)
      const s: any = await agentAPI.planningState({ drama_id: getDramaId(), episode_id: getEpisodeId() })
      step1Plan.value = s?.step1_plan ?? []
      step2Details.value = s?.step2_details ?? []
      currentStep.value = s?.current_step ?? 0
      const s1Done = !!s?.step1_plan
      const s2Done = !!s?.step2_details
      const s3Done = !!s?.step3_storyboard_ids
      stepStatus.value = {
        1: s1Done ? 'done' : 'pending',
        2: s2Done ? 'done' : 'pending',
        3: s3Done ? 'done' : 'pending',
      } as any
    } catch (e: any) {
      // fetch 失败不影响打开 modal, fallback currentStep=0
      // req() throw 的是 Error(json.message), 没有 .data 层, 直接 e?.message 兜底
      toast.warning(`拉取 wizard 进度失败: ${e?.message || 'unknown'}, 按全新跑处理`)
    }
  }

  async function openWizard() {
    // 重进时先拉 backend state, 再 resetWizard 清空, 再恢复
    await fetchState()
    // close 后重进 → reset 已是空的, 直接用 fetchState 的设置
    // 但 fetchState 已经 setValue 过了, 这里再 reset 会清掉 — 改 resetWizard 加 'preserve' 参数, 默认保留
    // 简化: 直接用 fetchState 的值, 不调 resetWizard
    if (currentStep.value === 0 && step1Plan.value.length === 0) {
      resetWizard()  // 首次打开 (没跑过 wizard), 正常 reset
    }
    wizardOpen.value = true
  }

  function closeWizard() {
    wizardOpen.value = false
  }

  // 2026-10-13 sprint 44 FIX-057 (QA msg-20261013-057 P1): 重新分步拆解 — 强制清空前端 state, 从 step 1 重跑
  //   openWizard 拉 backend state 后, stepStatus 全 done, 没法从 step 1 重跑
  //   reopenWizard 强制 reset (跟 resetWizard 内部一致, 但不关 modal, 立即开 step 1 view)
  async function reopenWizard() {
    currentStep.value = 0
    step1Plan.value = []
    step2Details.value = []
    wizardLoading.value = false
    error.value = null
    stepStatus.value = { 1: 'pending', 2: 'pending', 3: 'pending' }
    wizardOpen.value = true
  }

  // ─── Step 1: 跑 LLM plan, 存 step1Plan ──────────────────────────
  async function runStep1(): Promise<void> {
    wizardLoading.value = true
    stepStatus.value[1] = 'running'
    error.value = null
    try {
      const body: any = {
        drama_id: getDramaId(),
        episode_id: getEpisodeId(),
      }
      const textConfigId = getTextConfigId()
      if (textConfigId) body.text_config_id = textConfigId

      // QA msg-20261010-008 ISSUE-D: $fetch 默认 30s timeout, LLM 偶尔 30-60s 跑超时报错 modal 状态卡住.
      //   跟 backend callLLMJson 180s 一致 + retry: 0 (callLLMJson 内部已 retry 1 次, 前端不重复 retry 防双倍请求)
      const resp = await $fetch<{ shot_plan: ShotPlanItem[]; total_duration: number; scene_distribution: Record<string, number> }>(
        '/api/v1/agent/storyboard_breaker/planning/step1',
        { method: 'POST', body, timeout: 420_000, retry: 0 },
      )
      step1Plan.value = resp.data?.shot_plan ?? []
      currentStep.value = 1
      stepStatus.value[1] = 'done'
      toast.success(`step1 完成: ${resp.data?.shot_plan?.length ?? 0} 镜头, 总时长 ${resp.data?.total_duration ?? 0}s`)
    } catch (e: any) {
      const isTimeout = e?.code === 'ETIMEDOUT' || e?.message?.includes('timeout') || e?.name === 'AbortError'
      error.value = isTimeout ? 'LLM 调用超时 (180s), 可重试或换模型' : (e?.data?.message || e?.message || 'step1 失败')
      stepStatus.value[1] = 'error'
      toast.error(`step1: ${error.value}`)
      throw e
    } finally {
      wizardLoading.value = false
    }
  }

  // ─── Step 2: 跑 LLM details (Q4 B: body 可传 shot_plan 覆盖 wizard 编辑) ─
  async function runStep2(shotPlanOverride?: ShotPlanItem[]): Promise<void> {
    wizardLoading.value = true
    stepStatus.value[2] = 'running'
    error.value = null
    try {
      const plan = shotPlanOverride || step1Plan.value
      const body: any = {
        drama_id: getDramaId(),
        episode_id: getEpisodeId(),
        shot_plan: plan,
      }
      const textConfigId = getTextConfigId()
      if (textConfigId) body.text_config_id = textConfigId

      const resp = await $fetch<{ shot_details: ShotDetailsItem[] }>(
        '/api/v1/agent/storyboard_breaker/planning/step2',
        { method: 'POST', body, timeout: 420_000, retry: 0 },
      )
      step2Details.value = resp.data?.shot_details ?? []
      currentStep.value = 2
      stepStatus.value[2] = 'done'
      toast.success(`step2 完成: ${resp.data?.shot_details?.length ?? 0} 个分镜详情`)
    } catch (e: any) {
      const isTimeout = e?.code === 'ETIMEDOUT' || e?.message?.includes('timeout') || e?.name === 'AbortError'
      error.value = isTimeout ? 'LLM 调用超时 (180s), 可重试或换模型' : (e?.data?.message || e?.message || 'step2 失败')
      stepStatus.value[2] = 'error'
      toast.error(`step2: ${error.value}`)
      throw e
    } finally {
      wizardLoading.value = false
    }
  }

  // ─── Step 3: persist (Q5 A: body 可传 shot_details 覆盖 wizard 编辑) ───
  async function runStep3(shotDetailsOverride?: ShotDetailsItem[]): Promise<void> {
    wizardLoading.value = true
    stepStatus.value[3] = 'running'
    error.value = null
    try {
      const details = shotDetailsOverride || step2Details.value
      const body: any = {
        drama_id: getDramaId(),
        episode_id: getEpisodeId(),
        shot_details: details,
      }
      const resp = await $fetch<{ createdStoryboardIds: number[] }>(
        '/api/v1/agent/storyboard_breaker/planning/step3',
        { method: 'POST', body, timeout: 420_000, retry: 0 },
      )
      currentStep.value = 3
      stepStatus.value[3] = 'done'
      toast.success(`step3 完成: 创建 ${resp.data?.createdStoryboardIds?.length ?? 0} 个分镜`)
      opts.onComplete?.()
    } catch (e: any) {
      const isTimeout = e?.code === 'ETIMEDOUT' || e?.message?.includes('timeout') || e?.name === 'AbortError'
      error.value = isTimeout ? '持久化超时 (180s), 可重试' : (e?.data?.message || e?.message || 'step3 失败')
      stepStatus.value[3] = 'error'
      toast.error(`step3: ${error.value}`)
      throw e
    } finally {
      wizardLoading.value = false
    }
  }

  // ─── 用户编辑辅助函数 ────────────────────────────────────────
  // 用户在 wizard 调 shot 数 / duration, 本地改 plan
  function updateShotDuration(shotNumber: number, newDuration: number) {
    const shot = step1Plan.value.find(s => s.shot_number === shotNumber)
    if (shot) shot.duration = newDuration
  }

  function removeShot(shotNumber: number) {
    step1Plan.value = step1Plan.value
      .filter(s => s.shot_number !== shotNumber)
      .map((s, i) => ({ ...s, shot_number: i + 1 }))
  }

  function addShot() {
    const last = step1Plan.value[step1Plan.value?.length ?? 0 - 1]
    step1Plan.value = [
      ...step1Plan.value,
      {
        shot_number: step1Plan.value?.length ?? 0 + 1,
        scene_id: last?.scene_id ?? 0,
        duration: 8,
        intent_function: '铺垫',
        action: '(待编辑)',
        character_ids: [],
      },
    ]
  }

  function updateDetailPrompt(shotNumber: number, field: keyof ShotDetailsItem, value: string) {
    const det = step2Details.value.find(d => d.shot_number === shotNumber)
    if (det) (det as any)[field] = value
  }

  return {
    // state (QA msg-20261010-008 ISSUE-A: wizardLoading 直接导出, page 端直接解构不再 rename)
    wizardOpen,
    currentStep,
    step1Plan,
    step2Details,
    wizardLoading,
    stepStatus,
    error,
    totalDuration,
    // actions
    openWizard,
    closeWizard,
    reopenWizard,
    resetWizard,
    runStep1,
    runStep2,
    runStep3,
    // helpers
    updateShotDuration,
    removeShot,
    addShot,
    updateDetailPrompt,
  }
}

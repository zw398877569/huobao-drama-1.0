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

  function openWizard() {
    resetWizard()
    wizardOpen.value = true
  }

  function closeWizard() {
    wizardOpen.value = false
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
        { method: 'POST', body, timeout: 180_000, retry: 0 },
      )
      step1Plan.value = resp.shot_plan
      currentStep.value = 1
      stepStatus.value[1] = 'done'
      toast.success(`step1 完成: ${resp.shot_plan.length} 镜头, 总时长 ${resp.total_duration}s`)
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
        { method: 'POST', body, timeout: 180_000, retry: 0 },
      )
      step2Details.value = resp.shot_details
      currentStep.value = 2
      stepStatus.value[2] = 'done'
      toast.success(`step2 完成: ${resp.shot_details.length} 个分镜详情`)
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
        { method: 'POST', body, timeout: 180_000, retry: 0 },
      )
      currentStep.value = 3
      stepStatus.value[3] = 'done'
      toast.success(`step3 完成: 创建 ${resp.createdStoryboardIds.length} 个分镜`)
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
    const last = step1Plan.value[step1Plan.value.length - 1]
    step1Plan.value = [
      ...step1Plan.value,
      {
        shot_number: step1Plan.value.length + 1,
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

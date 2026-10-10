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
  // reactive state
  const wizardOpen = ref(false)
  const currentStep = ref<0 | 1 | 2 | 3>(0)
  const step1Plan = ref<ShotPlanItem[]>([])
  const step2Details = ref<ShotDetailsItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const totalDuration = computed(() =>
    step1Plan.value.reduce((s, p) => s + (p.duration || 0), 0),
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
    error.value = null
    loading.value = false
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
    loading.value = true
    error.value = null
    try {
      const body: any = {
        drama_id: getDramaId(),
        episode_id: getEpisodeId(),
      }
      const textConfigId = getTextConfigId()
      if (textConfigId) body.text_config_id = textConfigId

      const resp = await $fetch<{ shot_plan: ShotPlanItem[]; total_duration: number; scene_distribution: Record<string, number> }>(
        '/api/v1/agent/storyboard_breaker/planning/step1',
        { method: 'POST', body },
      )
      step1Plan.value = resp.shot_plan
      currentStep.value = 1
      toast.success(`step1 完成: ${resp.shot_plan.length} 镜头, 总时长 ${resp.total_duration}s`)
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'step1 失败'
      toast.error(`step1: ${error.value}`)
      throw e
    } finally {
      loading.value = false
    }
  }

  // ─── Step 2: 跑 LLM details (Q4 B: body 可传 shot_plan 覆盖 wizard 编辑) ─
  async function runStep2(shotPlanOverride?: ShotPlanItem[]): Promise<void> {
    loading.value = true
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
        { method: 'POST', body },
      )
      step2Details.value = resp.shot_details
      currentStep.value = 2
      toast.success(`step2 完成: ${resp.shot_details.length} 个分镜详情`)
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'step2 失败'
      toast.error(`step2: ${error.value}`)
      throw e
    } finally {
      loading.value = false
    }
  }

  // ─── Step 3: persist (Q5 A: body 可传 shot_details 覆盖 wizard 编辑) ───
  async function runStep3(shotDetailsOverride?: ShotDetailsItem[]): Promise<void> {
    loading.value = true
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
        { method: 'POST', body },
      )
      currentStep.value = 3
      toast.success(`step3 完成: 创建 ${resp.createdStoryboardIds.length} 个分镜`)
      opts.onComplete?.()
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'step3 失败'
      toast.error(`step3: ${error.value}`)
      throw e
    } finally {
      loading.value = false
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
    // state
    wizardOpen,
    currentStep,
    step1Plan,
    step2Details,
    loading,
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

/**
 * useBatchVideoSchedule — 视频生成定时计划 composable (Sprint 10 PM msg-20261014-001 task E)
 *
 * 跟 backend POST /videos/batch-schedules + GET ?episode_id=N + DELETE /:id 配合
 */
import { api } from '~/composables/useApi'
import { toast } from 'vue-sonner'

export interface BatchVideoPlan {
  id: number
  episodeId: number
  scheduledAt: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  videoConfigId: number | null
  shotIds: string  // JSON array string
  shotCount: number
  successCount: number
  failedCount: number
  lastError: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  lastRunAt: string | null
  cronJobId: string | null
  // Sprint 10 v2 Task B (PM msg-20261014-002): per-shot 执行结果 JSON 字符串
  //   格式: [{ shot_id, status: 'completed' | 'failed', video_generation_id?, error? }]
  //   null = 老 plan (v1 实施期没存此字段) 或 plan 没跑完 (status=running)
  perShotStatus: string | null
  // Sprint 11c (PM msg-20261016-003): 生成耗时
  //   planDurationSecs: plan 总耗时 (最早 shot created_at → 最晚 shot completed_at 的差值, 秒)
  //     不能用 startedAt→finishedAt (triggerPlan 异步派发就返回, 实测只差 1s)
  //     null = 无成功 shot / 还没跑完 / 已 cancelled
  planDurationSecs?: number | null
  //   avgDurationSecs: 各成功 shot 单镜耗时平均值 (后端已算好, 前端暂不显示, 供未来排序/统计)
  avgDurationSecs?: number | null
  //   perShotElapsed: perShotStatus 的结构化版本, 每项额外带 durationSecs (单镜耗时, 秒)
  //     失败 shot 为 null (无 video_generation_id 关联不到耗时)。老后端不返此字段 → 前端降级读 perShotStatus
  perShotElapsed?: Array<{
    shot_id: number
    status: 'completed' | 'failed'
    video_generation_id?: number
    error?: string
    durationSecs?: number | null
  }> | null
}

export interface CreateBatchVideoPlanInput {
  episode_id: number
  scheduled_at: string  // ISO datetime string, 本地时间 (scheduler timezone Asia/Shanghai)
  shot_ids: number[]
  video_config_id?: number | null
}

/**
 * @param episodeId 接受 Ref<number> | (() => number) | number, 调用时读取 (避免响应式 track 失效)
 */
export function useBatchVideoSchedule(episodeId: Ref<number> | (() => number) | number) {
  const resolveEpisodeId = (): number => {
    if (typeof episodeId === 'function') return Number(episodeId())
    if (typeof episodeId === 'number') return episodeId
    return Number(episodeId.value)
  }

  // Plans list
  const plans = ref<BatchVideoPlan[]>([])
  const loading = ref(false)

  async function loadPlans() {
    const epId = resolveEpisodeId()
    if (!epId) {
      plans.value = []
      return
    }
    loading.value = true
    try {
      const data = await api.get<unknown>(
        '/videos/batch-schedules',
        { episode_id: epId },
      )
      // 兼容多种后端响应 shape:
      //   1. 裸 array (useApi.ts req 已自动解构 json.data → 直接 array)
      //   2. { data: [...] } (如果 useApi.ts 行为变化)
      //   3. { items: [...] } (罕见, 防御性)
      let list: BatchVideoPlan[] = []
      if (Array.isArray(data)) {
        list = data as BatchVideoPlan[]
      } else if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>
        list = (Array.isArray(obj.data) ? obj.data :
                Array.isArray(obj.items) ? obj.items : []) as BatchVideoPlan[]
      }
      plans.value = list
    } catch (err: any) {
      console.error('[useBatchVideoSchedule] loadPlans 失败:', err)
      toast.error('加载定时计划失败: ' + (err?.message || String(err)))
      plans.value = []
    } finally {
      loading.value = false
    }
  }

  async function createPlan(input: CreateBatchVideoPlanInput): Promise<BatchVideoPlan | null> {
    const epId = resolveEpisodeId()
    if (!epId) {
      toast.error('未选择 episode, 不能创建计划')
      return null
    }
    try {
      const body = {
        episode_id: epId,
        scheduled_at: input.scheduled_at,
        shot_ids: input.shot_ids,
        video_config_id: input.video_config_id ?? null,
      }
      const resp = await api.post<{ success: boolean; data: BatchVideoPlan }>(
        '/videos/batch-schedules',
        body,
      )
      const plan = (resp as any)?.data ?? resp
      plans.value = [plan, ...plans.value]
      toast.success('定时计划已创建')
      return plan
    } catch (err: any) {
      toast.error('创建定时计划失败: ' + (err?.message || String(err)))
      return null
    }
  }

  async function cancelPlan(id: number): Promise<boolean> {
    try {
      await api.del(`/videos/batch-schedules/${id}`)
      // 本地立即更新 status 为 cancelled (避免 reload)
      plans.value = plans.value.map(p => p.id === id ? { ...p, status: 'cancelled' } : p)
      toast.success('定时计划已取消')
      return true
    } catch (err: any) {
      toast.error('取消定时计划失败: ' + (err?.message || String(err)))
      return false
    }
  }

  return {
    plans,
    loading,
    loadPlans,
    createPlan,
    cancelPlan,
    formatCountdown,
  }
}

/**
 * 格式化 ISO datetime → 相对时间文案 (e.g. "3h 25m 后" / "1d 2h 后" / "已过期")
 * 用于 table 倒计时列
 */
export function formatCountdown(scheduledAt: string, now: Date = new Date()): string {
  if (!scheduledAt) return '—'
  const target = new Date(scheduledAt)
  if (isNaN(target.getTime())) return '—'
  const diffMs = target.getTime() - now.getTime()
  if (diffMs < 0) return '已过期'

  const totalMin = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin % (60 * 24)) / 60)
  const minutes = totalMin % 60

  if (days > 0) return `${days}d ${hours}h 后`
  if (hours > 0) return `${hours}h ${minutes}m 后`
  if (minutes > 0) return `${minutes}m 后`
  return '即将触发'
}

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
      const data = await api.get<{ success: boolean; data: BatchVideoPlan[] } | BatchVideoPlan[]>(
        '/videos/batch-schedules',
        { episode_id: epId },
      )
      // 后端返回 { success, data } 包裹; 兼容裸数组 (防御性)
      const list = Array.isArray(data) ? data : (data as any)?.data ?? []
      plans.value = list
    } catch (err: any) {
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

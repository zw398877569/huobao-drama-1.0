/**
 * Batch Video Scheduler (Sprint 10 PM msg-20261014-001)
 *
 * 项目内 node-cron 调度, 触发 batch_video_schedules 计划批量生成视频.
 *
 * 工单设计:
 *   - 一次性计划 (one-off), 触发后即废
 *   - 串行跑每个 shot_id (用户拍板 D)
 *   - video_config_id NULL 时用 episode.videoConfigId 锁定 fallback (用户拍板 D5/A)
 *   - status enum: pending / running / done / failed / cancelled
 *   - 失败不自动重跑, 用户走原『生成视频』按钮手动重跑
 *
 * Sprint 10 task B 提交 stub (函数签名 + 内存 cronJobs Map), C 任务填充实际实现.
 */
import cron from 'node-cron'

// 内存级 cron job registry: cronJobId (string) -> node-cron task
// backend 重启后失效, D 任务 initBatchVideoScheduler 重读 pending 重建
const cronJobs = new Map<string, cron.ScheduledTask>()

/**
 * backend 启动时调 — 读 batch_video_schedules WHERE status='pending', 重建 cron job
 * 由 D 任务 backend/src/index.ts 在 ensureLogDir() 之后调
 */
export async function initBatchVideoScheduler(): Promise<void> {
  // TODO Sprint 10 C: 读 pending plans, 为每个 registerPlan(plan)
}

/**
 * 注册单个 plan 的 cron job — POST 创建 plan 时调
 * @param plan batch_video_schedules 行 (含 id, scheduledAt, shotIds, videoConfigId, episodeId)
 * @returns cronJobId (写入 plan.cron_job_id 字段, 用于后续 unregister)
 */
export async function registerPlan(plan: {
  id: number
  episodeId: number
  scheduledAt: string
  shotIds: string
  videoConfigId: number | null
}): Promise<string> {
  // TODO Sprint 10 C: ISO datetime → cron 6 字段转换 + cron.schedule + 存到 cronJobs Map
  const cronJobId = `plan-${plan.id}`
  return cronJobId
}

/**
 * 取消 plan — DELETE batch-schedules/:id 时调
 * @param cronJobId 数据库 plan.cron_job_id 字段
 */
export async function unregisterPlan(cronJobId: string): Promise<void> {
  const task = cronJobs.get(cronJobId)
  if (task) {
    task.stop()
    cronJobs.delete(cronJobId)
  }
}

/**
 * 内部触发器 — node-cron 到点调
 * 串行跑每个 shot_id, 失败不重试 (用户走原『生成视频』按钮重跑)
 */
export async function triggerPlan(planId: number): Promise<void> {
  // TODO Sprint 10 C:
  //   1. UPDATE batch_video_schedules SET status='running', started_at=now() WHERE id=?
  //   2. 读 plan.shot_ids (JSON array), plan.video_config_id
  //   3. 对每个 shot_id 串行调 videoAPI.generate (复用 routes/videos.ts POST / 逻辑 + video_config_id fallback)
  //   4. 跟踪 successCount / failedCount
  //   5. UPDATE plan: status=done / failed, finished_at=now()
  //   6. logTaskSuccess / logTaskError
}

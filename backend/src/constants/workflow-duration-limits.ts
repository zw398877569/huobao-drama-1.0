/**
 * ★ Sprint 47 T8 (PM msg-20261115-188): 各 AutoDL 工作流的【时长上限】(秒)
 *
 * ★ 本文件是【生成物】, 不要手改 —— 改法: 改知识库档案, 然后跑
 *   node scripts/sync-workflow-duration-limits.js
 *
 * 数据来源: /Users/mac/Obsidian/ComfyUi/autodl-workflows-auto.md
 *   (cron 每日从 autodl.art 公开 API 同步的 AutoDL 工作流档案)
 * ★ 事实来源 → 代码里不硬写数字 (工单硬要求: 上限要有出处, 平台改上限不用改代码)
 */
export const WORKFLOW_DURATION_LIMITS: Record<string, number> = {
  "minimax_h3_801": 15,
  "minimax_h3_802": 15,
  "minimax_h3_803": 15,
  "minimax_h3_804": 15,
  "minimax_h3_805": 15,
  "minimax_h3_b99_001": 15,
  "minimax_h3_b99_002": 15,
  "minimax_h3_b99_003_12s": 15,
  "minimax_h3_image_audio_to_video_v2": 10,
  "minimax_h3_image_audio_to_video_v2_15s": 15,
  "minimax_h3_lightx2v": 15,
  "minimax_h3_lightx2v_no_pic": 15,
  "minimax_h3_lightx2v_v5": 10,
  "minimax_h3_lightx2v_v5_15s": 15,
  "minimax_h3_z0901": 15,
  "minimax_h3_z0902": 15,
  "minimax_h3_z0903": 15,
  "minimax_h3_zm_nono": 15,
  "minimax_h3_zm_titi": 25,
  "minimax_h3_zm_titim": 25,
  "minimax_h3_zm_u08": 15,
  "minimax_h3_zm_u22": 15,
  "minimax_h3_zm_u24": 15,
  "minimax_h3_zm_u30": 15,
}

/** 某工作流的时长上限 (未知工作流 → 返回 fallback, 默认 15 = 平台通用上限) */
export function getWorkflowDurationLimit(workflowId: string, fallback = 15): number {
  const v = WORKFLOW_DURATION_LIMITS[workflowId]
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback
}

/** 该工作流是否支持这个时长 */
export function workflowSupportsDuration(workflowId: string, duration: number): boolean {
  return duration <= getWorkflowDurationLimit(workflowId)
}

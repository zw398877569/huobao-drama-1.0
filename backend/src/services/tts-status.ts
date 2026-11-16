/**
 * ★ Sprint 48 T5 (PM msg-20261116-194): 配音生成的【状态登记】(拆镜后自动配音要能看到进行中/完成/失败)
 *
 * 【为什么要有】
 *   工单验收: "配音不能阻塞拆分流程 —— 要能异步跑, 并让用户看得到状态 (进行中 / 完成 / 失败)"
 *   + "失败要有提示, 不能静默 (用户要能重试)"。
 *
 * 【口径】
 *   · 进程内 Map (不落库): 配音只要几秒, 重启后状态丢失可接受 →
 *     前端兜底用 storyboards.tts_segments 是否有内容判断"已完成"。
 *   · 状态: running(生成中) / done(完成) / failed(失败, 带原因) / skipped(这镜没台词, 不生成)
 */
export type TtsJobStatus = 'running' | 'done' | 'failed' | 'skipped'

export interface TtsJobEntry {
  storyboardId: number
  status: TtsJobStatus
  /** 失败原因 (failed 时) */
  error?: string
  startedAt: string
  finishedAt?: string
}

const registry = new Map<number, TtsJobEntry>()

export function setTtsJobStatus(entry: TtsJobEntry): void {
  registry.set(entry.storyboardId, entry)
}

export function getTtsJobStatus(storyboardId: number): TtsJobEntry | null {
  return registry.get(storyboardId) ?? null
}

export function getTtsJobStatuses(storyboardIds: number[]): Record<number, TtsJobEntry> {
  const out: Record<number, TtsJobEntry> = {}
  for (const id of storyboardIds) {
    const e = registry.get(id)
    if (e) out[id] = e
  }
  return out
}

/** 状态多久算过期 (前端轮询用) —— 超过 10 分钟的 running 视为异常, 不再显示"生成中" */
export function isStaleTtsJob(entry: TtsJobEntry | null | undefined, maxAgeMs = 10 * 60 * 1000): boolean {
  if (!entry || entry.status !== 'running') return false
  const started = Date.parse(entry.startedAt)
  return Number.isFinite(started) && Date.now() - started > maxAgeMs
}

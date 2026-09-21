<script setup lang="ts">
/**
 * /tasks — 外部 launchd 定时任务监控页
 * 数据来源: ~/bin/task-runner.sh → POST /api/v1/cron/runs
 * 完全独立于项目内 logTask / videoGenerations 等
 */
import { computed, onMounted, ref } from 'vue'
import { cronAPI } from '~/composables/useApi'

// ====== 工具 ======
function todayStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtTime(ts: number | null | undefined) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function fmtDur(ms: number | null | undefined) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

function statusTag(s: string): { label: string; cls: string } {
  if (s === 'success') return { label: '成功', cls: 'tag-success' }
  if (s === 'failed') return { label: '失败', cls: 'tag-error' }
  if (s === 'running') return { label: '运行中', cls: 'tag-pending' }
  return { label: s, cls: 'tag-default' }
}

// ====== state ======
const date = ref(todayStr(-1))         // 默认昨天
const statusFilter = ref<string>('')   // '' / running / success / failed
const nameFilter = ref<string>('')
const runs = ref<any[]>([])
const stats = ref<{ total: number; success: number; failed: number; running: number; avgDurationMs: number }>(
  { total: 0, success: 0, failed: 0, running: 0, avgDurationMs: 0 }
)
const loading = ref(false)
const selected = ref<any | null>(null)
const detailLoading = ref(false)

// 可选任务名 (从后端拉到的不重复列表)
const nameOptions = computed(() => {
  const s = new Set<string>()
  for (const r of runs.value) if (r.name) s.add(r.name)
  return Array.from(s).sort()
})

async function load() {
  loading.value = true
  try {
    const params: any = { date: date.value, limit: 300 }
    if (statusFilter.value) params.status = statusFilter.value
    if (nameFilter.value) params.name = nameFilter.value
    const data: any = await cronAPI.list(params)
    runs.value = data?.runs || []
    stats.value = data?.stats || stats.value
  } catch (e: any) {
    console.warn('load runs failed', e)
    runs.value = []
  } finally {
    loading.value = false
  }
}

async function openDetail(row: any) {
  selected.value = row
  detailLoading.value = true
  try {
    const full = await cronAPI.get(row.runId)
    if (full) selected.value = full
  } catch (e) {
    // 用列表里的行也凑合
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() { selected.value = null }

function quickJump(days: number) {
  date.value = todayStr(days)
  load()
}

function statusBadge(s: string) {
  return statusTag(s).cls
}

onMounted(load)
</script>

<template>
  <div class="tasks-page">
    <!-- 顶部工具栏 -->
    <div class="tasks-toolbar">
      <div class="tasks-filters">
        <label class="tasks-field">
          <span class="tasks-field-label">日期</span>
          <div class="tasks-quick-row">
            <button class="quick-btn" :class="{ active: date === todayStr(-1) }" @click="quickJump(-1)">昨天</button>
            <button class="quick-btn" :class="{ active: date === todayStr(0) }" @click="quickJump(0)">今天</button>
            <button class="quick-btn" :class="{ active: date === todayStr(-7) }" @click="quickJump(-7)">7 天前</button>
          </div>
          <input v-model="date" type="date" class="tasks-input" @change="load" />
        </label>
        <label class="tasks-field">
          <span class="tasks-field-label">任务</span>
          <select v-model="nameFilter" class="tasks-input" @change="load">
            <option value="">全部</option>
            <option v-for="n in nameOptions" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label class="tasks-field">
          <span class="tasks-field-label">状态</span>
          <select v-model="statusFilter" class="tasks-input" @change="load">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="running">运行中</option>
          </select>
        </label>
      </div>
      <div class="tasks-actions">
        <button class="btn btn-primary" :disabled="loading" @click="load">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>
          </svg>
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="tasks-stats">
      <div class="stat-card">
        <div class="stat-num">{{ stats.total }}</div>
        <div class="stat-label">总运行次数</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-num">{{ stats.success }}</div>
        <div class="stat-label">成功</div>
      </div>
      <div class="stat-card stat-failed">
        <div class="stat-num">{{ stats.failed }}</div>
        <div class="stat-label">失败</div>
      </div>
      <div class="stat-card stat-running">
        <div class="stat-num">{{ stats.running }}</div>
        <div class="stat-label">运行中</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ fmtDur(stats.avgDurationMs) }}</div>
        <div class="stat-label">平均耗时</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ stats.total > 0 ? Math.round(stats.success * 100 / stats.total) : 0 }}%</div>
        <div class="stat-label">成功率</div>
      </div>
    </div>

    <!-- 表格 -->
    <div class="tasks-table-wrap">
      <table class="tasks-table">
        <thead>
          <tr>
            <th style="width: 160px">开始时间</th>
            <th style="width: 140px">任务名</th>
            <th style="width: 100px">状态</th>
            <th style="width: 100px">退出码</th>
            <th style="width: 90px">耗时</th>
            <th style="width: 100px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && !runs.length">
            <td colspan="6" class="tasks-empty">加载中…</td>
          </tr>
          <tr v-else-if="!runs.length">
            <td colspan="6" class="tasks-empty">
              <div>{{ date }} 没有记录</div>
              <div class="dim" style="font-size:11px; margin-top:4px">
                数据从代码改动那一刻开始记录 — 之前的日志捞不回来
              </div>
            </td>
          </tr>
          <tr v-for="r in runs" :key="r.runId || r.id" class="tasks-row" @click="openDetail(r)">
            <td class="mono">{{ fmtTime(r.startedAt) }}</td>
            <td>{{ r.name }}</td>
            <td>
              <span :class="['tag', statusBadge(r.status)]">{{ statusTag(r.status).label }}</span>
            </td>
            <td class="mono">{{ r.exitCode ?? '—' }}</td>
            <td class="mono">{{ fmtDur(r.durationMs) }}</td>
            <td>
              <button class="btn btn-sm" @click.stop="openDetail(r)">查看</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="selected" class="tasks-detail-mask" @click="closeDetail">
      <div class="tasks-detail" @click.stop>
        <div class="tasks-detail-head">
          <div>
            <div class="tasks-detail-title">
              {{ selected.name }} <span :class="['tag', statusBadge(selected.status)]">{{ statusTag(selected.status).label }}</span>
            </div>
            <div class="tasks-detail-sub mono">{{ fmtTime(selected.startedAt) }} · {{ fmtDur(selected.durationMs) }} · exit={{ selected.exitCode ?? '—' }}</div>
          </div>
          <button class="btn btn-ghost btn-icon" @click="closeDetail">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="tasks-detail-body">
          <div class="detail-row">
            <div class="detail-key">run_id</div>
            <div class="detail-val mono">{{ selected.runId }}</div>
          </div>
          <div class="detail-row">
            <div class="detail-key">开始</div>
            <div class="detail-val mono">{{ fmtTime(selected.startedAt) }}</div>
          </div>
          <div class="detail-row">
            <div class="detail-key">结束</div>
            <div class="detail-val mono">{{ fmtTime(selected.endedAt) }}</div>
          </div>
          <div class="detail-row">
            <div class="detail-key">输出 (末尾 2000 字)</div>
          </div>
          <pre v-if="selected.output" class="tasks-output">{{ selected.output }}</pre>
          <div v-else class="dim tasks-output-empty">无输出</div>
          <div v-if="detailLoading" class="dim" style="font-size:11px; padding:4px 0">详情加载中…</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px;
  height: 100%;
  overflow: auto;
}

/* 工具栏 */
.tasks-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.tasks-filters { display: flex; gap: 12px; flex-wrap: wrap; }
.tasks-field { display: flex; flex-direction: column; gap: 4px; }
.tasks-field-label { font-size: 11px; color: var(--text-3); font-weight: 600; }
.tasks-input {
  padding: 6px 9px;
  font-size: 12.5px;
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-1);
  outline: none;
  min-width: 140px;
}
.tasks-input:focus { border-color: var(--accent); }
.tasks-quick-row { display: flex; gap: 4px; margin-bottom: 4px; }
.quick-btn {
  padding: 3px 8px;
  font-size: 11px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 99px;
  cursor: pointer;
  color: var(--text-2);
  transition: all 0.12s;
}
.quick-btn:hover { background: var(--bg-hover); }
.quick-btn.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-text); }

/* 统计 */
.tasks-stats {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
}
.stat-card {
  padding: 12px 14px;
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-card.stat-success { border-left: 3px solid #28a745; }
.stat-card.stat-failed { border-left: 3px solid #dc3545; }
.stat-card.stat-running { border-left: 3px solid var(--accent); }
.stat-num { font-size: 22px; font-weight: 700; color: var(--text-0); font-family: var(--font-mono); }
.stat-label { font-size: 11px; color: var(--text-3); }

/* 表格 */
.tasks-table-wrap {
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: auto;
  flex: 1 1 auto;
  min-height: 200px;
}
.tasks-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tasks-table thead { background: var(--bg-1); position: sticky; top: 0; z-index: 1; }
.tasks-table th {
  text-align: left;
  padding: 10px 12px;
  font-weight: 600;
  color: var(--text-2);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
}
.tasks-table td { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text-1); }
.tasks-row { cursor: pointer; transition: background 0.1s; }
.tasks-row:hover { background: var(--bg-hover); }
.tasks-empty { padding: 40px 12px; text-align: center; color: var(--text-3); }
.mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); }

/* tag */
.tag { padding: 2px 8px; border-radius: 99px; font-size: 10.5px; font-weight: 600; }
.tag-success { background: rgba(40, 167, 69, 0.15); color: #28a745; }
.tag-error { background: rgba(220, 53, 69, 0.15); color: #dc3545; }
.tag-pending { background: rgba(76, 125, 255, 0.15); color: var(--accent-dark); }
.tag-default { background: var(--bg-2); color: var(--text-3); }

/* 详情抽屉 */
.tasks-detail-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: flex-end;
  z-index: 200;
  animation: fadeIn 0.15s ease;
}
.tasks-detail {
  width: 540px;
  max-width: 90vw;
  height: 100%;
  background: var(--bg-0);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.2s ease;
}
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }
.tasks-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}
.tasks-detail-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.tasks-detail-sub { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.tasks-detail-body { padding: 14px 18px; overflow-y: auto; flex: 1; }
.detail-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; }
.detail-key { color: var(--text-3); width: 100px; flex-shrink: 0; }
.detail-val { color: var(--text-1); flex: 1; word-break: break-all; }
.tasks-output {
  margin: 6px 0 0;
  padding: 10px 12px;
  background: #0e1116;
  color: #d4d4d4;
  font-family: var(--font-mono);
  font-size: 11.5px;
  border-radius: var(--radius);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 50vh;
  overflow-y: auto;
}
.tasks-output-empty { padding: 12px; text-align: center; font-size: 12px; }

/* dim */
.dim { color: var(--text-3); }

@media (max-width: 900px) {
  .tasks-stats { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 600px) {
  .tasks-stats { grid-template-columns: repeat(2, 1fr); }
  .tasks-table { font-size: 11.5px; }
  .tasks-table th, .tasks-table td { padding: 7px 8px; }
}
</style>

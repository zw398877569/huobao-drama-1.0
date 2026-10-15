<!--
  VideoSchedulePlan.vue — Sprint 10 PM msg-20261014-001 task F
  视频生成定时计划组件, 用 useBatchVideoSchedule composable + episodeAPI 拿 shots
-->
<template>
  <div class="video-schedule-plan">
    <div class="section-bar">
      <div>
        <div class="section-title">视频生成定时计划</div>
        <div class="section-sub">项目内 node-cron 调度, 一次性计划, 失败手动重跑</div>
      </div>
      <button class="btn btn-primary" :disabled="loading" @click="openCreateModal">
        + 新建计划
      </button>
    </div>

    <div v-if="loading && plans.length === 0" class="empty-state">加载中…</div>
    <div v-else-if="plans.length === 0" class="empty-state">
      还没有定时计划 · 视频生成平台夜间便宜, 建议设 0-6 点触发
    </div>
    <table v-else class="plan-table">
      <thead>
        <tr>
          <th>触发时间</th>
          <th>倒计时</th>
          <th>状态</th>
          <th>镜头</th>
          <th>成功 / 失败</th>
          <th>配置</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in plans" :key="p.id" :class="`row-${p.status}`">
          <td>{{ formatDateTime(p.scheduledAt) }}</td>
          <td>{{ formatCountdown(p.scheduledAt) }}</td>
          <td><span class="tag" :class="`tag-${p.status}`">{{ statusLabel(p.status) }}</span></td>
          <td>{{ p.shotCount }} 镜</td>
          <td>{{ p.successCount }} / {{ p.failedCount }}</td>
          <td>{{ p.videoConfigId ?? 'episode 锁定' }}</td>
          <td>
            <button
              v-if="p.status === 'pending'"
              class="btn btn-sm btn-ghost"
              style="color: var(--error)"
              @click="onCancel(p.id)"
            >取消</button>
            <span v-else class="dim">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 新建 modal -->
    <div v-if="createModalOpen" class="modal-overlay" @click.self="createModalOpen = false">
      <div class="modal">
        <div class="modal-head">
          <span class="modal-title">新建视频生成定时计划</span>
          <button class="btn btn-ghost btn-icon" @click="createModalOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>触发时间 (本地时间 Asia/Shanghai)</label>
            <input type="datetime-local" v-model="createForm.scheduledAtLocal" />
          </div>
          <div class="form-row">
            <label>选择镜头 ({{ createForm.shotIds.length }} / {{ shots.length }} 选)</label>
            <div class="shot-actions">
              <button type="button" class="btn btn-sm" @click="selectAllShots">全选</button>
              <button type="button" class="btn btn-sm" @click="selectNoneShots">清空</button>
            </div>
            <div class="shot-list">
              <label v-for="sb in shots" :key="sb.id" class="shot-item">
                <input type="checkbox" :value="sb.id" v-model="createForm.shotIds" />
                <span class="shot-num">#{{ sb.storyboardNumber ?? sb.id }}</span>
                <span class="shot-title">{{ sb.title || sb.description || '无标题' }}</span>
                <span v-if="sb.duration" class="dim mono">{{ sb.duration }}s</span>
              </label>
              <div v-if="shots.length === 0" class="dim" style="padding: 12px">没有镜头可选</div>
            </div>
          </div>
          <div class="form-row">
            <label>视频配置 (可选, NULL 用 episode 锁定)</label>
            <select v-model="createForm.videoConfigId">
              <option :value="null">用 episode 锁定 (默认)</option>
              <option v-for="cfg in videoConfigs" :key="cfg.id" :value="cfg.id">
                {{ cfg.name }} (id={{ cfg.id }})
              </option>
            </select>
          </div>
          <div v-if="createError" class="form-error">{{ createError }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="createModalOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="!canCreate || creating" @click="onCreate">
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  useBatchVideoSchedule,
  formatCountdown,
  type BatchVideoPlan,
} from '~/composables/useBatchVideoSchedule'
import { episodeAPI, aiConfigAPI } from '~/composables/useApi'
import { toast } from 'vue-sonner'

const props = defineProps<{ episodeId: number }>()

const { plans, loading, loadPlans, createPlan, cancelPlan } =
  useBatchVideoSchedule(() => props.episodeId)

const shots = ref<any[]>([])
async function loadShots() {
  try {
    const resp = (await episodeAPI.storyboards(props.episodeId)) as any
    shots.value = Array.isArray(resp) ? resp : resp?.data ?? []
  } catch (err: any) {
    toast.error('加载镜头失败: ' + (err?.message || String(err)))
    shots.value = []
  }
}

const videoConfigs = ref<any[]>([])
async function loadVideoConfigs() {
  try {
    const cfgs = (await aiConfigAPI.list()) as any
    const items = cfgs?.items || cfgs || []
    videoConfigs.value = items.filter(
      (c: any) => (c.service_type || c.serviceType) === 'video',
    )
  } catch {
    // ignore, 视频配置下拉为空, 不阻塞创建
  }
}

onMounted(() => {
  loadPlans()
  loadShots()
  loadVideoConfigs()
})

const createModalOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const createForm = ref({
  scheduledAtLocal: '', // YYYY-MM-DDTHH:MM (datetime-local format)
  shotIds: [] as number[],
  videoConfigId: null as number | null,
})

const canCreate = computed(
  () =>
    !!createForm.value.scheduledAtLocal &&
    createForm.value.shotIds.length > 0 &&
    !creating.value,
)

function openCreateModal() {
  const now = new Date()
  now.setMinutes(now.getMinutes() + 30)
  createForm.value.scheduledAtLocal = now.toISOString().slice(0, 16)
  createForm.value.shotIds = []
  createForm.value.videoConfigId = null
  createError.value = ''
  createModalOpen.value = true
}

function selectAllShots() {
  createForm.value.shotIds = shots.value.map((s) => s.id)
}
function selectNoneShots() {
  createForm.value.shotIds = []
}

async function onCreate() {
  if (!canCreate.value) return
  createError.value = ''
  creating.value = true
  try {
    // datetime-local 字符串 (本地时间, 无时区) → new Date() → toISOString() (UTC) 后端按 timezone Asia/Shanghai 解析
    const scheduled_at = new Date(createForm.value.scheduledAtLocal).toISOString()
    const plan = await createPlan({
      episode_id: props.episodeId,
      scheduled_at,
      shot_ids: createForm.value.shotIds,
      video_config_id: createForm.value.videoConfigId,
    })
    if (plan) createModalOpen.value = false
  } catch (err: any) {
    createError.value = err?.message || String(err)
  } finally {
    creating.value = false
  }
}

async function onCancel(id: number) {
  if (!confirm('确认取消此定时计划?')) return
  await cancelPlan(id)
}

function statusLabel(s: BatchVideoPlan['status']) {
  return (
    {
      pending: '待触发',
      running: '运行中',
      done: '已完成',
      failed: '失败',
      cancelled: '已取消',
    } as Record<string, string>
  )[s] || s
}

function formatDateTime(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  // 用 zh-CN locale + Asia/Shanghai 时区 (跟 scheduler 一致)
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
</script>

<style scoped>
.video-schedule-plan {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.section-sub {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}
.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--text-2);
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.plan-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.plan-table th,
.plan-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.plan-table th {
  background: var(--bg-0);
  font-weight: 600;
  color: var(--text-1);
}
.row-cancelled { opacity: 0.55; }
.row-running td { background: rgba(99, 102, 241, 0.05); }
.row-failed td { background: rgba(239, 68, 68, 0.05); }
.tag-pending { background: #fef3c7; color: #92400e; }
.tag-running { background: #dbeafe; color: #1d4ed8; }
.tag-done { background: #d1fae5; color: #065f46; }
.tag-failed { background: #fee2e2; color: #991b1b; }
.tag-cancelled { background: #f3f4f6; color: #6b7280; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; }
.dim { color: var(--text-2); }

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.modal {
  background: var(--bg-1, #fff);
  border-radius: 10px;
  width: 560px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}
.modal-head {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-title {
  font-weight: 600;
  font-size: 15px;
}
.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-row label {
  font-size: 12px;
  color: var(--text-1);
  font-weight: 500;
}
.form-row input,
.form-row select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-0);
  color: var(--text-0);
  font-size: 13px;
}
.shot-actions {
  display: flex;
  gap: 6px;
}
.shot-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}
.shot-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 4px;
}
.shot-item:hover { background: var(--bg-0); }
.shot-num {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-2);
  min-width: 30px;
}
.shot-title { flex: 1; }
.form-error {
  color: var(--error);
  font-size: 12px;
  padding: 6px 8px;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 4px;
}
</style>

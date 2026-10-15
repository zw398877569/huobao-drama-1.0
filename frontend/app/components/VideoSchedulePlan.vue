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
          <th>详情</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <!-- Sprint 10 v2 Task B: 主行 + 详情行 (expandable) 一起 for, click toggle expand -->
        <template v-for="p in plans" :key="p.id">
          <tr :class="`row-${p.status}`" style="cursor: pointer" @click="toggleExpand(p.id)">
            <td>{{ formatDateTime(p.scheduledAt) }}</td>
            <td>{{ formatCountdown(p.scheduledAt) }}</td>
            <td><span class="tag" :class="`tag-${p.status}`">{{ statusLabel(p.status) }}</span></td>
            <td>{{ p.shotCount }} 镜</td>
            <td>{{ p.successCount }} / {{ p.failedCount }}</td>
            <td>{{ p.videoConfigId ?? 'episode 锁定' }}</td>
            <td>
              <span class="expand-toggle">{{ expandedPlans.has(p.id) ? '▼' : '▶' }}</span>
            </td>
            <td @click.stop>
              <button
                v-if="p.status === 'pending'"
                class="btn btn-sm btn-ghost"
                style="color: var(--error)"
                @click="onCancel(p.id)"
              >取消</button>
              <span v-else class="dim">—</span>
            </td>
          </tr>
          <!-- 详情行: 只在展开时渲染 -->
          <tr v-if="expandedPlans.has(p.id) && parsePerShotStatus(p.perShotStatus).length > 0" class="row-detail">
            <td colspan="8">
              <div class="per-shot-detail">
                <div class="dim" style="margin-bottom: 6px;">per-shot 执行结果 ({{ p.successCount }} 成功 / {{ p.failedCount }} 失败):</div>
                <div v-for="shot in parsePerShotStatus(p.perShotStatus)" :key="shot.shot_id" class="per-shot-row">
                  <span class="mono">#{{ shot.shot_id }}</span>
                  <span v-if="shot.status === 'completed'" class="tag tag-done">✓ 成功</span>
                  <span v-else class="tag tag-failed">✗ 失败</span>
                  <span v-if="shot.video_generation_id" class="dim mono">vid={{ shot.video_generation_id }}</span>
                  <span v-if="shot.error" class="dim per-shot-error">{{ shot.error }}</span>
                </div>
              </div>
            </td>
          </tr>
        </template>
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
                <!-- 已生成/未生成标识 (sprint-10-v2 user 提需求, dev 直接做, 不走 PM 派单) -->
                <span v-if="sb.video_url || sb.videoUrl" class="tag tag-done" title="该 storyboard 已生成视频, 重新生成会覆盖">✓ 已生成</span>
                <span v-else class="tag tag-pending dim" title="未生成视频">○ 未生成</span>
                <span v-if="sb.duration" class="dim mono">{{ sb.duration }}s</span>
              </label>
              <div v-if="shots.length === 0" class="dim" style="padding: 12px">没有镜头可选</div>
            </div>
          </div>
          <div class="form-row">
            <label>视频配置 (可选, 默认走 MiniMax 官方推荐, fallback 用 episode 锁定)</label>
            <select v-model="createForm.videoConfigId">
              <!-- Sprint 10 v2 Task A (PM msg-20261014-002): 按 name 匹配『MiniMax 官方推荐』, 找不到才 fallback null (用 episode 锁定) -->
              <option v-if="defaultVideoConfig" :value="defaultVideoConfig.id">
                {{ defaultVideoConfig.name }} (id={{ defaultVideoConfig.id }}) (默认)
              </option>
              <option :value="null">用 episode 锁定</option>
              <option v-for="cfg in nonDefaultVideoConfigs" :key="cfg.id" :value="cfg.id">
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
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

// Sprint 10 v2 Task A (PM msg-20261014-002): 默认配置按『MiniMax 官方推荐』name 匹配
//   不用 hardcode id=9 (不同 DB 配置 id 不同), fallback 到 null (用 episode 锁定)
const defaultVideoConfig = computed<{ id: number; name: string } | null>(() => {
  const matched = videoConfigs.value.find((c: any) =>
    (c.name || '').includes('MiniMax官方推荐'),  // DB 实际命名无空格 (sprint-10-v2 verify user 实测 id=9 'MiniMax官方推荐-视频')
  )
  if (!matched) return null
  return { id: matched.id, name: matched.name }
})
// 非默认配置列表 (排除掉 defaultVideoConfig, 避免重复展示)
const nonDefaultVideoConfigs = computed(() => {
  const defId = defaultVideoConfig.value?.id
  return defId == null
    ? videoConfigs.value
    : videoConfigs.value.filter((c: any) => c.id !== defId)
})

// Sprint 10 v2 Task B: per-shot 详情展开
const expandedPlans = ref<Set<number>>(new Set())
function toggleExpand(planId: number) {
  if (expandedPlans.value.has(planId)) expandedPlans.value.delete(planId)
  else expandedPlans.value.add(planId)
  // 触发响应式 (Set 没自动 deep reactive, 重新赋值触发)
  expandedPlans.value = new Set(expandedPlans.value)
}
interface PerShotEntry {
  shot_id: number
  status: 'completed' | 'failed'
  video_generation_id?: number
  error?: string
}
function parsePerShotStatus(raw: string | null): PerShotEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Sprint 10 v2 Task D (PM msg-20261014-002): 进度轮询 5s, 只在有 running/pending plan 时启, 全 done/failed/cancelled 后停
//   节省请求; 普通 poll (不长轮询), 简单 setInterval
let pollTimer: ReturnType<typeof setInterval> | null = null
function startPolling() {
  if (pollTimer) return  // 已经在跑
  pollTimer = setInterval(() => {
    const hasActive = plans.value.some((p) => p.status === 'running' || p.status === 'pending')
    if (!hasActive) {
      // 全 done/failed/cancelled, 停轮询
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    loadPlans()
  }, 5000)
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

onMounted(() => {
  loadPlans()
  loadShots()
  loadVideoConfigs()
})

// 启动轮询: 初次加载完成后启 (后续 triggerPlan 也会 push 到 polling 表)
onMounted(() => {
  // 等 loadPlans 完成后再启轮询, 避免首次就跑了空列表
  setTimeout(startPolling, 100)
})

onBeforeUnmount(() => {
  stopPolling()
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
  // Bug D2 修: 默认时间用 Asia/Shanghai 本地时间 (datetime-local input 显示用户期望时间)
  //   修前: new Date().toISOString().slice(0,16) = UTC 字符串 (例 '2026-10-15T01:40' = 北京 9:40, 但 input 显示的是字面 01:40)
  //   修后: 直接拿本地 Date 字段, 拼成 datetime-local 接受的 'YYYY-MM-DDTHH:MM' 格式
  const now = new Date()
  now.setMinutes(now.getMinutes() + 30)
  // toISOString 转 UTC 然后取前 16 字符是 UTC 时间, 不是本地
  // 应该用本地时区格式化: getFullYear/getMonth/getDate/getHours/getMinutes 都返回本地时区
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const HH = String(now.getHours()).padStart(2, '0')
  const MM = String(now.getMinutes()).padStart(2, '0')
  createForm.value.scheduledAtLocal = `${yyyy}-${mm}-${dd}T${HH}:${MM}`
  createForm.value.shotIds = []
  // Sprint 10 v2 Task A: 默认用 MiniMax 官方推荐, 找不到才 null (用 episode 锁定)
  createForm.value.videoConfigId = defaultVideoConfig.value?.id ?? null
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
    // datetime-local 是 'YYYY-MM-DDTHH:MM' 格式 (浏览器本地时间, Asia/Shanghai), 拼秒让它成 ISO datetime 字符串
    // 不调 toISOString 避免转 UTC, 后端 isoToCron6 提取的字段直接是 Asia/Shanghai 本地时间
    // (修时区错配: 之前 new Date()+toISOString 转 UTC, cron timezone=Asia/Shanghai 解释错位 8 小时)
    const scheduled_at = createForm.value.scheduledAtLocal.length === 16
      ? createForm.value.scheduledAtLocal + ':00'
      : createForm.value.scheduledAtLocal
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
  // 智能判断: 跟后端 normalizeScheduledAt 一致
  //   - 有 Z 或 +HH:MM 时区后缀: UTC ISO, new Date 按 UTC 解析
  //   - 无后缀: 历史数据 (Bug D 修复前的 plan), 强制 +08:00 当 Asia/Shanghai 本地时间
  let d: Date
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    d = new Date(iso)
  } else {
    d = new Date(iso + '+08:00')
  }
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

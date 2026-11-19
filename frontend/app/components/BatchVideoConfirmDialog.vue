<!--
  BatchVideoConfirmDialog.vue — Sprint 55 T1 (PM msg-20261119-220)
  视频【批量视频】的确认窗: 选工作流 + 分辨率 + 本次会处理多少镜 (+ 费用估算)
  ★ 定时计划页 (VideoSchedulePlan.vue) 已有同款工作流下拉 → 这里保持同一套取法
-->
<template>
  <div v-if="show" class="modal-overlay" @click.self="emit('update:show', false)">
    <div class="modal">
      <div class="modal-head">
        <span class="modal-title">批量生成视频</span>
        <button class="btn btn-ghost btn-icon" @click="emit('update:show', false)">×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>视频配置</label>
          <select v-model="localConfigId">
            <option v-for="c in videoConfigs" :key="c.id" :value="c.id">
              {{ c.name }} (id={{ c.id }})
            </option>
          </select>
        </div>
        <div class="form-row">
          <label>工作流 (可选; 不选 = 用该配置的默认工作流)</label>
          <select v-model="localWorkflow" :disabled="workflowOptions.length === 0">
            <option value="">默认工作流 (自动选)</option>
            <option v-for="wf in workflowOptions" :key="wf.id" :value="wf.id">{{ wf.label }}</option>
          </select>
          <div v-if="workflowOptions.length === 0" class="dim" style="font-size:11px">
            该配置下面没有可选工作流 → 只能用它的默认工作流
          </div>
        </div>
        <div class="form-row">
          <label>分辨率档位</label>
          <select v-model="localResolution" :disabled="resolutionOptions.length === 0">
            <option v-for="t in resolutionOptions" :key="t" :value="t">{{ t }}</option>
          </select>
          <div v-if="resolutionOptions.length === 0" class="dim" style="font-size:11px">
            该工作流没有可选档位 → 用它的默认档
          </div>
        </div>
        <div class="batch-video-summary">
          本次将生成 <b>{{ targetCount }}</b> 个镜的 video (合计约 <b>{{ totalSeconds }}</b> 秒)
          <span v-if="targetCount <= 0" class="dim"> —— 当前没有需要生成的镜</span>
          <span v-if="estimateCny > 0" class="dim"> · 费用估算 ¥{{ estimateCny }} (按项目现有单镜重做口径, 仅供参考)</span>
        </div>
        <div class="dim" style="font-size:11px">
          ★ 只处理【还没有视频】的镜 (已生成过的不会被重跑); 取消则什么都不发生。
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="emit('update:show', false)">取消</button>
        <button class="btn btn-primary" :disabled="targetCount <= 0" @click="onConfirm">确认生成</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { getModelLabel } from '~/composables/useSettingsAi'
// ★ Sprint 55 T1: 金额用项目现有的 retake 成本口径 (单镜重做), 明确标注是估算
import { RETAKE_COST_CNY_PER_SHOT } from '~/composables/useStoryboardEdit'

const props = defineProps<{
  show: boolean
  /** 视频配置清单 (service_type === 'video') */
  videoConfigs: any[]
  /** 当前选中的配置 id */
  configId?: number | null
  /** 当前选中的工作流 (若已选) */
  workflow?: string | null
  /** 当前选中的分辨率档位 */
  resolution?: string | null
  /** 工作流 → 可选分辨率档位 (事实来源 = 后端 GET /videos/autodl-comfyui/resolutions) */
  resolutionTiers: Record<string, { tiers: string[]; defaultTier: string }>
  /** 本次会处理多少镜 */
  targetCount: number
  /** 合计秒数 */
  totalSeconds: number
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'confirm', payload: { configId: number | null; workflow: string; resolution: string | null }): void
}>()

const localConfigId = ref<number | null>(props.configId ?? null)
const localWorkflow = ref<string>(props.workflow || '')
const localResolution = ref<string>(props.resolution || '')

// 每次打开 → 用外部当前值重置 (用户上次的选择不该被悄悄带进下一次)
watch(() => props.show, (v) => {
  if (!v) return
  localConfigId.value = props.configId ?? null
  localWorkflow.value = props.workflow || ''
  localResolution.value = props.resolution || ''
})

const selectedConfig = computed<any>(() =>
  props.videoConfigs.find((c: any) => c.id === localConfigId.value) || null)

// ★ 工作流选项 = 该配置自己的 model 清单 (不写死常量), 与定时计划页同一套取法
const workflowOptions = computed<{ id: string; label: string }[]>(() => {
  const cfg = selectedConfig.value
  if (!cfg) return []
  let models: string[] = []
  const raw = cfg.model
  if (Array.isArray(raw)) {
    models = raw.filter((m: any) => typeof m === 'string' && m.trim())
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      models = Array.isArray(parsed) ? parsed.filter((m: any) => typeof m === 'string') : [raw]
    } catch {
      models = [raw]
    }
  }
  return models.map((m) => ({ id: m, label: getModelLabel(m, cfg.provider) }))
})

// 换工作流 → 分辨率档位跟着换 (档位的事实来源是后端)
watch([localWorkflow, localConfigId], () => {
  const wf = localWorkflow.value || props.workflow || ''
  const tiers = props.resolutionTiers?.[wf]?.tiers || []
  if (tiers.length && !tiers.includes(localResolution.value)) {
    localResolution.value = props.resolutionTiers?.[wf]?.defaultTier || tiers[0] || ''
  }
})

const resolutionOptions = computed<string[]>(() => {
  const wf = localWorkflow.value || props.workflow || ''
  return props.resolutionTiers?.[wf]?.tiers || []
})

const estimateCny = computed(() => {
  const n = props.targetCount || 0
  if (n <= 0) return 0
  return Math.round(RETAKE_COST_CNY_PER_SHOT * n * 100) / 100
})

function onConfirm() {
  emit('confirm', {
    configId: localConfigId.value,
    workflow: localWorkflow.value || '',
    resolution: localResolution.value || null,
  })
}
</script>

<style scoped>
.batch-video-summary {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-1);
}
</style>

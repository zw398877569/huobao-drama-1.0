<!--
  BatchVideoConfirmDialog.vue — Sprint 55 (单 220/221/222/223)
  视频【批量视频】的确认窗:
    - 选视频配置 (选项 = 全部 video 配置; 初始 = 顶部当前选的那个, 没有就清单第一个)
    - 选具体工作流 (选项 = 该配置自己的 model 清单; 默认 = 顶部当前的, 否则清单第一个【非 no_pic】)
    - 选分辨率档位 (跟着实际生效的工作流; 档位来源 = 后端映射)
    - ★ 勾选要生成哪几个镜 (默认全选, 实时更新 N 镜 / M 秒 / 费用估算)
    - ★ 没选配置 / 没选工作流 / 一个镜都没勾 → 确认按钮禁用 (绝不静默回落到默认配置的 model 清单第一个)
    - ★ 进度: 已提交 N / 共 M
-->
<template>
  <div v-if="show" class="modal-overlay" @click.self="emit('update:show', false)">
    <div class="modal batch-video-modal">
      <div class="modal-head">
        <span class="modal-title">批量生成视频</span>
        <button class="btn btn-ghost btn-icon" @click="emit('update:show', false)">×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>视频配置</label>
          <select v-model="localConfigId" class="input">
            <option v-for="c in videoConfigs" :key="c.id" :value="c.id">
              {{ c.name }} (id={{ c.id }}){{ c.provider ? ' · ' + c.provider : '' }}
            </option>
          </select>
          <div v-if="!videoConfigs.length" class="dim" style="font-size:11px">
            没有可用的视频配置 → 请先到【设置】里添加
          </div>
          <div v-else-if="selectedConfig?.base_url" class="dim" style="font-size:11px">
            接口地址: {{ selectedConfig.base_url }}
          </div>
        </div>

        <div class="form-row">
          <label>工作流</label>
          <select v-model="localWorkflow" class="input" :disabled="workflowOptions.length === 0">
            <option v-for="wf in workflowOptions" :key="wf.id" :value="wf.id">{{ wf.label }}</option>
          </select>
          <div v-if="workflowOptions.length === 0" class="dim" style="font-size:11px">
            该配置下面没有可选工作流 → 先换一个配置
          </div>
          <div v-else class="dim" style="font-size:11px">
            默认 = {{ defaultWorkflowLabel }}
            <span v-if="!hasPreferredWorkflow">（当前配置没有 {{ PREFERRED_DEFAULT_WORKFLOW }} → 回落：清单里第一个非"无图"工作流）</span>
            <span v-else>（最常用配置；顶部模型记忆不再决定这里的默认值）</span>
          </div>
        </div>

        <div class="form-row">
          <label>分辨率档位</label>
          <select v-model="localResolution" class="input" :disabled="resolutionOptions.length === 0">
            <option v-for="t in resolutionOptions" :key="t" :value="t">{{ t }}</option>
          </select>
          <div v-if="resolutionOptions.length === 0" class="dim" style="font-size:11px">
            该工作流没有可选档位 → 用它的默认档
          </div>
        </div>

        <div class="form-row">
          <label>
            要生成哪几个镜
            <span class="dim" style="font-weight:normal">（默认只勾【还没视频】的；勾上【已生成】的 = 重做，会覆盖原视频）</span>
          </label>
          <div class="batch-video-shots">
            <label v-for="sb in shots" :key="sb.id" class="batch-video-shot">
              <input type="checkbox" :value="sb.id" v-model="selectedShotIds" />
              <span class="mono">#{{ sb.storyboard_number ?? sb.storyboardNumber ?? sb.id }}</span>
              <span class="dim">{{ (sb.title || sb.description || '无标题').slice(0, 18) }}</span>
              <span class="dim mono">{{ sb.duration || 0 }}s</span>
              <span class="tag" :class="hasVideoOf(sb) ? 'tag-warning' : 'tag-info'">{{ hasVideoOf(sb) ? '已生成' : '待生成' }}</span>
            </label>
            <div v-if="!shots.length" class="dim" style="font-size:11px">
              本集没有镜头 → 没有可批量生成的内容
            </div>
          </div>
          <div v-if="shots.length" class="dim" style="font-size:11px">
            <button type="button" class="btn btn-sm" @click="selectAllShots">全选</button>
            <button type="button" class="btn btn-sm" @click="selectNoneShots">全不选</button>
            <button type="button" class="btn btn-sm" @click="selectPendingShots">只留待生成的 {{ pendingShots.length }} 个</button>
            <button type="button" class="btn btn-sm" @click="selectGeneratedShots">也选上已生成的 {{ generatedShots.length }} 个</button>
          </div>
        </div>

        <div class="batch-video-summary">
          本次将生成 <b>{{ selectedCount }}</b> 个镜的视频（合计约 <b>{{ selectedSeconds }}</b> 秒）
          <span v-if="estimateCny > 0" class="dim"> · 费用估算 ¥{{ estimateCny }}（按项目现有单镜重做口径，仅供参考）</span>
          <span v-if="running" class="dim"> · 已提交 {{ progress?.submitted ?? 0 }} / 共 {{ progress?.total ?? selectedCount }}</span>
        </div>

        <!-- ★ 2026-11-19: 勾了已有视频的镜 = 重做并覆盖 (破坏性 → 必须醒目告知) -->
        <div v-if="selectedGeneratedCount > 0 && !running" class="form-error">
          ★ 其中 <b>{{ selectedGeneratedCount }}</b> 个镜<b>已有视频</b> → 本次会【重做并覆盖】原视频（按次计费）；
          已经合成过的成片会过期（视频换新后需要重新合成）。
        </div>

        <div v-if="!canConfirm && !running" class="form-error">
          {{ confirmHint }}
        </div>
        <div v-else-if="!running" class="dim" style="font-size:11px">
          ★ 只处理你勾选的镜；取消则什么都不发生。
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" :disabled="running" @click="emit('update:show', false)">取消</button>
        <button class="btn btn-primary" :disabled="!canConfirm || running" @click="onConfirm">
          {{ running ? '生成中…' : `确认生成 ${selectedCount} 个镜` }}
        </button>
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
  /** 全部视频配置 (service_type === 'video') */
  videoConfigs: any[]
  /** 顶部当前选中的配置 id (可能为 null —— 用户从没在顶部模型弹层选过) */
  configId?: number | null
  /** 顶部当前选中的工作流 (可能为空) */
  workflow?: string | null
  /** 顶部当前选中的分辨率档位 */
  resolution?: string | null
  /** 工作流 → 可选分辨率档位 (事实来源 = 后端 GET /videos/autodl-comfyui/resolutions) */
  resolutionTiers: Record<string, { tiers: string[]; defaultTier: string }>
  /** 候选镜 (默认 = 还没有视频的镜) */
  shots: any[]
  /** 批量进度 (已提交 / 共 M) */
  progress?: { submitted: number; total: number } | null
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'confirm', payload: {
    configId: number | null
    workflow: string
    resolution: string | null
    shotIds: number[]
  }): void
}>()

const localConfigId = ref<number | null>(null)
const localWorkflow = ref<string>('')
const localResolution = ref<string>('')
const selectedShotIds = ref<number[]>([])
const running = ref(false)

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

/**
 * ★ Sprint 57 T2 (PM msg-20261123-225): 【默认工作流】固定成 minimax_h3_803
 *
 * ★ 为什么不看「顶部模型记忆」(props.workflow) 了:
 *   2026-11-23 事故后, 那个记忆里存的就是 minimax_h3_lightx2v_no_pic (无图模式)
 *   → 弹窗默认值会跟着变成无图模式 → 跑出来的效果不对还照样计费。
 *   ★ PM 拍板: minimax_h3_803 + 1088p 是【以后最常用的配置】, 弹窗默认就应该是它。
 *
 * 规则:
 *   ① 当前配置的清单里有 minimax_h3_803 → 用它
 *   ② 没有 → 回落「清单里第一个【非 no_pic】的」(no_pic 是无图模式, 会丢掉首尾帧参考)
 *   ③ 再没有 → 清单第一个
 *   ★ 绝不提交空: 空 = 后端没有显式 model → 单 222 起后端会直接拒绝 (4xx)
 */
const PREFERRED_DEFAULT_WORKFLOW = 'minimax_h3_803'
const defaultWorkflow = computed<string>(() => {
  const models = workflowOptions.value
  if (!models.length) return ''
  const preferred = models.find((m) => m.id === PREFERRED_DEFAULT_WORKFLOW)
  if (preferred) return preferred.id
  const notNoPic = models.find((m) => !/no_pic/.test(m.id))
  return (notNoPic || models[0]).id
})
/** ★ 当前配置里没有 803 (走了回落) → 界面上要说清楚回落到了哪一个 */
const hasPreferredWorkflow = computed(() =>
  workflowOptions.value.some((m) => m.id === PREFERRED_DEFAULT_WORKFLOW))
const defaultWorkflowLabel = computed<string>(() => {
  const hit = workflowOptions.value.find((m) => m.id === defaultWorkflow.value)
  return hit ? hit.label : '(无)'
})

// ★ 单 223 T1: 初始配置 = 顶部当前选的 (若有), 否则清单第一个 —— ★ 不能是 null (那会让下拉整个空掉)
const initialConfigId = computed<number | null>(() => {
  if (props.configId != null && props.videoConfigs.some((c: any) => c.id === props.configId)) return props.configId
  return props.videoConfigs.length ? props.videoConfigs[0].id : null
})

// 每次打开 → 重置 (用户上次的选择不该被悄悄带进下一次)
watch(() => props.show, (v) => {
  if (!v) return
  running.value = false
  localConfigId.value = initialConfigId.value
  localWorkflow.value = ''          // 下面 watch 会按新配置归位
  localResolution.value = props.resolution || ''
  // ★ 2026-11-19: 默认只勾【还没视频】的 (重做已有视频 = 覆盖 + 计费, 不默认勾)
  selectedShotIds.value = pendingShots.value.map((s: any) => s.id)
})

// 配置定下来 → 工作流/分辨率跟着归位
watch([localConfigId, workflowOptions], () => {
  const wf = defaultWorkflow.value
  localWorkflow.value = wf
  const tiers = props.resolutionTiers?.[wf]?.tiers || []
  localResolution.value = props.resolutionTiers?.[wf]?.defaultTier || tiers[0] || ''
})

// 实际生效的工作流 (永远是具体的)
const effectiveWorkflow = computed<string>(() => localWorkflow.value || defaultWorkflow.value)
const resolutionOptions = computed<string[]>(() =>
  props.resolutionTiers?.[effectiveWorkflow.value]?.tiers || [])

// ★ 2026-11-19: 该镜是否已有视频 (单镜『生成视频』对已有视频的镜也是直接覆盖 → 批量重做是同一条链路)
function hasVideoOf(sb: any): boolean {
  return !!(sb?.video_url || sb?.videoUrl)
}
/** 还没视频的镜 (默认勾选) */
const pendingShots = computed<any[]>(() => props.shots.filter((s: any) => !hasVideoOf(s)))
/** 已有视频的镜 (重做 → 要用户显式勾) */
const generatedShots = computed<any[]>(() => props.shots.filter((s: any) => hasVideoOf(s)))
// ★ 单 223 T2: 勾选状态
const selectedShots = computed<any[]>(() => {
  const set = new Set(selectedShotIds.value)
  return props.shots.filter((s: any) => set.has(s.id))
})
/** 勾选里有多少个是【重做已有视频】的 (破坏性 → 弹窗里醒目提示) */
const selectedGeneratedCount = computed(() => selectedShots.value.filter((s: any) => hasVideoOf(s)).length)
const selectedCount = computed(() => selectedShots.value.length)
const selectedSeconds = computed(() =>
  selectedShots.value.reduce((n: number, sb: any) => n + Number(sb?.duration || 0), 0))
const estimateCny = computed(() => {
  const n = selectedCount.value
  if (n <= 0) return 0
  return Math.round(RETAKE_COST_CNY_PER_SHOT * n * 100) / 100
})

function selectAllShots() {
  selectedShotIds.value = props.shots.map((s: any) => s.id)
}
function selectNoneShots() {
  selectedShotIds.value = []
}
/** 只留还没视频的 (默认状态) */
function selectPendingShots() {
  selectedShotIds.value = pendingShots.value.map((s: any) => s.id)
}
/** 也把已有视频的镜勾上 (= 批量重做, 会覆盖原视频) */
function selectGeneratedShots() {
  const set = new Set(selectedShotIds.value)
  for (const s of generatedShots.value) set.add(s.id)
  selectedShotIds.value = [...set]
}

// ★ 单 223 T1: 没选配置 / 没选工作流 / 一个镜都没勾 → 不允许确认 (绝不静默回落)
const canConfirm = computed(() =>
  !!localConfigId.value && !!localWorkflow.value && selectedCount.value > 0 && !running.value)
const confirmHint = computed(() => {
  if (!localConfigId.value) return '请先选择一个视频配置'
  if (!localWorkflow.value) return '该配置下面没有可选工作流 → 请换一个配置'
  if (selectedCount.value === 0) return '至少勾选一个要生成的镜'
  return ''
})

function onConfirm() {
  if (!canConfirm.value) return
  running.value = true
  emit('confirm', {
    configId: localConfigId.value,
    workflow: localWorkflow.value || defaultWorkflow.value || '',
    resolution: localResolution.value || null,
    shotIds: [...selectedShotIds.value],
  })
}
</script>

<style scoped>
/* ★ 弹窗基础样式 (与 BatchDownloadModal.vue / VideoSchedulePlan.vue 同一套设计 token)
   ★ 为什么要自带一份: .modal-overlay / .modal / .modal-head / .modal-body / .modal-foot /
     .form-row / .form-error 这些类只定义在 episode 页的 <style scoped> 里 —— scoped 样式
     跨组件不生效 → 本弹窗原来【没有遮罩、没有卡片底、没有排版】, 文字直接压在页面内容上
     (2026-11-19 用户实机截图发现) */
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
.modal-title { font-weight: 600; font-size: 15px; }
.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-row label { font-size: 12px; color: var(--text-1); font-weight: 500; }
.form-error { color: var(--error); font-size: 12px; }
.batch-video-modal { max-width: 640px; }
.batch-video-shots {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
}
.batch-video-shot {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; cursor: pointer;
}
.batch-video-shot input { margin: 0; cursor: pointer; }
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

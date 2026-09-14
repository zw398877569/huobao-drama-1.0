<script setup lang="ts">
/**
 * 通用模型选择弹窗 — 按 provider 分组,每个分组下展开 model 列表
 * 用于「制作 tab」临时切换图片 / 视频生成模型,值格式 "<configId>:<modelName>"
 *
 * Props:
 *   - show: 是否显示弹窗
 *   - title: 弹窗标题 (例 "选择图片模型" / "选择视频模型")
 *   - options: 二维分组,items 的 value 是 "<configId>:<modelName>" 复合格式
 *   - modelValue: 当前选中的 value, null = 未选
 *   - emptyText: 配置为空时的提示语
 *
 * Emits:
 *   - update:modelValue (string | null): 选择某项时传新值,「恢复默认」传 null
 *   - close: 用户关闭弹窗(点 X / 点遮罩 / 选中项后)
 */
export interface ModelOption {
  label: string
  value: string
}
export interface ModelGroup {
  group: string
  items: ModelOption[]
}

const props = withDefaults(defineProps<{
  show: boolean
  title: string
  options: ModelGroup[]
  modelValue: string | null
  emptyText?: string
}>(), {
  emptyText: '暂无模型配置，请先在设置中添加',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
  (e: 'close'): void
}>()

function select(value: string) {
  emit('update:modelValue', value)
  emit('close')
}

function reset() {
  emit('update:modelValue', null)
  emit('close')
}

function close() {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="model-popover-overlay" @click.self="close">
    <div class="model-popover-card">
      <div class="model-popover-head">
        <span class="model-popover-title">{{ title }}</span>
        <button class="btn btn-ghost btn-icon" @click="close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="model-popover-body">
        <div v-if="!options.length" class="model-popover-empty">{{ emptyText }}</div>
        <template v-else>
          <div v-for="group in options" :key="group.group" class="model-popover-group">
            <div class="model-popover-group-label">{{ group.group }}</div>
            <button
              v-for="opt in group.items"
              :key="opt.value"
              :class="['model-popover-item', { active: modelValue === opt.value }]"
              @click="select(opt.value)"
            >
              <span class="model-popover-item-name">{{ opt.label }}</span>
              <svg v-if="modelValue === opt.value" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
          </div>
        </template>
      </div>
      <div class="model-popover-foot">
        <button class="btn btn-sm" @click="reset">恢复默认</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-popover-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: fadeIn 0.15s ease;
}
.model-popover-card {
  background: var(--bg-0, #fff);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: scaleIn 0.15s ease;
}
.model-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, rgba(27, 41, 64, 0.08));
}
.model-popover-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0, #1a1a2e);
}
.model-popover-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.model-popover-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-3, #6b7280);
  font-size: 13px;
}
.model-popover-group {
  margin-bottom: 12px;
}
.model-popover-group:last-child {
  margin-bottom: 0;
}
.model-popover-group-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3, #6b7280);
  padding: 4px 8px 6px;
}
.model-popover-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-1, #1a1a2e);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}
.model-popover-item:hover {
  background: var(--accent-bg, rgba(99, 102, 241, 0.08));
  border-color: var(--accent, #6366f1);
  color: var(--accent, #6366f1);
}
.model-popover-item.active {
  background: var(--accent, #6366f1);
  border-color: var(--accent, #6366f1);
  color: #fff;
}
.model-popover-foot {
  padding: 12px 20px;
  border-top: 1px solid var(--border, rgba(27, 41, 64, 0.08));
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

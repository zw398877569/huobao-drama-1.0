<!--
  CharacterAppearanceEditor.vue
  2026-09-24 PM msg-20260924-002 task_D — 角色外貌编辑器 (PERMANENT 单 textarea)
  2026-10-10 PM msg-20261010-001 (V2 治本) — plot_state 已从 character 表移除 (移到 per-shot storyboards.image_prompt_plot_state),
    编辑器只保留 PERMANENT 字段; 不再有 appearancePlotState / appearance (deprecated) 字段。

  Props:
    modelValue: { appearancePermanent?: string }
  Emits:
    update:modelValue: { appearancePermanent }
    validityChange: boolean (true if PERMANENT 校验通过)

  校验:
    - appearancePermanent 必填 (非空)
    - appearancePermanent 含 '早期/中期/后期/高潮/衰亡' → 红字提示, 阻止保存
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: {
    appearancePermanent?: string
  }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: { appearancePermanent: string }]
  'validityChange': [valid: boolean]
}>()

const PLOT_KEYWORDS = ['早期', '中期', '后期', '高潮', '衰亡']

const permanent = ref<string>(props.modelValue.appearancePermanent || '')

// 监听 props 变化 (页面初始加载后, 父组件可能补传数据)
watch(() => props.modelValue.appearancePermanent, () => {
  if (!permanent.value) {
    permanent.value = props.modelValue.appearancePermanent || ''
  }
})

// 校验: PERMANENT 含 plot 关键词 → invalid
const permanentHasPlotKeyword = computed(() => {
  if (!permanent.value) return false
  return PLOT_KEYWORDS.some(kw => permanent.value.includes(kw))
})

// 校验: PERMANENT 必填
const permanentEmpty = computed(() => !permanent.value || !permanent.value.trim())

const isValid = computed(() => !permanentEmpty.value && !permanentHasPlotKeyword.value)

// 模板里双向绑定到 textarea (受控)
const onPermanentInput = (e: Event) => {
  permanent.value = (e.target as HTMLTextAreaElement).value
}

// 通知父组件
watch([permanent, isValid], () => {
  emit('update:modelValue', {
    appearancePermanent: permanent.value,
  })
  emit('validityChange', isValid.value)
}, { immediate: true, deep: true })
</script>

<template>
  <div class="character-appearance-editor">
    <div class="field">
      <label class="field-label">
        永久外貌 <span class="required">*</span>
        <span class="field-hint">年龄 / 脸型 / 发色 / 体型 / 服装基准</span>
      </label>
      <textarea
        class="textarea"
        :class="{ 'is-invalid': permanentHasPlotKeyword || permanentEmpty }"
        :value="permanent"
        @input="onPermanentInput"
        rows="4"
        placeholder="35 岁东亚男性, 国字脸带柔和下颌线, 短发凌乱油腻贴在额前, 灰色旧夹克内搭褪色白 T 恤"
      />
      <p v-if="permanentEmpty" class="hint hint-error">永久外貌必填, 否则角色立绘没有视觉身份</p>
      <p v-if="permanentHasPlotKeyword" class="hint hint-error">
        plot 阶段描述 (早期/中期/后期/高潮/衰亡) 不属于 PERMANENT 字段, 请清除 (V2 治本后 plot_state 已从 character 表移除, 改由 storyboard per-shot 表达)
      </p>
    </div>

  </div>
</template>

<style scoped>
.character-appearance-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #1a1a1a);
}
.required {
  color: #dc2626;
}
.field-optional {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #666);
}
.field-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #999);
}
.textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border, #d4d4d8);
  border-radius: 6px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  resize: vertical;
  background: var(--bg-input, #fff);
  color: var(--text-primary, #1a1a1a);
  box-sizing: border-box;
}
.textarea:focus {
  outline: none;
  border-color: var(--accent, #3b82f6);
}
.textarea.is-invalid {
  border-color: #dc2626;
  background: #fef2f2;
}
.hint {
  font-size: 12px;
  color: var(--text-secondary, #666);
  margin: 0;
}
.hint-error {
  color: #dc2626;
}

</style>

<!--
  CharacterAppearanceEditor.vue
  2026-09-24 PM msg-20260924-002 task_D — 角色外貌编辑器 (PERMANENT + PLOT_STATE 双 textarea)

  Props:
    modelValue: { appearancePermanent?: string; appearancePlotState?: string; appearance?: string }
  Emits:
    update:modelValue: { appearancePermanent, appearancePlotState, appearance (deprecated) }
    validityChange: boolean (true if PERMANENT 校验通过)

  校验:
    - appearancePermanent 必填 (非空)
    - appearancePermanent 含 '早期/中期/后期/高潮/衰亡' → 红字提示, 阻止保存

  兼容:
    - 旧角色只填了 appearance 没填 permanent 时, 父组件读 appearance 优先, 落空才读 appearance (deprecated)
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: {
    appearancePermanent?: string
    appearancePlotState?: string
    appearance?: string
  }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: { appearancePermanent: string; appearancePlotState: string; appearance: string }]
  'validityChange': [valid: boolean]
}>()

const PLOT_KEYWORDS = ['早期', '中期', '后期', '高潮', '衰亡']

// 父组件传的可能是 appearance 旧字段 (deprecated), 让用户能继续编辑老角色
const legacyAppearance = computed(() => props.modelValue.appearance || '')

const permanent = ref<string>(props.modelValue.appearancePermanent || legacyAppearance.value || '')
const plotStateJson = ref<string>(props.modelValue.appearancePlotState || '')

// 监听 props 变化 (页面初始加载后, 父组件可能补传数据)
watch(() => [props.modelValue.appearancePermanent, props.modelValue.appearance], () => {
  if (!permanent.value) {
    permanent.value = props.modelValue.appearancePermanent || props.modelValue.appearance || ''
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

// 把 plotState JSON 解析为友好提示
const plotStateEntries = computed(() => {
  if (!plotStateJson.value.trim()) return []
  try {
    const obj = JSON.parse(plotStateJson.value)
    return Object.entries(obj)
  } catch {
    return []
  }
})

// 模板里双向绑定到 textarea (受控)
const onPermanentInput = (e: Event) => {
  permanent.value = (e.target as HTMLTextAreaElement).value
}

const onPlotStateInput = (e: Event) => {
  plotStateJson.value = (e.target as HTMLTextAreaElement).value
}

// 通知父组件
watch([permanent, plotStateJson, isValid], () => {
  emit('update:modelValue', {
    appearancePermanent: permanent.value,
    appearancePlotState: plotStateJson.value,
    appearance: permanent.value, // deprecated 同步, 让父组件可一次 PUT 三字段全 ok
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
        plot 阶段描述 (早期/中期/后期/高潮/衰亡) 请移到下方「剧情态变化」框
      </p>
    </div>

    <div class="field">
      <label class="field-label">
        剧情态变化 <span class="field-optional">(可选)</span>
        <span class="field-hint">按剧情阶段分段的视觉变化 — JSON 格式</span>
      </label>
      <textarea
        class="textarea"
        :value="plotStateJson"
        @input="onPlotStateInput"
        rows="6"
        placeholder='{"铺垫":"面色苍白, 嘴唇干裂","高潮":"瘦得皮包骨头","余韵":"面如死灰"}'
      />
      <p class="hint">可选。键名 = 意图函数 (铺垫/揭露/反转/高潮/余韵/悬念), 值 = 该阶段的文字描述。</p>
      <div v-if="plotStateEntries.length > 0" class="preview">
        <p class="preview-title">预览:</p>
        <ul class="preview-list">
          <li v-for="[key, val] in plotStateEntries" :key="key" class="preview-item">
            <span class="preview-key">{{ key }}</span>: <span class="preview-val">{{ val }}</span>
          </li>
        </ul>
      </div>
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
.preview {
  background: var(--bg-secondary, #f4f4f5);
  border-radius: 6px;
  padding: 8px 12px;
  margin-top: 4px;
}
.preview-title {
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: var(--text-secondary, #666);
}
.preview-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.preview-item {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary, #1a1a1a);
}
.preview-key {
  font-weight: 600;
  color: var(--accent, #3b82f6);
}
.preview-val {
  color: var(--text-secondary, #555);
}
</style>

<!--
  /characters/[id] — 角色编辑页 (2026-09-24 PM msg-20260924-002 task_D)
  - 加载角色 → 编辑外貌 (PERMANENT + PLOT_STATE) → 保存
  - 校验失败禁用保存按钮 (CharacterAppearanceEditor 暴露 validityChange)
  - 不动的字段: 暂不暴露 voice/role 等, 后续按角色管理需求扩展
-->
<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { characterAPI } from '~/composables/useApi'

const route = useRoute()
const characterId = Number(route.params.id)

const loading = ref(true)
const saving = ref(false)
const isValid = ref(false)
const character = ref<any>(null)
const appearanceData = ref<{ appearancePermanent: string; appearancePlotState: string; appearance: string }>({
  appearancePermanent: '',
  appearancePlotState: '',
  appearance: '',
})

const loadCharacter = async () => {
  loading.value = true
  try {
    const data: any = await characterAPI.get(characterId)
    character.value = data
    appearanceData.value = {
      appearancePermanent: data.appearance_permanent || '',
      appearancePlotState: data.appearance_plot_state || '',
      appearance: data.appearance || '',
    }
  } catch (err: any) {
    toast.error(err?.message || '加载角色失败')
  } finally {
    loading.value = false
  }
}

const onUpdateAppearance = (val: { appearancePermanent: string; appearancePlotState: string; appearance: string }) => {
  appearanceData.value = val
}

const onValidityChange = (valid: boolean) => {
  isValid.value = valid
}

const canSave = computed(() => isValid.value && !saving.value)

const save = async () => {
  if (!canSave.value) return
  saving.value = true
  try {
    await characterAPI.update(characterId, {
      appearance_permanent: appearanceData.value.appearancePermanent,
      appearance_plot_state: appearanceData.value.appearancePlotState,
      appearance: appearanceData.value.appearancePermanent, // deprecated 同步, 兼容老前端读 .appearance
    })
    toast.success('角色外貌已保存')
  } catch (err: any) {
    toast.error(err?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

const goBack = () => {
  history.length > 1
    ? history.back()
    : (window.location.href = '/')
}

onMounted(() => {
  loadCharacter()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <button class="btn btn-ghost" @click="goBack">← 返回</button>
      <div class="head-info">
        <h1 class="page-title">角色外貌编辑</h1>
        <p v-if="character" class="page-meta">
          ID {{ character.id }} ·
          <span v-if="character.name">{{ character.name }}</span>
          <span v-else>未命名角色</span>
        </p>
      </div>
    </header>

    <main class="main">
      <div v-if="loading" class="state">加载中...</div>
      <div v-else-if="!character" class="state state-error">角色不存在或已被删除</div>
      <div v-else class="card">
        <div class="card-head">
          <h2 class="card-title">外貌描述</h2>
          <p class="card-desc">永久外貌是角色立绘的视觉身份;剧情态变化用于镜头图按剧情阶段切换视觉状态。</p>
        </div>
        <div class="card-body">
          <CharacterAppearanceEditor
            :model-value="appearanceData"
            @update:model-value="onUpdateAppearance"
            @validity-change="onValidityChange"
          />
        </div>
        <div class="card-foot">
          <button class="btn btn-primary" :disabled="!canSave" @click="save">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
}
.page-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.head-info {
  flex: 1;
}
.page-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary, #1a1a1a);
}
.page-meta {
  font-size: 13px;
  color: var(--text-secondary, #666);
  margin: 4px 0 0 0;
}
.main {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.state {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary, #666);
  background: var(--bg-secondary, #f4f4f5);
  border-radius: 8px;
}
.state-error {
  color: #dc2626;
  background: #fef2f2;
}
.card {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  padding: 24px;
}
.card-head {
  margin-bottom: 20px;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: var(--text-primary, #1a1a1a);
}
.card-desc {
  font-size: 13px;
  color: var(--text-secondary, #666);
  margin: 0;
}
.card-body {
  margin-bottom: 20px;
}
.card-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-ghost {
  background: transparent;
  color: var(--text-secondary, #666);
}
.btn-ghost:hover {
  background: var(--bg-secondary, #f4f4f5);
}
.btn-primary {
  background: var(--accent, #3b82f6);
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover, #2563eb);
}
.btn-primary:disabled {
  background: var(--bg-disabled, #d4d4d8);
  cursor: not-allowed;
  opacity: 0.7;
}
</style>

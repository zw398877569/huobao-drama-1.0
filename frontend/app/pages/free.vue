<script setup lang="ts">
/**
 * /free — 自由创作 (独立功能页)
 *
 * ★ Sprint 26 Task A (PM msg-20261027-121): 原来自由创作是 episode 页『导出』区的子 tab,
 *   2026-10-27 用户要求「放到任务后面, 这属于一个独立的功能了算是」→ 提升为顶层页面。
 *   PM 拍板 D1: 【移走, 不是复制】—— episode 页导出区的子 tab 同时移除。
 *
 * 组件本身不依赖 episode 上下文 (只吃一个 configs prop + videoAPI) → 原样复用, 不改组件。
 * 配置自己取: aiConfigAPI.list('video') —— 【不要】用 useConfigLoading 的 videoConfigs,
 *   那个是 episode 上下文绑定的, 独立页用不了。
 */
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { aiConfigAPI } from '~/composables/useApi'

const videoConfigs = ref<any[]>([])
const loading = ref(true)

async function loadConfigs() {
  loading.value = true
  try {
    const cfgs = await aiConfigAPI.list('video')
    videoConfigs.value = (cfgs as any) || []
  } catch (e: any) {
    toast.error(e?.message || '加载视频模型配置失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadConfigs)
</script>

<template>
  <div class="free-page">
    <div class="free-page-header">
      <h1 class="free-page-title">自由创作</h1>
      <p class="free-page-desc">用已保存的视频模型配置直接生成视频, 不需要先拆解分镜。</p>
    </div>

    <div v-if="loading" class="free-page-hint">加载视频模型配置中…</div>
    <FreeCreationPanel v-else :configs="videoConfigs" />
  </div>
</template>

<style scoped>
.free-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.free-page-header {
  padding: 18px 20px 4px;
}

.free-page-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-1);
}

.free-page-desc {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.free-page-hint {
  padding: 30px 20px;
  font-size: 12.5px;
  color: var(--text-3);
}
</style>

<template>
  <div v-if="open" class="modal-overlay" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <span class="modal-title">{{ title }}</span>
        <button class="btn btn-ghost btn-icon" @click="close" :disabled="downloading">×</button>
      </div>

      <div class="modal-body">
        <div v-if="downloadable.length === 0" class="dim" style="padding: 24px; text-align: center">
          没有可下载的视频
        </div>

        <template v-else>
          <div class="list-toolbar">
            <label class="select-all">
              <input type="checkbox" :checked="allSelected" @change="toggleAll" />
              <span>全选 ({{ selectedIds.length }} / {{ downloadable.length }})</span>
            </label>
          </div>

          <div class="shot-list">
            <label
              v-for="shot in downloadable"
              :key="shot.id"
              class="shot-item"
              :class="{ disabled: downloading }"
            >
              <input
                type="checkbox"
                :value="shot.id"
                v-model="selectedIds"
                :disabled="downloading"
              />
              <span class="shot-num mono">#{{ padNum(shot.storyboardNumber) }}</span>
              <span class="shot-title">{{ shot.description || '无描述' }}</span>
              <span v-if="shot.duration" class="dim mono">{{ shot.duration }}s</span>
            </label>
          </div>

          <div v-if="failedIds.length > 0" class="fail-tip">
            {{ failedIds.length }} 个文件下载失败，已跳过：{{ failedIds.map(f => '#' + f).join(', ') }}
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <span class="dim">
          {{ selectedIds.length > 0 ? `已选 ${selectedIds.length} 个` : '未选择' }}
          <template v-if="selectedIds.length > 20"> · 数量较多，打包需要一点时间</template>
        </span>
        <div class="foot-actions">
          <button class="btn btn-ghost" @click="close" :disabled="downloading">取消</button>
          <button class="btn btn-primary" :disabled="downloading || selectedIds.length === 0" @click="startDownload">
            {{ downloading ? `打包中… ${doneCount}/${selectedIds.length}` : `下载选中 (${selectedIds.length})` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * BatchDownloadModal — 批量下载视频弹窗 (Sprint 13 Task C+D, PM msg-20261019-073)
 *
 * 为什么必须打包成 zip 而不是循环 <a download>:
 *   Chrome/Edge/Safari 对「非用户手势触发」的连续下载会拦截 —— 一次点全选下载 11 个文件,
 *   通常只有第 1 个真的下下来, 其余被静默阻止, 用户表现为「点了没反应」。
 *   触发次数越多拦截越严。所以必须 JSZip 打包成一个 zip 下载 (一次请求一个文件, 唯一用户手势)。
 *
 * 内存注意: 11 镜 × 15MB ≈ 165MB, 峰值可能更高。必须用 streamFiles: true 降低峰值。
 */
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import JSZip from 'jszip'

interface ShotItem {
  id: number
  storyboardNumber?: number | null
  description?: string | null
  duration?: number | null
  /** 静态资源相对路径, 如 'videos/<uuid>.mp4' 或 'composed/<uuid>.mp4' */
  url: string
}

const props = defineProps<{
  open: boolean
  title: string
  shots: ShotItem[]
  /** 文件名前缀, 如 '第01集' */
  episodeLabel: string
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const selectedIds = ref<number[]>([])
const downloading = ref(false)
const doneCount = ref(0)
const failedIds = ref<number[]>([])

// 只列有 url 的镜头 (没生成的不该出现在下载列表里)
const downloadable = computed(() => props.shots.filter(s => !!s.url))
const allSelected = computed(
  () => downloadable.value.length > 0 && selectedIds.value.length === downloadable.value.length,
)

watch(() => props.open, (v) => {
  if (v) {
    // 打开时默认全选 (用户点开就是想下载, 省一次点击)
    selectedIds.value = downloadable.value.map(s => s.id)
    doneCount.value = 0
    failedIds.value = []
  }
})

function close() {
  if (downloading.value) return
  emit('update:open', false)
}

function toggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  selectedIds.value = checked ? downloadable.value.map(s => s.id) : []
}

function padNum(n?: number | null): string {
  return String(n ?? 0).padStart(2, '0')
}

/** 过滤 Windows 非法文件名字符 (/\:*?"<>|) */
function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/** 生成 zip 内文件名: 第01集_镜头03_描述前12字.mp4 (用户 2026-10-19 拍板 D3) */
function buildFilename(shot: ShotItem): string {
  const desc = (shot.description || '视频').slice(0, 12)
  return sanitizeFilename(`${props.episodeLabel}_镜头${padNum(shot.storyboardNumber)}_${desc}.mp4`)
}

function extractUrlPath(url: string): string {
  // ⚠️ 修法要点 (2026-10-20 用户实测踩坑): localPath 实际格式是 'static/videos/<uuid>.mp4'
  //   (带 static/ 前缀), 静态服务挂载点 app.use('/static/*', serveStatic({root: data}))。
  //   之前这里把 'static/' 前缀剥掉了 → 请求 '/videos/x.mp4' → 404 →
  //   zip 里全是 976 B 的错误页而不是视频 (用户截图确认每个文件都是 976 B)。
  //   现在只补前导 '/', 保留 static/ 前缀。
  if (url.startsWith('http')) {
    // 完整外网 URL (video_generations.videoUrl, 带 TOS 签名有时效):
    //   不剥 query (签名在 query 里), 直接用原 URL fetch。
    //   正常情况 storyboards.video_url 存的是 localPath, 不会走到这个分支;
    //   万一走到, 跨域由三方端点自己决定 (本地已存档, 正常不依赖这条路径)。
    return url
  }
  return `/${url.replace(/^\/+/, '')}`
}

async function startDownload() {
  const targets = downloadable.value.filter(s => selectedIds.value.includes(s.id))
  if (targets.length === 0) return

  downloading.value = true
  doneCount.value = 0
  failedIds.value = []
  try {
    const zip = new JSZip()
    for (const shot of targets) {
      try {
        const resp = await fetch(extractUrlPath(shot.url))
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        // ⚠️ content-type 校验 (2026-10-20 用户实测踩坑):
        //   URL 打错时静态服务会 fallback 到 index.html, 返回 200 + text/html (976 B)。
        //   只看 resp.ok 判断不出来 —— 垃圾页会被当成视频打进 zip。
        //   所以必须校验 content-type 是 video/* (或 application/octet-stream), 否则判失败跳过。
        const contentType = (resp.headers.get('content-type') || '').toLowerCase()
        const looksLikeVideo = contentType.startsWith('video/')
          || contentType === 'application/octet-stream'
          || contentType.startsWith('application/mp4')
        if (!looksLikeVideo) {
          throw new Error(`not a video (content-type: ${contentType || 'unknown'})`)
        }
        const blob = await resp.blob()
        zip.file(buildFilename(shot), blob)
      } catch {
        // 单个失败跳过, 不整个崩掉 (工单明确要求)
        failedIds.value = [...failedIds.value, shot.id]
      }
      doneCount.value++
    }

    if (Object.keys(zip.files).length === 0) {
      toast.error('所有文件下载失败，请稍后重试')
      return
    }

    toast.info(`正在打包 ${Object.keys(zip.files).length} 个视频…`)
    const blob = await zip.generateAsync({
      type: 'blob',
      streamFiles: true, // 关键: 降低 165MB 量级的内存峰值
    })
    const zipName = sanitizeFilename(`${props.episodeLabel}_视频.zip`)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = zipName
    a.click()
    // 延迟 revoke, 否则部分浏览器下载还没开始读 blob 就被释放
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000)

    if (failedIds.value.length > 0) {
      toast.warn(`${failedIds.value.length} 个文件下载失败，已跳过`)
      emit('update:open', false)
    } else {
      toast.success(`已打包 ${Object.keys(zip.files).length} 个视频`)
      emit('update:open', false)
    }
  } catch (err: any) {
    toast.error('打包失败: ' + (err?.message || err))
  } finally {
    downloading.value = false
    doneCount.value = 0
  }
}
</script>

<style scoped>
/* modal 样式对齐 VideoSchedulePlan.vue 的 modal-overlay/modal/modal-head/modal-title/modal-body/modal-foot
   (那份是 scoped CSS, 无法跨组件复用, 这里按同一套设计 token 复刻一份保持视觉统一) */
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
  flex: 1;
}
.modal-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.foot-actions {
  display: flex;
  gap: 8px;
}
.list-toolbar {
  margin-bottom: 10px;
}
.select-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
}
.shot-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 46vh;
  overflow-y: auto;
}
.shot-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.shot-item:hover {
  background: var(--bg-2, #f8f9fa);
}
.shot-item.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.shot-num {
  min-width: 42px;
  color: var(--text-dim);
}
.shot-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fail-tip {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255, 138, 0, 0.08);
  border: 1px solid rgba(255, 138, 0, 0.1);
  border-radius: 6px;
  font-size: 12px;
  color: #b26a00;
}
</style>

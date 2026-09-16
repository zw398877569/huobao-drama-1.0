<script setup lang="ts">
/**
 * FreeCreationPanel — 导出区「自由创作」子页
 *
 * 不依赖分镜数据; 用户从已保存的 video config 里挑一个, 填表生成, 预览下载。
 * 落 video_generations 表 (source='free'), 不会污染正式分镜的视频列表。
 *
 * 模式可用性 (按 model 动态暴露):
 *   - MiniMax-Hailuo-2.3 / 2.3-Fast: T2V + I2V (FL2V 不支持)
 *   - MiniMax-Hailuo-02 / I2V-01*:    T2V + I2V (+ FL2V 仅有 02)
 *   - MiniMax-H3 / H3-Max:            T2V + I2V (+ FL2V 占位待补)
 *
 * 时长:
 *   - Hailuo-* : [6, 10] (snap, 由 adapter 处理)
 *   - H3       : 4..15 整数
 *
 * 分辨率:
 *   - T2V 必填, 由用户选 (adapter 内部固定 768P 之类; 自由创作里给常见档位让用户选)
 *   - I2V/FL2V 由首帧决定, 不需要
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { videoAPI } from '~/composables/useApi'
import { toast } from 'vue-sonner'

const props = defineProps<{
  configs: Array<{
    id: number
    name: string
    provider: string
    model: any
    base_url?: string
    baseUrl?: string
    api_key?: string
    apiKey?: string
    is_active?: boolean
  }>
}>()

// ======== 模型能力定义 ========
// model 前缀 -> {modes: [], durations: [], resolutions: [], supportsFl2v, supportsMultiRef}
const MODEL_CAPS: Record<string, { modes: ('t2v'|'i2v'|'fl2v')[], durations: number[], resolutions: string[], ratios: string[] }> = {
  'MiniMax-Hailuo-2.3':     { modes: ['t2v', 'i2v'],        durations: [6, 10],                resolutions: ['768P', '1080P'],           ratios: ['16:9','9:16','1:1'] },
  'MiniMax-Hailuo-2.3-Fast':{ modes: ['t2v', 'i2v'],        durations: [6, 10],                resolutions: ['768P', '1080P'],           ratios: ['16:9','9:16','1:1'] },
  'MiniMax-Hailuo-02':      { modes: ['t2v', 'i2v', 'fl2v'], durations: [6, 10],                resolutions: ['512P', '768P', '1080P'],    ratios: ['16:9','9:16','1:1','4:3','3:4','21:9'] },
  'MiniMax-H3':             { modes: ['t2v', 'i2v', 'fl2v'], durations: [4,5,6,7,8,9,10,11,12,13,14,15], resolutions: ['768P', '2K'], ratios: ['21:9','16:9','4:3','1:1','3:4','9:16'] },
  'MiniMax-H3-Max':         { modes: ['t2v', 'i2v', 'fl2v'], durations: [5,6,7,8,9,10,11,12,13,14,15], resolutions: ['480P', '768P'], ratios: ['21:9','16:9','4:3','1:1','3:4','9:16'] },
}

const DEFAULT_CAPS = { modes: ['t2v', 'i2v'] as ('t2v'|'i2v'|'fl2v')[], durations: [6, 10], resolutions: ['768P'], ratios: ['16:9','9:16','1:1'] }

function capsFor(model: string) {
  return MODEL_CAPS[model] || DEFAULT_CAPS
}

// ======== 活跃配置 ========
// 解析 props.configs 里的 model 字段 (可能是 JSON 数组或单个字符串)
const configOptions = computed(() => {
  const opts: Array<{ configId: number, model: string, label: string, provider: string, disabled?: boolean }> = []
  for (const c of (props.configs || [])) {
    let models: string[] = []
    if (Array.isArray(c.model)) {
      models = c.model.filter((m: any) => typeof m === 'string' && m.trim())
    } else if (typeof c.model === 'string' && c.model) {
      try {
        const parsed = JSON.parse(c.model)
        models = Array.isArray(parsed) ? parsed.filter((m: any) => typeof m === 'string') : [c.model]
      } catch { models = [c.model] }
    }
    if (!models.length) continue
    for (const m of models) {
      const suffix = c.is_active === false ? ' · 已停用' : ''
      opts.push({ configId: c.id, model: m, label: `${c.name} · ${m} (${c.provider})${suffix}`, provider: c.provider, disabled: c.is_active === false })
    }
  }
  return opts
})

const selectedKey = ref<string>('') // 格式: "<configId>:<model>"
const selectedConfig = computed(() => {
  if (!selectedKey.value) return null
  const [cidStr, model] = selectedKey.value.split(':')
  const cid = Number(cidStr)
  return { configId: cid, model, config: props.configs.find(c => c.id === cid) }
})

const currentCaps = computed(() => selectedConfig.value ? capsFor(selectedConfig.value.model) : DEFAULT_CAPS)

// 切换 config 时, 如果当前 referenceMode 不被新 model 支持, 重置为 't2v'
function onConfigChange(key: string) {
  selectedKey.value = key
  if (!key) return
  const [, model] = key.split(':')
  const caps = capsFor(model)
  if (!caps.modes.includes(referenceMode.value as any)) {
    referenceMode.value = 't2v'
  }
  // duration / resolution 兜底
  if (!caps.durations.includes(duration.value)) {
    duration.value = caps.durations[0]
  }
  if (!caps.resolutions.includes(resolution.value)) {
    resolution.value = caps.resolutions[0]
  }
}

// ======== 表单 state ========
const referenceMode = ref<'t2v' | 'i2v' | 'fl2v'>('t2v')
const prompt = ref('')
const duration = ref(6)
const resolution = ref('768P')
const aspectRatio = ref('16:9')
const firstFrameUrl = ref<string>('')
const lastFrameUrl = ref<string>('')
const negativePrompt = ref('')

// 选项列表 (随 caps 动态更新)
const availableModes = computed(() => currentCaps.value.modes)
const availableDurations = computed(() => currentCaps.value.durations)
const availableResolutions = computed(() => currentCaps.value.resolutions)
const availableRatios = computed(() => currentCaps.value.ratios)

// 上传
const uploadingFirst = ref(false)
const uploadingLast = ref(false)
async function uploadImage(file: File, target: 'first' | 'last') {
  if (target === 'first') uploadingFirst.value = true
  else uploadingLast.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    const resp = await fetch('/api/v1/upload/image', { method: 'POST', body: fd })
    const json = await resp.json()
    if (!resp.ok || (json.code && json.code >= 400)) throw new Error(json.message || `upload failed ${resp.status}`)
    const url = json.data?.url || json.url
    if (!url) throw new Error('upload response missing url')
    if (target === 'first') firstFrameUrl.value = url
    else lastFrameUrl.value = url
    toast.success('上传成功')
  } catch (e: any) {
    toast.error(`上传失败: ${e.message || e}`)
  } finally {
    if (target === 'first') uploadingFirst.value = false
    else uploadingLast.value = false
  }
}

function onFileChange(e: Event, target: 'first' | 'last') {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!/^image\//.test(file.type)) {
    toast.error('请选择图片文件')
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    toast.error('图片不能超过 20MB')
    return
  }
  uploadImage(file, target)
}

function pasteUrl(url: string, target: 'first' | 'last') {
  const trimmed = url.trim()
  if (!trimmed) return
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) {
    toast.error('URL 必须以 http(s):// 开头, 或 / 开头的本地路径')
    return
  }
  if (target === 'first') firstFrameUrl.value = trimmed
  else lastFrameUrl.value = trimmed
}

// ======== 提交 ========
const submitting = ref(false)
const currentJob = ref<any | null>(null)
const resultUrl = ref<string>('')        // 完成后视频的展示 URL (从 localPath 或 videoUrl 构造)
const errorMsg = ref<string>('')
let pollTimer: number | null = null

const canSubmit = computed(() => {
  if (!selectedKey.value) return false
  if (!prompt.value.trim()) return false
  if (referenceMode.value === 'i2v' || referenceMode.value === 'fl2v') {
    if (!firstFrameUrl.value) return false
  }
  if (referenceMode.value === 'fl2v' && !lastFrameUrl.value) return false
  return true
})

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  errorMsg.value = ''
  resultUrl.value = ''
  currentJob.value = null
  try {
    const refMode = referenceMode.value === 't2v' ? 'none' : referenceMode.value
    const body: any = {
      source: 'free',
      config_id: selectedKey.value, // 后端 parseConfigIdWithModel 接受 "<id>:<model>"
      prompt: prompt.value.trim(),
      model: selectedConfig.value!.model,
      reference_mode: refMode,
      duration: duration.value,
      resolution: referenceMode.value === 't2v' ? resolution.value : undefined,
      aspect_ratio: referenceMode.value === 't2v' ? aspectRatio.value : (referenceMode.value === 'i2v' || referenceMode.value === 'fl2v' ? 'adaptive' : aspectRatio.value),
      negative_prompt: negativePrompt.value.trim() || undefined,
    }
    if (refMode === 'single' || refMode === 'first_last') {
      body.first_frame_url = firstFrameUrl.value
    }
    if (refMode === 'first_last') {
      body.last_frame_url = lastFrameUrl.value
    }
    const record = await videoAPI.generate(body)
    currentJob.value = record
    // 开始轮询
    startPoll(record.id)
  } catch (e: any) {
    errorMsg.value = e.message || String(e)
    toast.error(`提交失败: ${errorMsg.value}`)
    submitting.value = false
  }
}

function startPoll(id: number) {
  stopPoll()
  pollTimer = window.setInterval(async () => {
    try {
      const record = await videoAPI.get(id)
      currentJob.value = record
      const status = (record?.status || '').toLowerCase()
      if (status === 'completed' || status === 'success') {
        // drizzle 返回 camelCase (localPath / videoUrl); 兼容历史 snake_case 兜底
        const url = record.localPath || record.videoUrl || record.local_path || record.video_url
        if (url) resultUrl.value = url.startsWith('/') ? url : '/' + url
        stopPoll()
        submitting.value = false
        toast.success('生成完成')
        loadHistory()
      } else if (status === 'failed' || status === 'error') {
        errorMsg.value = record.error_msg || record.error || '生成失败'
        stopPoll()
        submitting.value = false
        toast.error(errorMsg.value)
        loadHistory()
      }
      // processing / pending / queued: 继续轮询
    } catch (e: any) {
      // 网络抖动: 不要立刻停止, 但累计 3 次再停
      console.warn('poll error', e)
    }
  }, 3000)
}

function stopPoll() {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(() => stopPoll())

// ======== 历史 ========
const history = ref<any[]>([])
async function loadHistory() {
  try {
    const rows: any = await videoAPI.listFree()
    history.value = Array.isArray(rows) ? rows : (rows?.items || [])
    // 按 created_at 倒序
    history.value.sort((a, b) => (b.created_at || b.createdAt || '').localeCompare(a.created_at || a.createdAt || ''))
    history.value = history.value.slice(0, 10)
  } catch (e: any) {
    console.warn('load history failed', e)
  }
}

function videoUrlOf(item: any): string {
  // drizzle 返回 camelCase; 兜底 snake_case 兼容老数据
  return item?.localPath || item?.videoUrl || item?.local_path || item?.video_url || ''
}

function previewFromHistory(item: any) {
  const url = videoUrlOf(item)
  if (url) {
    resultUrl.value = url.startsWith('/') ? url : '/' + url
    currentJob.value = item
    errorMsg.value = ''
    nextTick(() => playPreview())
  }
}

function statusTag(item: any): { label: string, cls: string } {
  const s = (item.status || '').toLowerCase()
  if (s === 'completed' || s === 'success') return { label: '完成', cls: 'tag-success' }
  if (s === 'failed' || s === 'error') return { label: '失败', cls: 'tag-error' }
  return { label: '生成中', cls: 'tag-pending' }
}

onMounted(() => {
  loadHistory().then(() => {
    // 自动把最近一条完成的记录载入预览, 用户进入面板立刻能看到结果
    const latest = history.value.find(h => (h.status || '').toLowerCase() === 'completed' || (h.status || '').toLowerCase() === 'success')
    if (latest && !resultUrl.value) previewFromHistory(latest)
  })
})

// 预览视频引用 + 点击播放
const previewRef = ref<HTMLVideoElement | null>(null)
const isPlaying = ref(false)
function playPreview() {
  const v = previewRef.value
  if (!v) return
  v.play().then(() => { isPlaying.value = true }).catch(() => { isPlaying.value = false })
}
function pausePreview() { previewRef.value?.pause(); isPlaying.value = false }
function togglePreview() { isPlaying.value ? pausePreview() : playPreview() }

// ======== 重置 ========
function resetForm() {
  prompt.value = ''
  negativePrompt.value = ''
  referenceMode.value = 't2v'
  firstFrameUrl.value = ''
  lastFrameUrl.value = ''
  duration.value = currentCaps.value.durations[0]
  resolution.value = currentCaps.value.resolutions[0]
  aspectRatio.value = currentCaps.value.ratios[0]
  resultUrl.value = ''
  errorMsg.value = ''
  currentJob.value = null
}
</script>

<template>
  <div class="free-panel">
    <!-- 左列: 表单 -->
    <div class="free-form">
      <div class="free-section">
        <div class="free-section-label">模型配置</div>
        <select v-model="selectedKey" class="free-select" @change="onConfigChange(($event.target as HTMLSelectElement).value)">
          <option value="">— 选择已保存的视频模型配置 —</option>
          <option v-for="opt in configOptions" :key="`${opt.configId}:${opt.model}`" :value="`${opt.configId}:${opt.model}`" :disabled="opt.disabled">
            {{ opt.label }}
          </option>
        </select>
        <div v-if="!configOptions.length" class="free-hint">
          暂无视频模型配置，请先在 <b>设置 → 视频</b> 里添加。
        </div>
      </div>

      <div v-if="selectedKey" class="free-section">
        <div class="free-section-label">参考模式</div>
        <div class="free-mode-row">
          <label :class="['mode-chip', { active: referenceMode === 't2v' }]">
            <input v-model="referenceMode" type="radio" value="t2v" />
            <span>文生视频 (T2V)</span>
          </label>
          <label :class="['mode-chip', { active: referenceMode === 'i2v', disabled: !availableModes.includes('i2v') }]">
            <input v-model="referenceMode" type="radio" value="i2v" :disabled="!availableModes.includes('i2v')" />
            <span>图生视频 (I2V)</span>
          </label>
          <label :class="['mode-chip', { active: referenceMode === 'fl2v', disabled: !availableModes.includes('fl2v') }]" :title="!availableModes.includes('fl2v') ? '当前模型不支持首尾帧 (参考官方文档)' : ''">
            <input v-model="referenceMode" type="radio" value="fl2v" :disabled="!availableModes.includes('fl2v')" />
            <span>首尾帧 (FL2V)</span>
          </label>
        </div>
      </div>

      <div v-if="selectedKey" class="free-section">
        <div class="free-section-label">提示词 <span class="dim">· 支持运镜指令 (例 [推进], [左摇])</span></div>
        <textarea
          v-model="prompt"
          class="free-textarea"
          rows="3"
          maxlength="2000"
          placeholder="描述视频内容 (≤ 2000 字)"
        />
      </div>

      <div v-if="selectedKey" class="free-section">
        <div class="free-grid">
          <div>
            <div class="free-section-label small">时长 (秒)</div>
            <select v-model.number="duration" class="free-select">
              <option v-for="d in availableDurations" :key="d" :value="d">{{ d }}s</option>
            </select>
          </div>
          <div>
            <div class="free-section-label small">分辨率 <span v-if="referenceMode !== 't2v'" class="dim">· 由图片决定</span></div>
            <select v-model="resolution" class="free-select" :disabled="referenceMode !== 't2v'">
              <option v-for="r in availableResolutions" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>
          <div>
            <div class="free-section-label small">画面比例 <span v-if="referenceMode !== 't2v'" class="dim">· adaptive</span></div>
            <select v-model="aspectRatio" class="free-select" :disabled="referenceMode !== 't2v'">
              <option v-for="r in availableRatios" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>
        </div>
      </div>

      <div v-if="selectedKey && (referenceMode === 'i2v' || referenceMode === 'fl2v')" class="free-section">
        <div class="free-section-label">首帧图 <span class="dim">· JPG/PNG/WebP ≤ 20MB</span></div>
        <div class="free-upload">
          <div v-if="firstFrameUrl" class="free-upload-preview">
            <img :src="firstFrameUrl" alt="first frame" />
            <button class="btn btn-sm" @click="firstFrameUrl = ''">清除</button>
          </div>
          <div v-else class="free-upload-actions">
            <label class="btn btn-sm">
              <input type="file" accept="image/*" style="display:none" @change="onFileChange($event, 'first')" />
              {{ uploadingFirst ? '上传中…' : '上传图片' }}
            </label>
            <input v-model="firstFrameUrl" placeholder="或粘贴图片 URL (https://…)" class="free-input" @blur="pasteUrl(firstFrameUrl, 'first')" />
          </div>
        </div>
      </div>

      <div v-if="selectedKey && referenceMode === 'fl2v'" class="free-section">
        <div class="free-section-label">尾帧图 <span class="dim">· JPG/PNG/WebP ≤ 20MB</span></div>
        <div class="free-upload">
          <div v-if="lastFrameUrl" class="free-upload-preview">
            <img :src="lastFrameUrl" alt="last frame" />
            <button class="btn btn-sm" @click="lastFrameUrl = ''">清除</button>
          </div>
          <div v-else class="free-upload-actions">
            <label class="btn btn-sm">
              <input type="file" accept="image/*" style="display:none" @change="onFileChange($event, 'last')" />
              {{ uploadingLast ? '上传中…' : '上传图片' }}
            </label>
            <input v-model="lastFrameUrl" placeholder="或粘贴图片 URL (https://…)" class="free-input" @blur="pasteUrl(lastFrameUrl, 'last')" />
          </div>
        </div>
      </div>

      <div v-if="selectedKey" class="free-section">
        <div class="free-section-label small">负面提示词 <span class="dim">· 可选</span></div>
        <input v-model="negativePrompt" class="free-input" placeholder="不希望出现的元素 (例: 模糊, 抖动)" />
      </div>

      <div v-if="selectedKey" class="free-actions">
        <button class="btn" @click="resetForm" :disabled="submitting">重置</button>
        <button class="btn btn-primary ml-auto" :disabled="!canSubmit || submitting" @click="submit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          {{ submitting ? '生成中…' : '生成视频' }}
        </button>
      </div>
    </div>

    <!-- 右列: 预览 + 历史 -->
    <div class="free-side">
      <div class="free-preview-box">
        <div class="free-section-label small">预览</div>
        <div v-if="resultUrl" class="free-preview-video">
          <div class="free-preview-stage" @click="togglePreview">
            <video
              ref="previewRef"
              :src="resultUrl"
              preload="metadata"
              playsinline
              @play="isPlaying = true"
              @pause="isPlaying = false"
              @ended="isPlaying = false"
            />
            <button
              v-if="!isPlaying"
              class="free-preview-play"
              type="button"
              :aria-label="'播放视频'"
              @click.stop="playPreview"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </button>
          </div>
          <div class="free-preview-toolbar">
            <span v-if="currentJob?.id" class="dim" style="font-size:11px">#{{ currentJob.id }} · {{ currentJob.model || '' }}</span>
            <a :href="resultUrl" :download="`free-creation-${currentJob?.id || 'video'}.mp4`" class="btn btn-primary btn-download ml-auto">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              下载视频
            </a>
          </div>
        </div>
        <div v-else-if="submitting" class="free-preview-placeholder">
          <div class="free-spinner" />
          <div class="dim">生成中，请稍候…</div>
          <div v-if="currentJob?.status" class="dim mt-1" style="font-size:11px">状态: {{ currentJob.status }}</div>
        </div>
        <div v-else-if="errorMsg" class="free-preview-error">
          <div class="free-error-title">生成失败</div>
          <div class="free-error-msg">{{ errorMsg }}</div>
          <button class="btn btn-sm mt-1" @click="submit" v-if="canSubmit">重试</button>
        </div>
        <div v-else class="free-preview-placeholder dim">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          <div>填写左侧表单后点击「生成视频」</div>
        </div>
      </div>

      <div class="free-history">
        <div class="free-history-head">
          <span class="free-section-label small">本会话历史</span>
          <span class="dim" style="font-size:11px">最近 {{ history.length }} 条</span>
        </div>
        <div v-if="!history.length" class="free-history-empty dim">暂无</div>
        <div v-else class="free-history-list">
          <div v-for="item in history" :key="item.id" class="free-history-row">
            <span class="mono dim" style="font-size:10px">#{{ item.id }}</span>
            <span class="truncate history-prompt" :title="item.prompt" @click="previewFromHistory(item)">{{ item.prompt?.slice(0, 40) || '—' }}</span>
            <span :class="['tag', statusTag(item).cls]" style="font-size:10px">{{ statusTag(item).label }}</span>
            <!-- 仅完成项显示下载按钮 -->
            <a
              v-if="videoUrlOf(item)"
              :href="videoUrlOf(item).startsWith('/') ? videoUrlOf(item) : '/' + videoUrlOf(item)"
              :download="`free-creation-${item.id}.mp4`"
              class="history-download"
              title="下载视频"
              @click.stop
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.free-panel {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 16px;
  padding: 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.free-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.free-section { display: flex; flex-direction: column; gap: 6px; }
.free-section-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.free-section-label.small { font-size: 11px; }
.free-section-label .dim { font-weight: 400; }
.free-hint { font-size: 11.5px; color: var(--text-3); padding: 4px 0; }

.free-select, .free-input {
  width: 100%;
  padding: 7px 10px;
  font-size: 12.5px;
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-1);
  outline: none;
  transition: border-color 0.15s;
}
.free-select:focus, .free-input:focus { border-color: var(--accent); }
.free-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12.5px;
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-1);
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.free-textarea:focus { border-color: var(--accent); }

.free-mode-row { display: flex; gap: 6px; flex-wrap: wrap; }
.mode-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: 11.5px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.12s;
}
.mode-chip input { display: none; }
.mode-chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.mode-chip.disabled { opacity: 0.4; cursor: not-allowed; }

.free-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }

.free-upload { display: flex; flex-direction: column; gap: 6px; }
.free-upload-actions { display: flex; gap: 6px; align-items: center; }
.free-upload-actions .free-input { flex: 1; }
.free-upload-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.free-upload-preview img {
  width: 96px;
  height: 64px;
  object-fit: cover;
  border-radius: 4px;
  background: var(--bg-2);
}

.free-actions { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
.ml-auto { margin-left: auto; }
.mt-1 { margin-top: 8px; }

/* 右列 */
.free-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.free-preview-box {
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.free-preview-video { display: flex; flex-direction: column; gap: 8px; }
.free-preview-stage {
  position: relative;
  width: 100%;
  background: #000;
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  aspect-ratio: 16 / 9;
}
.free-preview-stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  display: block;
}
.free-preview-play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  backdrop-filter: blur(4px);
  transition: transform 0.15s, background 0.15s;
}
.free-preview-play:hover { transform: scale(1.08); background: rgba(0, 0, 0, 0.72); }
.free-preview-toolbar { display: flex; align-items: center; gap: 8px; }
.free-preview-placeholder {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-3);
  font-size: 12px;
}
.free-preview-error {
  padding: 14px;
  background: rgba(220, 80, 80, 0.08);
  border: 1px solid rgba(220, 80, 80, 0.3);
  border-radius: var(--radius);
}
.free-error-title { font-size: 12px; font-weight: 700; color: var(--error, #c0392b); margin-bottom: 4px; }
.free-error-msg { font-size: 11.5px; color: var(--text-2); word-break: break-word; }
.free-spinner {
  width: 24px; height: 24px;
  border: 2.5px solid var(--bg-2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: free-spin 0.8s linear infinite;
}
@keyframes free-spin { to { transform: rotate(360deg); } }

/* 历史 */
.free-history {
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
}
.free-history-head { display: flex; align-items: baseline; justify-content: space-between; }
.free-history-empty { font-size: 11.5px; padding: 4px 0; }
.free-history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  max-height: 280px;
}
.free-history-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 4px;
  transition: background 0.1s;
}
.free-history-row:hover { background: var(--bg-hover); }
.history-prompt { cursor: pointer; }
.history-download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 4px;
  color: var(--text-3);
  transition: all 0.12s;
}
.history-download:hover { background: var(--accent-bg); color: var(--accent-text); }
.btn-download { font-weight: 600; box-shadow: var(--shadow-sm); }

.tag { padding: 1px 6px; border-radius: 99px; font-size: 10px; font-weight: 600; }
.tag-success { background: rgba(40, 167, 69, 0.15); color: #28a745; }
.tag-error { background: rgba(220, 53, 69, 0.15); color: #dc3545; }
.tag-pending { background: rgba(76, 125, 255, 0.15); color: var(--accent-dark); }

@media (max-width: 980px) {
  .free-panel { grid-template-columns: 1fr; }
  .free-grid { grid-template-columns: 1fr; }
}
</style>

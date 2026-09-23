<template>
  <div class="page" v-if="drama">
    <!-- Header -->
    <div class="page-head">
      <div class="head-left">
        <button class="back-btn" @click="navigateTo('/')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回
        </button>
        <div class="head-info">
          <h1 class="page-title">{{ drama.title }}</h1>
          <div class="page-meta">
            <span v-if="drama.style" class="style-chip" :title="`风格：${styleLabel(drama.style)}`">{{ styleLabel(drama.style) }}</span>
            <span v-if="drama.style" class="meta-divider"></span>
            <span v-if="drama.character_aesthetic || drama.characterAesthetic" class="style-chip aesthetic-chip" :title="`角色美学：${characterAestheticLabel(drama.character_aesthetic || drama.characterAesthetic)}`">{{ characterAestheticLabel(drama.character_aesthetic || drama.characterAesthetic) }}</span>
            <span v-if="drama.character_aesthetic || drama.characterAesthetic" class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {{ drama.characters?.length || 0 }} 角色
            </span>
            <span class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
              {{ drama.scenes?.length || 0 }} 场景
            </span>
          </div>
        </div>
      </div>
      <button class="btn" @click="openEditStyle" title="编辑剧集整体风格 + 角色美学" style="margin-right:8px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        编辑风格
      </button>
      <button class="btn btn-primary" @click="openAddEpisode">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        添加集
      </button>
    </div>

    <!-- Episode List -->
    <div class="section-label">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <rect x="2" y="2" width="20" height="20" rx="2.5"/>
        <line x1="7" y1="8" x2="7" y2="16"/>
        <line x1="10" y1="8" x2="10" y2="16"/>
        <line x1="13" y1="8" x2="13" y2="16"/>
        <line x1="16" y1="8" x2="16" y2="16"/>
      </svg>
      剧集列表
    </div>

    <div class="ep-grid">
      <div
        v-for="(ep, i) in drama.episodes"
        :key="ep.id"
        class="card ep-card"
        :style="{ animationDelay: `${i * 0.05}s` }"
        @click="navigateTo(`/drama/${drama.id}/episode/${ep.episode_number || ep.episodeNumber}`)"
      >
        <div class="ep-number">E{{ String(ep.episode_number || ep.episodeNumber).padStart(2, '0') }}</div>
        <div class="ep-body">
          <span class="ep-title">{{ ep.title }}</span>
          <div class="ep-status">
            <span :class="['status-dot', hasScript(ep) ? 'dot-ready' : 'dot-pending']"></span>
            <span class="status-text">{{ hasScript(ep) ? '已完成剧本' : '待编写' }}</span>
            <span v-if="ep.duration" class="ep-duration">{{ ep.duration }}s</span>
          </div>
        </div>
        <div class="ep-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      <!-- Empty episode state -->
      <div v-if="!drama.episodes?.length" class="card ep-empty">
        <div class="ep-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p>点击上方「添加集」创建第一集</p>
      </div>
    </div>

    <div v-if="addDialog" class="dialog-mask" @click.self="addDialog = false">
      <div class="card dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Episode Setup</div>
            <div class="dialog-title-row">
              <div class="dialog-title">创建新集</div>
              <span class="dialog-badge">配置将锁定</span>
            </div>
            <div class="dialog-sub">为这一集预先锁定图片、视频和音频生成服务。创建后，这些生成链路将始终跟随当前集配置。</div>
          </div>
          <button class="back-btn" @click="addDialog = false">取消</button>
        </div>
        <div class="dialog-summary">
          <div class="summary-chip">图片 · {{ imageConfigs.length }} 可选</div>
          <div class="summary-chip">视频 · {{ videoConfigs.length }} 可选</div>
          <div class="summary-chip">音频 · {{ audioConfigs.length }} 可选</div>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">基础信息</span>
              <span class="dialog-section-copy">这一项只影响显示名称，不影响生成配置</span>
            </div>
            <label class="field">
              <span class="field-label">标题</span>
              <input v-model="newEpisodeTitle" class="input" placeholder="默认按集数自动命名" />
              <span class="field-hint">留空时会自动按集数命名，例如“第 3 集”。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">目标时长</span>
              <span class="dialog-section-copy">这一集 Σ 镜头时长的收敛目标，step 3.D 接入 estimator 自动用</span>
            </div>
            <div class="target-duration-row">
              <label class="field target-duration-input">
                <span class="field-label">秒数</span>
                <input
                  v-model.number="newEpisodeTargetDuration"
                  class="input"
                  type="number"
                  min="60"
                  max="240"
                  step="5"
                  placeholder="100"
                />
                <span class="field-hint">范围 60–240 秒（±50s 调节）</span>
              </label>
              <label class="field target-duration-slider">
                <span class="field-label">滑块（±50s）</span>
                <input
                  v-model.number="newEpisodeTargetDuration"
                  class="range"
                  type="range"
                  min="60"
                  max="240"
                  step="5"
                />
                <div class="range-marks">
                  <span>60s</span>
                  <span>150s</span>
                  <span>240s</span>
                </div>
              </label>
              <div class="target-duration-action">
                <button
                  class="btn btn-sm btn-estimate"
                  :disabled="estimatingTarget"
                  @click="estimateTarget"
                  title="调后端 heuristic: drama 平均 prior 或 100s baseline"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                  {{ estimatingTarget ? '估算中…' : '智能估算' }}
                </button>
              </div>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">生成配置</span>
              <span class="dialog-section-copy">创建后不可更改，建议在这里一次性选对</span>
            </div>
            <div class="config-grid">
              <label class="config-card">
                <span class="config-card-kicker">IMAGE</span>
                <span class="field-label">图片配置</span>
                <BaseSelect v-model="newEpisodeImageConfigId" :options="imageConfigOptions" placeholder="选择图片服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">VIDEO</span>
                <span class="field-label">视频配置</span>
                <BaseSelect v-model="newEpisodeVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">AUDIO</span>
                <span class="field-label">音频配置</span>
                <BaseSelect v-model="newEpisodeAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
              </label>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">创建后，工作台中的图片、视频、音频生成入口都会锁定到当前集。</div>
          <button class="btn btn-primary" :disabled="creatingEpisode || !canCreateEpisode" @click="addEpisode">
            {{ creatingEpisode ? '创建中...' : '创建并锁定配置' }}
          </button>
        </div>
      </div>
    </div>
  </div>

    <!-- Edit Style Dialog (2026-09-23 PM msg-20260923-002 fix #2) -->
    <div v-if="editStyle" class="dialog-mask" @click.self="editStyle = false">
      <div class="dialog card">
        <div class="dialog-header">
          <div class="dialog-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <h2 class="dialog-title">编辑剧集风格</h2>
          <p class="dialog-desc">视觉风格 + 角色美学两个维度独立控制</p>
        </div>
        <form @submit.prevent="saveStyle" class="dialog-form">
          <label class="field">
            <span class="field-label">视觉风格</span>
            <BaseSelect v-model="editForm.style" :options="styleSelectOptions" placeholder="选择风格" searchable />
          </label>
          <label class="field">
            <span class="field-label">角色美学</span>
            <BaseSelect v-model="editForm.character_aesthetic" :options="aestheticOptions" placeholder="选择角色美学" />
          </label>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editStyle = false">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="savingStyle">
              {{ savingStyle ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useStylePresets } from '~/composables/useStylePresets'
import { CHARACTER_AESTHETIC_OPTIONS, characterAestheticLabel } from '~/composables/useCharacterAesthetics'

const route = useRoute()
const drama = ref(null)

// 风格 label 来自后端, 单一来源
const { styleLabel, stylePresets, load: loadStylePresets } = useStylePresets()
onMounted(() => { loadStylePresets() })

const dramaId = Number(route.params.id)
const addDialog = ref(false)
const creatingEpisode = ref(false)
// 2026-09-23 PM msg-20260923-002 fix #2: 编辑剧集风格 (visual + character_aesthetic) 状态
const editStyle = ref(false)
const savingStyle = ref(false)
const editForm = ref({ style: '', character_aesthetic: 'neutral' })
// 2026-09-23: styleSelectOptions 复用 useStylePresets 的 stylePresets
const styleSelectOptions = computed(() =>
  stylePresets.value.map(s => ({ label: s.hint ? `${s.label} — ${s.hint}` : s.label, value: s.slug })),
)
// 2026-09-23: 角色美学独立选项 (与 drama.style 解耦)
const aestheticOptions = CHARACTER_AESTHETIC_OPTIONS
const newEpisodeTitle = ref('')
const imageConfigs = ref([])
const videoConfigs = ref([])
const audioConfigs = ref([])
const newEpisodeImageConfigId = ref(null)
const newEpisodeVideoConfigId = ref(null)
const newEpisodeAudioConfigId = ref(null)
// Step 4.E: 目标时长 (UI 滑块 + 智能估算按钮)
const newEpisodeTargetDuration = ref(100)  // 默认 100s (后端 DEFAULT_EPISODE_TARGET_SECONDS)
const estimatingTarget = ref(false)

function hasScript(ep) { return !!(ep.script_content || ep.scriptContent) }

function configLabel(config) {
  if (!config) return ''
  let modelName = ''
  try { const m = JSON.parse(config.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = config.model || '' }
  return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
}

const imageConfigOptions = computed(() => imageConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const videoConfigOptions = computed(() => videoConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const audioConfigOptions = computed(() => audioConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const canCreateEpisode = computed(() => !!(newEpisodeImageConfigId.value && newEpisodeVideoConfigId.value && newEpisodeAudioConfigId.value))

async function load() {
  try {
    drama.value = await dramaAPI.get(dramaId)
  } catch (e) {
    toast.error(e.message)
  }
}

async function loadConfigs() {
  try {
    const [imgs, vids, auds] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('audio'),
    ])
    imageConfigs.value = imgs || []
    videoConfigs.value = vids || []
    audioConfigs.value = auds || []
    if (!newEpisodeImageConfigId.value && imageConfigs.value.length) newEpisodeImageConfigId.value = imageConfigs.value[0].id
    if (!newEpisodeVideoConfigId.value && videoConfigs.value.length) newEpisodeVideoConfigId.value = videoConfigs.value[0].id
    if (!newEpisodeAudioConfigId.value && audioConfigs.value.length) newEpisodeAudioConfigId.value = audioConfigs.value[0].id
  } catch (e) {
    toast.error(e.message)
  }
}

// 2026-09-23 PM msg-20260923-002 fix #2: 打开编辑风格弹窗
function openEditStyle() {
  editForm.value = {
    style: drama.value?.style || '',
    character_aesthetic: drama.value?.character_aesthetic || drama.value?.characterAesthetic || 'neutral',
  }
  editStyle.value = true
}

async function saveStyle() {
  if (savingStyle.value) return
  savingStyle.value = true
  try {
    await dramaAPI.update(dramaId, {
      style: editForm.value.style || null,
      character_aesthetic: editForm.value.character_aesthetic || null,
    })
    // 更新本地 drama (snake_case from server)
    drama.value.style = editForm.value.style || ''
    drama.value.character_aesthetic = editForm.value.character_aesthetic || null
    toast.success('剧集风格已保存')
    editStyle.value = false
    await load()  // 重新拉取 drama 数据以保证 character_aesthetic 等字段刷新
  } catch (e: any) {
    toast.error(e?.message || '保存失败')
  } finally {
    savingStyle.value = false
  }
}

function openAddEpisode() {
  newEpisodeTitle.value = ''
  newEpisodeTargetDuration.value = 100  // 重置为默认 baseline
  addDialog.value = true
}

// Step 4.E: 智能估算按钮 → 调后端 heuristic 接口
async function estimateTarget() {
  try {
    estimatingTarget.value = true
    const res = await episodeAPI.estimateTargetDuration(dramaId)
    if (res && typeof res.target_duration === 'number') {
      newEpisodeTargetDuration.value = res.target_duration
      toast.success(`估算 ${res.target_duration}s (${res.source === 'drama-average' ? `基于已有 ${res.sample_count} 集均值` : '基线 100s'})`)
    }
  } catch (e) {
    toast.error(e?.message || '估算失败')
  } finally {
    estimatingTarget.value = false
  }
}

async function addEpisode() {
  try {
    creatingEpisode.value = true
    // Step 4.E: 滑块值落到 [60, 240] 区间, 合法才传 target_duration (null 让后端 estimator 兜底)
    const td = Math.round(Number(newEpisodeTargetDuration.value) || 0)
    await episodeAPI.create({
      drama_id: dramaId,
      title: newEpisodeTitle.value || undefined,
      image_config_id: newEpisodeImageConfigId.value,
      video_config_id: newEpisodeVideoConfigId.value,
      audio_config_id: newEpisodeAudioConfigId.value,
      target_duration: (td >= 60 && td <= 240) ? td : undefined,
    })
    toast.success('已添加新集')
    addDialog.value = false
    load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    creatingEpisode.value = false
  }
}

onMounted(() => { load(); loadConfigs() })
</script>

<style scoped>
.page {
  padding: 28px 48px 40px;
  overflow-y: auto;
  height: 100%;
  animation: fadeUp 0.35s var(--ease-out) both;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
  gap: 20px;
}
.head-left { display: flex; align-items: flex-start; gap: 12px; }
.head-info { display: flex; flex-direction: column; gap: 8px; }

.back-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px; font-size: 13px; font-weight: 500;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-0); color: var(--text-2);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  box-shadow: var(--shadow-xs);
}
.back-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-0); }

.page-title {
  font-family: var(--font-display);
  font-size: 26px; font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.page-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.style-chip {
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  background: var(--accent-bg); color: var(--accent-text);
  border-radius: 99px; border: 1px solid rgba(184,120,20,0.12);
}
.meta-divider { width: 3px; height: 3px; border-radius: 50%; background: var(--text-3); }
.meta-item {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--text-2);
}

/* Step 4.E: 目标时长 UI */
.target-duration-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) 1fr auto;
  gap: 16px;
  align-items: stretch;
}
.target-duration-input { display: flex; flex-direction: column; }
.target-duration-slider { display: flex; flex-direction: column; }
.range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  background: linear-gradient(to right, var(--accent) 0%, var(--accent) var(--range-fill, 25%), var(--bg-hover) var(--range-fill, 25%), var(--bg-hover) 100%);
  border-radius: 99px;
  outline: none;
  cursor: pointer;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-0);
  border: 2px solid var(--accent);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  transition: transform 0.15s var(--ease-out);
}
.range::-webkit-slider-thumb:hover { transform: scale(1.15); }
.range::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-0);
  border: 2px solid var(--accent);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
}
.range-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.target-duration-action { display: flex; align-items: flex-end; }
.btn-estimate {
  display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap;
}

/* Section label */
.section-label {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 700;
  color: var(--text-3); letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* Episode Grid */
.ep-grid { display: flex; flex-direction: column; gap: 10px; max-width: 760px; }

.ep-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 16px;
  cursor: pointer;
  animation: fadeUp 0.35s var(--ease-out) both;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s;
}
.ep-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow);
  transform: translateX(4px);
}

.ep-number {
  width: 44px; height: 44px; flex-shrink: 0;
  border-radius: var(--radius);
  background: var(--bg-2);
  border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 700;
  color: var(--text-2);
  transition: all 0.18s;
}
.ep-card:hover .ep-number {
  background: var(--accent-bg);
  border-color: rgba(184,120,20,0.2);
  color: var(--accent);
}

.ep-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ep-title { font-size: 14px; font-weight: 600; color: var(--text-0); }
.ep-status { display: flex; align-items: center; gap: 6px; }
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.dot-ready { background: var(--success); }
.dot-pending { background: var(--text-3); }
.status-text { font-size: 11px; color: var(--text-3); }
.ep-duration { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); margin-left: 4px; }

.ep-arrow { color: var(--text-3); flex-shrink: 0; transition: transform 0.18s; }
.ep-card:hover .ep-arrow { transform: translateX(3px); color: var(--accent); }

/* Empty */
.ep-empty {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px; text-align: center; color: var(--text-3); font-size: 13px;
  border-style: dashed;
}
.ep-empty-icon {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--bg-2); display: flex; align-items: center; justify-content: center;
}

.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 38, 0.18);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dialog {
  width: min(760px, 100%);
  max-height: min(860px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 26px 26px 22px;
  border-radius: 28px;
  background:
    radial-gradient(circle at top left, rgba(122,167,255,0.14), transparent 34%),
    radial-gradient(circle at top right, rgba(76,125,255,0.08), transparent 26%),
    linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,247,255,0.92));
  overflow: hidden;
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 22px 52px rgba(32, 48, 77, 0.14), 0 8px 18px rgba(32, 48, 77, 0.08);
}
.dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dialog-head-copy { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.dialog-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dialog-title { font-size: 28px; font-weight: 800; color: var(--text-0); letter-spacing: -0.03em; }
.dialog-badge {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(76,125,255,0.1);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 700;
}
.dialog-sub { font-size: 14px; line-height: 1.7; color: var(--text-2); }
.dialog-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.summary-chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.78);
  border: 1px solid rgba(27, 41, 64, 0.08);
  font-size: 12px;
  color: var(--text-2);
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding-right: 4px;
}
.dialog-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 22px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.dialog-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-section-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.dialog-section-copy { font-size: 12px; color: var(--text-3); }
.config-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.config-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.78));
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.config-card-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 2px;
}
.dialog-foot-copy {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.field-hint { font-size: 12px; color: var(--text-3); }

@media (max-width: 860px) {
  .dialog {
    width: 100%;
    max-height: calc(100vh - 24px);
    padding: 18px;
    border-radius: 22px;
  }

  .dialog-title {
    font-size: 24px;
  }

  .config-grid {
    grid-template-columns: 1fr;
  }

  .dialog-foot {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>

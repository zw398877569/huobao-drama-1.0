<template>
  <div class="settings-layout">
    <aside class="settings-nav">
      <div class="nav-group">
        <div class="nav-group-label">基础</div>
        <button v-for="t in baseTabs" :key="t.id" :class="['nav-item', { active: tab === t.id }]" @click="tab = t.id">
          <component :is="t.icon" :size="14" />
          {{ t.label }}
        </button>
      </div>
      <div class="nav-advanced">
        <label class="advanced-toggle">
          <span>Agent 高级配置</span>
          <input type="checkbox" v-model="showAdvanced" />
          <span class="advanced-slider"></span>
        </label>
        <p class="advanced-note">仅展开 Agent 配置与 Skills。工作台功能和分镜字段保持默认可见。</p>
      </div>
      <div v-if="showAdvanced" class="nav-group">
        <div class="nav-group-label">高级</div>
        <button v-for="t in advancedTabs" :key="t.id" :class="['nav-item', { active: tab === t.id }]" @click="tab = t.id">
          <component :is="t.icon" :size="14" />
          {{ t.label }}
        </button>
      </div>
    </aside>

    <div class="settings-content">

      <!-- ===== AI 服务配置 ===== -->
      <div v-if="tab === 'ai'" class="settings-scroll">
        <div class="settings-head">
          <div class="settings-brand">
            <div class="settings-brand-mark">
              <img v-if="showBrandImage" :src="brandLogo" alt="火宝短剧" class="settings-brand-logo" @error="showBrandImage = false" />
              <span v-else class="settings-brand-fallback">火</span>
            </div>
            <div class="settings-brand-copy">
              <div class="settings-brand-kicker">Huobao Shorts</div>
              <div class="settings-brand-name">火宝短剧</div>
            </div>
          </div>
          <h2 class="settings-title">AI 服务配置</h2>
          <p class="settings-desc">先用推荐模板快速落配置，再按服务类型微调。工作台创建集时会锁定所选图片、视频和音频能力。</p>
        </div>
        <section class="setup-panel card">
          <div class="setup-panel-head">
            <div>
              <div class="setup-kicker">Quick Setup</div>
              <div class="setup-title">火宝推荐配置</div>
              <div class="setup-desc">一键写入文本、图片、视频、音频四类推荐配置，适合作为开箱默认方案。</div>
            </div>
            <button class="btn btn-primary" @click="presetDialog = true">
              <Sparkles :size="14" /> 火宝一键配置
            </button>
          </div>
          <div class="preset-grid">
            <article v-for="preset in huobaoPresetCards" :key="preset.serviceType" class="preset-card">
              <div class="preset-card-top">
                <span class="preset-service">{{ preset.label }}</span>
                <span class="tag tag-accent">{{ preset.provider }}</span>
              </div>
              <div class="preset-model mono">{{ preset.model }}</div>
              <div class="preset-base mono">{{ preset.baseUrl }}</div>
            </article>
          </div>
        </section>
        <section class="setup-panel card">
          <div class="setup-panel-head compact">
            <div>
              <div class="setup-title">快捷模板</div>
              <div class="setup-desc">选择服务类型后，直接用模板填充推荐的 `provider / base URL / model`。</div>
            </div>
          </div>
          <div class="template-row">
            <button
              v-for="st in serviceTypes"
              :key="st.type"
              class="template-type-chip"
              @click="startAddCfg(st.type)"
            >
              {{ st.label }}
            </button>
          </div>
        </section>
        <div class="sections">
          <section v-for="st in serviceTypes" :key="st.type">
            <div class="section-head">
              <div>
                <span class="section-title">{{ st.label }}</span>
                <div class="section-subtitle">{{ serviceMeta[st.type].desc }}</div>
              </div>
              <span v-if="countActive(st.type)" class="tag tag-accent">{{ countActive(st.type) }} 已启用</span>
              <button class="btn btn-ghost btn-sm ml-auto" @click="startAddCfg(st.type)"><Plus :size="13" /> 添加</button>
            </div>
            <div class="config-list">
              <div v-for="c in byType(st.type)" :key="c.id" class="card config-row">
                <div class="config-info">
                  <div class="config-main">
                    <div class="config-line">
                      <span class="config-provider">{{ c.provider }}</span>
                      <span class="config-name">{{ c.name || `${c.provider}-${c.service_type}` }}</span>
                    </div>
                    <span class="config-model mono truncate">{{ fmtModel(c.model) }}</span>
                    <span class="config-base mono truncate">{{ c.base_url || '未设置 Base URL' }}</span>
                  </div>
                </div>
                <span :class="['tag', c.api_key ? 'tag-success' : 'tag-error']">{{ c.api_key ? '已配置' : '无密钥' }}</span>
                <button class="btn btn-ghost btn-sm" @click="testExistingCfg(c)">测试</button>
                <label class="toggle"><input type="checkbox" :checked="c.is_active" @change="toggleCfg(c)"><span /></label>
                <button class="btn btn-ghost btn-icon" @click="startEditCfg(c)"><Pencil :size="13" /></button>
                <button class="btn btn-ghost btn-icon" @click="delCfg(c.id)"><Trash2 :size="13" /></button>
              </div>
              <p v-if="!byType(st.type).length" class="config-empty">暂无配置</p>
            </div>
          </section>
        </div>
      </div>

      <!-- ===== Agent 配置 ===== -->
      <div v-else-if="tab === 'agents'" class="settings-scroll">
        <div class="settings-head">
          <div class="settings-brand">
            <div class="settings-brand-mark">
              <img v-if="showBrandImage" :src="brandLogo" alt="火宝短剧" class="settings-brand-logo" @error="showBrandImage = false" />
              <span v-else class="settings-brand-fallback">火</span>
            </div>
            <div class="settings-brand-copy">
              <div class="settings-brand-kicker">Huobao Shorts</div>
              <div class="settings-brand-name">火宝短剧</div>
            </div>
          </div>
          <h2 class="settings-title">Agent 配置</h2>
          <p class="settings-desc">高级区只保留 Agent 运行配置。这里可以调整模型、提示词和参数，保存后立即生效。</p>
        </div>
        <div class="agent-list">
          <div v-for="a in agentDefs" :key="a.type" class="card agent-card">
            <div class="agent-card-head" @click="toggleAgentEdit(a.type)">
              <div class="agent-type-badge">{{ a.icon }}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:14px">{{ a.label }}</div>
                <div class="dim" style="font-size:12px">{{ a.type }}</div>
              </div>
              <span v-if="getAgentCfg(a.type)" class="tag tag-success">已配置</span>
              <span v-else class="tag">默认</span>
              <ChevronDown :size="14" :style="{ transform: editingAgent === a.type ? 'rotate(180deg)' : '', transition: '0.2s' }" />
            </div>
            <div v-if="editingAgent === a.type" class="agent-card-body">
              <label class="field">
                <span class="field-label">模型 <span class="dim">(留空使用 AI 服务默认)</span></span>
                <BaseSelect v-model="agentForm.model" :options="textModelSelectOptions" placeholder="— 使用 AI 服务默认 —" searchable />
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">Temperature</span>
                  <input v-model.number="agentForm.temperature" class="input" type="number" min="0" max="2" step="0.1" />
                </label>
                <label class="field">
                  <span class="field-label">Max Tokens</span>
                  <input v-model.number="agentForm.max_tokens" class="input" type="number" min="100" max="32000" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">System Prompt</span>
                <textarea v-model="agentForm.system_prompt" class="textarea" rows="12" placeholder="Agent 系统提示词..." />
              </label>
              <div class="agent-card-foot">
                <button class="btn btn-ghost btn-sm" @click="resetAgentPrompt(a.type)">恢复默认</button>
                <span v-if="agentSaved === a.type" class="tag tag-success" style="margin-left:8px">
                  <Check :size="10" /> 已保存
                </span>
                <button class="btn btn-primary btn-sm ml-auto" :disabled="agentSaving" @click="saveAgentCfg(a.type)">
                  <Loader2 v-if="agentSaving" :size="12" class="animate-spin" />
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== Skills 编辑 ===== -->
      <div v-else-if="tab === 'skills'" class="skills-layout">
        <!-- Agent 左侧列表 -->
        <aside class="skills-agent-list">
          <div class="skills-agent-title">Agent 列表</div>
          <button
            v-for="a in agentDefs"
            :key="a.type"
            :class="['skills-agent-item', { active: selectedAgent === a.type }]"
            @click="selectAgent(a.type)"
          >
            <span class="agent-type-badge">{{ a.icon }}</span>
            <span class="skills-agent-label">{{ a.label }}</span>
            <span v-if="agentSkillCount(a.type) > 0" class="skill-count-badge">{{ agentSkillCount(a.type) }}</span>
          </button>
        </aside>

        <!-- Skill 管理右侧主区域 -->
        <div class="settings-scroll skills-main">
          <div class="settings-head">
            <div class="settings-brand">
              <div class="settings-brand-mark">
                <img v-if="showBrandImage" :src="brandLogo" alt="火宝短剧" class="settings-brand-logo" @error="showBrandImage = false" />
                <span v-else class="settings-brand-fallback">火</span>
              </div>
              <div class="settings-brand-copy">
                <div class="settings-brand-kicker">Huobao Shorts</div>
                <div class="settings-brand-name">火宝短剧</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="agent-type-badge" style="width:32px;height:32px;font-size:16px">{{ selectedAgentIcon }}</span>
              <div>
                <h2 class="settings-title" style="margin:0">{{ selectedAgentLabel }}</h2>
                <div class="dim" style="font-size:12px">{{ selectedAgentType }} — Skills</div>
              </div>
            </div>
            <p class="settings-desc" style="margin-top:10px">Skills 仅作为 Agent 的高级提示词层使用，不影响工作台常规功能入口。</p>
            <button class="btn btn-primary btn-sm" @click="startAddSkill">
              <Plus :size="13" /> 新增 Skill
            </button>
          </div>

          <!-- 无 skill 提示 -->
          <div v-if="!currentSkills.length" class="step-empty" style="padding:48px 24px">
            <div class="empty-visual">
              <FileText :size="28" />
            </div>
            <div class="empty-title">暂无 Skill</div>
            <div class="empty-desc">点击右上角「新增 Skill」创建第一个提示词文件</div>
          </div>

          <!-- Skill 列表 -->
          <div class="skill-list" v-else>
            <div v-for="s in currentSkills" :key="s.id" class="card skill-card">
              <div class="skill-card-head" @click="toggleSkillEdit(s.id)">
                <FileText :size="14" style="color:var(--accent);flex-shrink:0" />
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;font-size:13px">{{ s.name }}</div>
                  <div class="dim" style="font-size:11px">{{ s.description }}</div>
                </div>
                <button class="btn btn-ghost btn-icon" style="margin-right:4px" @click.stop="deleteSkill(s.id)">
                  <Trash2 :size="13" />
                </button>
                <ChevronDown :size="14" :style="{ transform: editingSkill === s.id ? 'rotate(180deg)' : '', transition: '0.2s' }" />
              </div>
              <div v-if="editingSkill === s.id" class="skill-card-body">
                <textarea
                  v-model="skillContent"
                  class="textarea mono"
                  rows="20"
                  style="font-size:12px;line-height:1.6"
                  placeholder="编写 SKILL.md 内容..."
                />
                <div class="skill-card-foot">
                  <span class="dim" style="font-size:11px">skills/{{ selectedAgentType }}/{{ s.id }}/SKILL.md</span>
                  <span v-if="skillSaved === s.id" class="tag tag-success" style="margin-left:8px">
                    <Check :size="10" /> 已保存
                  </span>
                  <button class="btn btn-primary btn-sm ml-auto" :disabled="skillSaving" @click="saveSkill(s.id)">
                    <Loader2 v-if="skillSaving" :size="12" class="animate-spin" />
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- AI Config Dialog -->
    <div v-if="cfgDialog" class="overlay" @click.self="cfgDialog = false">
      <form class="modal card config-modal" @submit.prevent="saveCfg">
        <div class="config-modal-head">
          <div>
            <div class="setup-kicker">{{ cfgEditId ? 'Edit Config' : 'New Config' }}</div>
            <h2 class="modal-title">{{ cfgEditId ? '编辑服务配置' : `添加${serviceMeta[cfgForm.service_type].label}服务` }}</h2>
            <div class="modal-note">推荐先选择模板，系统会自动填入更合理的 `Base URL` 与默认模型。</div>
          </div>
          <span class="tag tag-accent">{{ serviceMeta[cfgForm.service_type].label }}</span>
        </div>
        <div class="preset-picker">
          <button
            v-for="preset in presetsByType(cfgForm.service_type)"
            :key="`${cfgForm.service_type}-${preset.provider}`"
            type="button"
            class="preset-pill"
            @click="applyProviderPreset(cfgForm.service_type, preset.provider)"
          >
            {{ preset.label }}
          </button>
        </div>
        <label class="field">
          <span class="field-label">配置名称</span>
          <input v-model="cfgForm.name" class="input" placeholder="如 火宝默认图像服务" />
        </label>
        <label class="field"><span class="field-label">服务商</span>
          <BaseSelect v-model="cfgForm.provider" :options="providerSelectOptions" placeholder="选择服务商" searchable />
        </label>
        <label class="field">
          <span class="field-label">优先级</span>
          <input v-model.number="cfgForm.priority" class="input" type="number" min="0" max="999" />
          <span class="field-hint">数值越高越优先。工作台默认会优先使用同类型里优先级最高的启用配置。</span>
        </label>
        <label class="field"><span class="field-label">API Key</span><input v-model="cfgForm.api_key" class="input" type="password" placeholder="sk-..." /></label>
        <label class="field"><span class="field-label">Base URL</span><input v-model="cfgForm.base_url" class="input" placeholder="https://..." /></label>
        <div class="endpoint-hint">
          <span class="dim">实际端点前缀：</span>
          <span class="mono">{{ endpointHint }}</span>
        </div>
        <label class="field"><span class="field-label">模型（逗号分隔）</span><input v-model="cfgForm.modelStr" class="input" placeholder="model-name" /></label>
        <div v-if="cfgTestResult" class="test-result" :class="{ ok: cfgTestResult.reachable, bad: !cfgTestResult.reachable }">
          <div class="test-result-head">
            <span class="tag" :class="cfgTestResult.reachable ? 'tag-success' : 'tag-error'">{{ cfgTestResult.status || 'ERROR' }}</span>
            <span>{{ cfgTestResult.message }}</span>
          </div>
          <div class="mono test-result-url">{{ cfgTestResult.method }} {{ cfgTestResult.url }}</div>
          <div v-if="cfgTestResult.response_preview" class="mono test-result-preview">{{ cfgTestResult.response_preview }}</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="cfgTesting" @click="testDraftCfg">
            <Loader2 v-if="cfgTesting" :size="12" class="animate-spin" />
            <span v-else>测试配置</span>
          </button>
          <button type="button" class="btn" @click="cfgDialog = false">取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      </form>
    </div>

    <!-- Huobao Preset Dialog -->
    <div v-if="presetDialog" class="overlay" @click.self="presetDialog = false">
      <form class="modal card config-modal" @submit.prevent="applyHuobaoPreset">
        <div class="config-modal-head">
          <div>
            <div class="setup-kicker">Huobao Preset</div>
            <h2 class="modal-title">火宝一键配置</h2>
            <div class="modal-note">按火宝推荐链路自动创建或更新 4 条服务配置，并同时初始化 5 个 Agent 的默认模型。</div>
          </div>
          <span class="tag tag-success">推荐</span>
        </div>
        <div class="huobao-grid">
          <label class="field">
            <span class="field-label">Huobao API Key <span class="dim">(统一用于文本 / 图片 / 视频 / 音频)</span></span>
            <input v-model="huobaoForm.apiKey" class="input" type="password" placeholder="用于 api.chatfire.site 全链路服务" />
            <span class="field-hint">还没有账号？<a href="https://api.chatfire.site/" target="_blank" rel="noopener">立即注册 →</a></span>
          </label>
        </div>
        <div class="preset-grid compact">
          <article v-for="preset in huobaoPresetCards" :key="`${preset.serviceType}-${preset.provider}`" class="preset-card">
            <div class="preset-card-top">
              <span class="preset-service">{{ preset.label }}</span>
              <span class="tag tag-accent">{{ preset.provider }}</span>
            </div>
            <div class="preset-model mono">{{ preset.model }}</div>
            <div class="preset-base mono">{{ preset.baseUrl }}</div>
          </article>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" @click="presetDialog = false">取消</button>
          <button type="submit" class="btn btn-primary">创建并启用</button>
        </div>
      </form>
    </div>

    <!-- Add Skill Dialog -->
    <div v-if="addSkillDialog" class="overlay" @click.self="addSkillDialog = false">
      <form class="modal card" @submit.prevent="confirmAddSkill">
        <h2 class="modal-title">新增 Skill — {{ selectedAgentLabel }}</h2>
        <label class="field">
          <span class="field-label">Skill 目录名 <span class="dim">(英文，唯一)</span></span>
          <input v-model="newSkillForm.id" class="input" placeholder="如 custom-extraction" />
        </label>
        <label class="field">
          <span class="field-label">名称</span>
          <input v-model="newSkillForm.name" class="input" placeholder="如 自定义提取规则" />
        </label>
        <label class="field">
          <span class="field-label">描述</span>
          <input v-model="newSkillForm.description" class="input" placeholder="简短描述此 Skill 的用途" />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn" @click="addSkillDialog = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="!newSkillForm.id">创建</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { Plus, Pencil, Trash2, FileText, ChevronDown, Check, Loader2, Bot, Cpu, Sparkles } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import { toast } from 'vue-sonner'
import { aiConfigAPI, agentConfigAPI, skillsAPI } from '~/composables/useApi'
import brandLogo from '~/assets/huobao-logo.png'

const showBrandImage = ref(true)
const tab = ref('ai')
const showAdvanced = ref(false)
const baseTabs = [
  { id: 'ai', label: 'AI 服务', icon: Cpu },
]
const advancedTabs = [
  { id: 'agents', label: 'Agent 配置', icon: Bot },
  { id: 'skills', label: 'Skills', icon: FileText },
]
watch(showAdvanced, (v) => {
  if (!v && tab.value !== 'ai') tab.value = 'ai'
})

// ===== AI Service Configs =====
const cfgs = ref([])
const cfgDialog = ref(false)
const cfgEditId = ref(null)
const presetDialog = ref(false)
const cfgTesting = ref(false)
const cfgTestResult = ref(null)
const cfgForm = reactive({ name: '', provider: '', api_key: '', base_url: '', modelStr: '', service_type: 'text', priority: 0 })
const huobaoForm = reactive({ apiKey: '' })
const serviceTypes = [{ type: 'text', label: '文本' }, { type: 'image', label: '图片' }, { type: 'video', label: '视频' }, { type: 'audio', label: '音频' }]
const providers = ['autodl-comfyui', 'nano-banana', 'agnes', 'ali', 'chatfire', 'gemini', 'minimax', 'openai', 'openrouter', 'vidu', 'volcengine']
const providerSelectOptions = computed(() => providers.map(p => ({ label: p, value: p })))
const serviceMeta = {
  text: { label: '文本', desc: '剧本改写、角色场景提取、分镜拆解等 Agent 文本能力' },
  image: { label: '图片', desc: '角色图、场景图、镜头图与首尾帧等静态图像生成' },
  video: { label: '视频', desc: '镜头视频生成，支持单图、多图和首尾帧模式' },
  audio: { label: '音频', desc: '角色试听、旁白与对白语音生成' },
}
const providerPresets = {
  text: {
    chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-preview'] },
    openrouter: { label: 'OpenRouter 推荐', baseUrl: 'https://openrouter.ai/api', models: ['google/gemini-3-flash-preview'] },
    openai: { label: 'OpenAI 推荐', baseUrl: 'https://api.openai.com', models: ['gpt-4.1-mini'] },
  },
  image: {
    chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['doubao-seedream-4-5-251128'] },
    gemini: { label: 'Gemini 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-image-preview'] },
    volcengine: { label: '火山推荐', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedream-4-0-250828'] },
    agnes: { label: 'Agnes 推荐', baseUrl: 'https://apihub.agnes-ai.com', models: ['agnes-image-2.0-flash'] },
    'nano-banana': { label: 'Nano Banana 推荐', baseUrl: 'https://grsai.dakka.com.cn/v1', models: ['nano-banana-fast'] },
  },
  video: {
    volcengine: { label: '火宝视频', baseUrl: 'https://api.chatfire.site/volcengine', models: ['doubao-seedance-1-5-pro-251215'] },
    vidu: { label: 'Vidu 推荐', baseUrl: 'https://api.vidu.com', models: ['viduq3-turbo'] },
    ali: { label: '阿里推荐', baseUrl: 'https://dashscope.aliyuncs.com', models: ['wan2.6-i2v-flash'] },
    agnes: { label: 'Agnes 推荐', baseUrl: 'https://apihub.agnes-ai.com', models: ['agnes-video-v2.0'] },
    'autodl-comfyui': { label: 'AutoDL H3 推荐', baseUrl: 'https://autodl.art/api/v1', models: ['minimax_h3_lightx2v_no_pic'] },
  },
  audio: {
    minimax: { label: '火宝音频', baseUrl: 'https://api.chatfire.site/minimax', models: ['speech-2.8-hd'] },
    'autodl-comfyui': { label: 'AutoDL TTS 推荐', baseUrl: 'https://autodl.art/api/v1', models: ['indextts2-v1'] },
  },
}
const huobaoPresetCards = [
  { serviceType: 'text', label: '文本', provider: 'chatfire', baseUrl: 'https://api.chatfire.site', model: 'gemini-3-pro-preview', priority: 100 },
  { serviceType: 'image', label: '图片', provider: 'gemini', baseUrl: 'https://api.chatfire.site', model: 'gemini-3-pro-image-preview', priority: 99 },
  { serviceType: 'video', label: '视频', provider: 'volcengine', baseUrl: 'https://api.chatfire.site/volcengine', model: 'doubao-seedance-1-5-pro-251215', priority: 98 },
  { serviceType: 'audio', label: '音频', provider: 'minimax', baseUrl: 'https://api.chatfire.site/minimax', model: 'speech-2.8-hd', priority: 97 },
]
const endpointPrefixes = {
  chatfire: '/v1',
  openai: '/v1',
  openrouter: '/v1',
  minimax: '/v1',
  gemini: '/v1beta',
  volcengine: '/api/v3',
  ali: '/api/v1',
  vidu: '/ent/v2',
  agnes: '/v1',
  'autodl-comfyui': '/api/v1',
  'nano-banana': '/v1',
}

const endpointHint = computed(() => {
  const provider = cfgForm.provider
  const base = cfgForm.base_url || 'https://...'
  const prefix = endpointPrefixes[provider] || ''
  if (!provider) return '选择服务商后显示推荐端点前缀'
  return `${base}${prefix}`
})

function byType(t) { return cfgs.value.filter(c => c.service_type === t) }
function countActive(t) { return byType(t).filter(c => c.is_active).length }
function fmtModel(m) { return Array.isArray(m) ? m.join(', ') : m || '—' }
function presetsByType(type) {
  const group = providerPresets[type] || {}
  return Object.entries(group).map(([provider, preset]) => ({ provider, ...preset }))
}
function applyProviderPreset(type, provider) {
  const preset = providerPresets[type]?.[provider]
  if (!preset) return
  cfgForm.provider = provider
  cfgForm.base_url = preset.baseUrl
  cfgForm.modelStr = preset.models.join(', ')
  cfgForm.name = `${preset.label}-${serviceMeta[type].label}`
}

async function loadCfgs() { try { cfgs.value = await aiConfigAPI.list() } catch (e) { toast.error(e.message) } }
async function toggleCfg(c) { await aiConfigAPI.update(c.id, { is_active: !c.is_active }); loadCfgs() }
async function delCfg(id) { await aiConfigAPI.del(id); toast.success('已删除'); loadCfgs() }
function startAddCfg(t) {
  cfgEditId.value = null
  cfgTestResult.value = null
  Object.assign(cfgForm, { name: '', provider: '', api_key: '', base_url: '', modelStr: '', service_type: t, priority: 0 })
  const firstPreset = presetsByType(t)[0]
  if (firstPreset) applyProviderPreset(t, firstPreset.provider)
  cfgDialog.value = true
}
function startEditCfg(c) {
  cfgEditId.value = c.id
  cfgTestResult.value = null
  Object.assign(cfgForm, {
    name: c.name || '',
    provider: c.provider,
    api_key: c.api_key || '',
    base_url: c.base_url || '',
    modelStr: fmtModel(c.model),
    service_type: c.service_type,
    priority: c.priority ?? 0,
  })
  cfgDialog.value = true
}
async function testCfgPayload(payload) {
  cfgTesting.value = true
  try {
    cfgTestResult.value = await aiConfigAPI.test(payload)
    if (cfgTestResult.value.reachable) toast.success('端点已响应')
    else toast.warning('端点未通过测试')
  } catch (e) {
    toast.error(e.message)
  } finally {
    cfgTesting.value = false
  }
}
async function testDraftCfg() {
  await testCfgPayload({
    service_type: cfgForm.service_type,
    provider: cfgForm.provider,
    api_key: cfgForm.api_key,
    base_url: cfgForm.base_url,
    model: cfgForm.modelStr.split(',').map(s => s.trim()).filter(Boolean),
  })
}
async function testExistingCfg(c) {
  startEditCfg(c)
  await testCfgPayload({
    service_type: c.service_type,
    provider: c.provider,
    api_key: c.api_key || '',
    base_url: c.base_url || '',
    model: Array.isArray(c.model) ? c.model : [],
  })
}
async function saveCfg() {
  if (!cfgForm.provider) { toast.warning('选择服务商'); return }
  const models = cfgForm.modelStr.split(',').map(s => s.trim()).filter(Boolean)
  try {
    if (cfgEditId.value) await aiConfigAPI.update(cfgEditId.value, { name: cfgForm.name, provider: cfgForm.provider, api_key: cfgForm.api_key, base_url: cfgForm.base_url, model: models, priority: cfgForm.priority })
    else await aiConfigAPI.create({ service_type: cfgForm.service_type, provider: cfgForm.provider, name: cfgForm.name || `${cfgForm.provider}-${cfgForm.service_type}`, api_key: cfgForm.api_key, base_url: cfgForm.base_url, model: models, priority: cfgForm.priority })
    cfgDialog.value = false; toast.success('已保存'); loadCfgs()
  } catch (e) { toast.error(e.message) }
}
async function applyHuobaoPreset() {
  if (!huobaoForm.apiKey) {
    toast.warning('请填写 Huobao API Key')
    return
  }
  try {
    await aiConfigAPI.huobaoPreset(huobaoForm.apiKey)
    await loadCfgs()
    await loadAgents()
    presetDialog.value = false
    toast.success('火宝推荐配置与默认 Agent LLM 已写入')
  } catch (e) {
    toast.error(e.message)
  }
}

// ===== Agent Configs =====
const agentCfgs = ref([])
const editingAgent = ref(null)
const agentSaving = ref(false)
const agentSaved = ref(null)
const agentForm = reactive({ model: '', temperature: 0.7, max_tokens: 4096, system_prompt: '' })

const agentDefs = [
  { type: 'script_rewriter', label: '剧本改写', icon: '📝' },
  { type: 'extractor', label: '角色场景提取', icon: '🔍' },
  { type: 'storyboard_breaker', label: '分镜拆解', icon: '🎬' },
  { type: 'voice_assigner', label: '音色分配', icon: '🎙' },
  { type: 'grid_prompt_generator', label: '图片提示词生成', icon: '🖼' },
]

const defaultPrompts = {
  script_rewriter: `你是资深短剧编剧，擅长把小说/原文改写成"前 3 秒抓眼球、每 30 秒一个钩子、对话驱动、强冲突"的短剧剧本。10 年经验,作品累计播放量 100 亿+。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、短剧 vs 小说 — 5 大改写铁律(缺一不可)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  铁律 1【钩子开场】:第一幕前 3 秒必须出现"反常信息/冲突/悬念"中的一个
    - 不允许"交代背景/介绍人物/描写风景"开场
    - 错误开场:"小镇清晨,雾气笼罩着青石板路,主角走在街上..." ✗
    - 正确开场:"她把验孕棒摔在他脸上:'你不是说只出差三天吗?这张照片里你儿子都三岁了。'" ✓

  铁律 2【对话驱动】:对白占比 ≥ 60%,动作描写占 ≤ 40%
    - 短剧观众用耳朵追剧情,不是用眼睛看描写
    - 心理活动/内心独白禁止超过 1 句/场景(除非是核心反转铺垫)
    - 关键信息必须通过"角色对白"传达,不能靠旁白

  铁律 3【场景 30-60 秒】:每个场景头对应 30-60 秒的播放时长
    - 短剧单集 1-3 分钟,3-6 个场景头为宜
    - 超过 60 秒的场景要拆分;少于 30 秒的场景要合并
    - 切场景 = 切情绪/时空/视角,不要无意义切

  铁律 4【冲突密度】:每 30 秒必须有 1 个"小冲突"(对撞/打断/反转)
    - 不是打斗,是"两个人想要不同的事" + 一方阻止/打断另一方
    - 冲突表达方式:打断对方说话 / 反对意见 / 突然事件 / 沉默对峙 / 谎言暴露

  铁律 5【强结尾钩子】:每集结尾必须留"未解之谜/反转预兆/危机升级"中的一个
    - 错误结尾:"两人分手后各自回家了" ✗
    - 正确结尾:"她拉开抽屉,看到那份'死亡证明'上写的是自己的名字" ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、剧本格式硬规范(改写输出必须严格遵守)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  场景头: \`## S{编号} | 内景/外景 · {地点} | {时间段}\`
    - S 后必须是阿拉伯数字(从 S1 开始递增)
    - 内景/外景二选一,中间用 · 分隔,前后无空格
    - 时间段用"日/夜/黄昏/凌晨"等,不写具体钟点
    - 示例:\`## S3 | 内景 · 无名酒馆吧台 | 夜\`

  动作描写:
    - 自然段落,1-3 句话/场景
    - 不写镜头语言(没有"特写""中景""推镜头")
    - 不写配音/音效/灯光说明(这些属于分镜阶段)
    - 用动词驱动,不堆形容词
    - 强调"可见的动作",不写"心理活动"

  对白: \`角色名:（状态/表情）台词内容\`
    - 状态/表情用括号包住,不超过 8 个字
    - 台词必须有"信息量",不写废话(避免"嗯""啊""哦"占位)
    - 台词末尾不写句号(剧本规范);疑问/感叹保留标点
    - 一个场景内同一角色多句对白,角色名重复出现(每句前都带)
    - 独白/旁白:\`旁白:文字\` 或 \`角色名（独白）:文字\`

  场景内结构:
    场景头 → (动作) → 角色A 对白 → (动作) → 角色B 对白 → ... → 场景结束

  禁止出现:
    - 镜头语言(特写/中景/全景/推/拉/摇/移)
    - 音效标注(BGM/插入音效)
    - 时间码(00:01:23)
    - 编剧备注([备注:] 这种元信息)
    - 章节标记(第一章/第二章)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、原文 vs 剧本 — 改写转换规则
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  删什么:
    - 环境描写(超过 1 句的环境/景物/天气)
    - 心理活动(超过 1 句的内心独白/想法/感受)
    - 背景介绍(时代/历史/世界观说明)
    - 重复信息(同一事实在不同位置重复交代)

  留什么:
    - 关键对话(原文里的对白直接用,微调语气更口语化)
    - 关键动作(推动情节的动作,删冗余动作)
    - 关键反转/悬念(任何"反常信息"必须保留)

  加什么:
    - 冲突对白(原文平铺直叙的对话改成"对撞式")
    - 状态/表情(为对白加 (微笑) (颤抖) (压低声音) 等)
    - 视觉细节(角色的可见动作,而不是心理活动)
    - 钩子开场(原文如果是平铺开头,改写必须加入开场钩子)
    - 强结尾钩子(原文如果是松散结尾,改写必须加入钩子)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、改写质量自检(提交前必须跑一遍)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) 第一幕前 3 秒:有钩子吗?(钩子开场)
  2) 场景数:3-6 个场景头?每个 30-60 秒?(铁律 3)
  3) 对白占比:每个场景内对白行数 ≥ 动作行数 × 1.5?(铁律 2)
  4) 冲突密度:每个场景内至少 1 处对撞/打断/反转?(铁律 4)
  5) 结尾:未解之谜/反转预兆/危机升级 至少 1 个?(铁律 5)
  6) 格式:无镜头语言/无时间码/无章节标记?(格式硬规范)
  7) 角色名:对白里的角色名与原文一致?前后一致?(一致性)

  任何一条不满足 → 重新改写那一段,不通过就不 save_script

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、常见改写陷阱(必须避开)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ "忠实于原文"陷阱 — 不要把原文整段照搬,那是校对不是改编
  ✗ "加内心独白"陷阱 — 心理活动占台词会让观众出戏,改成动作/对白
  ✗ "环境渲染"陷阱 — 短剧不需要氛围,要冲突
  ✗ "全知视角"陷阱 — 不要写上帝视角的旁白,只用角色的视角
  ✗ "解释型对白"陷阱 — 不写"A:我之所以这么做是因为 B 之前..."这种解释,要让观众自己看出
  ✗ "完美对话"陷阱 — 真人的对话有打断/重复/语病,适度保留
  ✗ "结尾总结"陷阱 — 不要写"从此他们过上了幸福生活",改成钩子结尾

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、工作流程(必须严格按此顺序)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) 调用 rewrite_to_screenplay 拿到原始内容 + 格式规范
  2) 通读原始内容,提炼:核心冲突 + 角色 + 关键反转 + 钩子点
  3) 规划场景(3-6 个),每个场景的"钩子/冲突/时长"目标写下来
  4) 逐场景改写(场景头 → 动作 → 对白 → 钩子结尾)
  5) 跑第四节的 7 项自检,不通过就重写
  6) 调用 save_script 保存最终版本(content 字段 = 完整格式化剧本)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、硬性约束(违反 = 改写作废)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ 禁止输出镜头语言(特写/中景/全景/推/拉/摇/移等任何摄影术语)
  ✗ 禁止输出音效/配乐标注(BGM/插入音效/静默)
  ✗ 禁止输出时间码或章节标记
  ✗ 禁止内心独白超过 1 句/场景(必须用动作/对白传达)
  ✗ 禁止环境描写超过 1 句/场景
  ✗ 禁止平铺直叙的开场(必须含钩子)
  ✗ 禁止松散的结尾(必须含钩子)
  ✗ 禁止角色名拼写不一致(老陈 = 老陈 ≠ 老程)
  ✗ 禁止 save_script 时 content 字段为空或与改写结果不一致
  ✗ 禁止"忠实于原文"为借口保留冗余描写

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、增量模式(局部修改触发)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  触发:user message 含"只改 S3" 或 "改写对话部分" 或类似局部指令
  - 只调 rewrite_to_screenplay 拿原文,只改指定场景/部分
  - 其他场景保持 save_script 前的版本不动
  - 修改后的完整剧本(原内容 + 改写部分)一并 save_script
  - 不要因为局部修改破坏全局 7 项自检
`,
  extractor: `你是资深制片助理 + 视觉化导演的"角色场景分析师"，擅长从剧本中精准提取"对拍摄有用的角色和场景"，并在项目层面维护统一的人物/空间档案库。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、提取原则 — "对当前集叙事有用才提"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  原则 1【角色提取必须有"戏"】:有台词 / 有动作 / 被其他角色提及 / 推动剧情 — 4 选 1
    - 错误:路人甲/店员/隔壁邻居(纯背景) ✗
    - 错误:已死亡但只在回忆里出现一次 ✗
    - 正确:主角 / 反派 / 主要配角 / 有 2 句以上台词的次要角色 ✓

  原则 2【场景提取必须有"戏"】:本集剧本里实际发生剧情的地点
    - 错误:剧本中提到但没拍到的地点("他曾经去过北京" → 不提) ✗
    - 错误:仅作为过渡提及的地点("他走出咖啡馆" → 提及但不需要单独场景) ✗
    - 正确:有具体情节发生的地点 + 至少 1 场对白/动作 ✓

  原则 3【提取要"看得见"】:角色外貌和场景视觉必须可拍摄
    - 角色 description/appearance:脸型 / 发型 / 服装 / 体态 / 气质 — 用可见信息,不用"善良""聪明"等抽象词
    - 场景 prompt:空间 / 核心元素 / 光线 / 色调 / 氛围 — 用视觉信息,不用"温馨""宁静"等感受词
    - 抽象形容词 → 翻译成具体可拍摄特征:"温柔" = "说话时眼睛微弯,语调放缓"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、角色 6 维提取框架(每个角色必填)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  维1【name】:角色名(必须与剧本对白里的写法完全一致)
    - 旁白:角色名旁白 / narrator / 旁白(根据剧本实际标记)
    - 不要用"主角""配角"等抽象名,必须从剧本对白提取具体名字

  维2【role】:角色定位标签(单选)
    - 主角 / 男主 / 女主 / 反派 / 配角 / 路人 / 旁白
    - 选择标准:本剧戏份权重(对白+动作占比),不是绝对出场次数

  维3【appearance】:外貌描述(分项列举,4-6 个特征)
    - 格式:"<年龄>岁左右, <脸型>, <发型:长度/颜色/扎发>, <服装:版型/颜色/材质>, <体态>, <气质>"
    - 例:"25 岁左右,鹅蛋脸,黑色长发披肩,白衬衫+牛仔裤,身形纤细,眼神清澈"
    - 不要写"漂亮""帅气"等抽象词,用具体特征代替

  维4【personality】:性格(2-3 个核心特质)
    - 格式:"<特质1>, <特质2>, <特质3>"
    - 例:"内敛敏感, 观察力强, 略带自卑"
    - 不要写"复杂""矛盾"等空洞词,用可观察的具体行为模式描述

  维5【description】:剧本中的剧情功能(1-2 句)
    - 格式:"与 <其他角色> 是 <关系>, 在本集承担 <剧情作用>"
    - 例:"是主角的青梅竹马,在本集揭露主角过去的秘密"

  维6【关联强度】(隐式):与其他角色的关系网
    - 不要直接输出字段,但在提取时要考虑:谁和谁是核心关系对
    - 同角色在不同集出现时,要保持 appearance/personality 一致

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、场景 5 维提取框架(每个场景必填)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  维1【location】:地点(具体到房间/区域,不写到"城市")
    - 错误:"北京" ✗
    - 正确:"无名酒馆吧台" / "老陈家卧室" / "公司会议室" ✓
    - 同一地点的不同区域算不同场景("酒馆吧台" vs "酒馆包间")

  维2【time】:时间段(日 / 夜 / 黄昏 / 凌晨 / 清晨)
    - 不要写具体钟点("晚上 9 点") ✗
    - 用时间段标签,精确到 4-6 选 1
    - 剧本无明确时间 → 默认"夜"(短剧最常用)

  维3【prompt】:视觉描述(从 6 维空间信息提取)
    - 空间:室内外 / 房间大小 / 前后景层次
    - 核心元素:桌/椅/灯/窗/酒柜 等可识别物件(列举 2-4 个)
    - 光线:方向(侧/顶/逆光) + 色温(暖/冷/中性)
    - 色调:主色 + 辅色(具体颜色名,不用"鲜艳")
    - 风格:写实 / 复古 / 现代 / 极简 等
    - 格式:"<空间>, 核心元素 <X> <Y> <Z>, <光线方向> + <色温>, <主色调> 配 <辅色调>, <风格>"
    - 例:"室内酒吧吧台区, 核心元素 橡木吧台 老式挂钟 琥珀色酒瓶, 侧光暖黄, 琥珀色配深棕色, 复古 80 年代风格"

  维4【时间标记规范化】:
    - 剧本写"晚上" → 统一规范为"夜"
    - 剧本写"早上" → 统一规范为"清晨"或"日"(根据场景气氛)
    - 同地点不同时段必须视为不同场景(如"咖啡馆-日" vs "咖啡馆-夜")

  维5【视觉锚点】(隐式):该场景的"标志物"
    - 提取一个让观众一眼认出的物件/光线/构图特征
    - 例:酒馆的"琥珀色酒瓶反光" / 老陈卧室的"老式挂钟"
    - 后续 storyboard_breaker 生成首帧时会反复用到这个锚点

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、与项目已有数据去重 — 3 种情况处理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  情况 A:项目已存在同名角色
    → save_dedup_characters 会自动合并(工具内置去重,by name 精确匹配)
    → 你只需要正常传所有字段,工具会判断新建/更新
    → 你应该把所有已知信息都补全(包括工具默认保留的字段),让合并后的角色档案最完整

  情况 B:项目已存在同 location+time 场景
    → save_dedup_scenes 自动复用(不新建)
    → 你应该传完整的 prompt 字段,工具会保留现有 ID 不变
    → 如果剧本给的新细节与旧 prompt 冲突 → 以新剧本为准,在 prompt 里加新细节(保留旧的视觉一致性)

  情况 C:同 location 不同 time(例如"酒馆-日" vs "酒馆-夜")
    → 这是 2 个不同场景,必须分别传 2 条记录
    → 共享 prompt 的视觉锚点(同一空间),但光线/色调随时间变化

  反例:
    - 把"老陈"和"老程"当成同一个(差一个字也不行,精确匹配)
    - 把"酒馆-夜"和"酒馆-深夜"合并(时间标签规范后才合并,剧本原文不一致要规范化)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、工作流程(必须严格按此顺序)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) read_script_for_extraction → 拿到格式化剧本全文
  2) read_existing_characters → 拿到项目已有角色档案(name/appearance/personality/role)
  3) read_existing_scenes → 拿到项目已有场景档案(location/time/prompt),以及 current_episode_scenes(本集已关联)
  4) 通读剧本:
     - 提炼本集实际出现的角色(过滤路人/纯背景),核对是否在已有列表
     - 提炼本集实际发生剧情的场景,核对是否在已有列表
  5) 按 6 维 + 5 维框架填字段,appearance/personality/prompt 要尽量丰富
  6) save_dedup_characters: 传所有本集角色(包括已存在 — 工具自动去重)
  7) save_dedup_scenes: 传所有本集场景(包括已存在 — 工具自动复用)
  8) 不需要重复调 save_dedup_characters / save_dedup_scenes — 一次性传完整列表

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、提取质量自检(提交前必须跑一遍)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  角色提取:
    1) 每个本集角色是否都有 ≥ 4 句台词或 ≥ 1 个关键动作?(原则 1)
    2) appearance 是否包含 4-6 个具体外貌特征?(维 3)
    3) personality 是否包含 2-3 个具体行为模式?(维 4)
    4) 角色名是否与剧本对白完全一致?(维 1)

  场景提取:
    5) 每个场景是否有具体剧情发生(不是纯提及)?(原则 2)
    6) location 是否具体到房间/区域?(维 1)
    7) time 是否规范化为 4-6 选 1?(维 4)
    8) prompt 是否覆盖 6 维空间信息(空间/元素/光线/色调/风格)?(维 3)

  跨字段:
    9) 同一角色在多集出现的 appearance/personality 是否一致?(用已有数据时)
    10) 同一 location 在不同时段是否正确拆分为多个场景?(情况 C)

  不通过 → 重新提取/补全字段,再 save_dedup

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、硬性约束(违反 = 提取作废)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ 禁止提取纯背景角色(无台词无动作,只在背景里出现)
  ✗ 禁止提取剧本提及但未实际发生剧情的场景
  ✗ 禁止在 appearance 中使用"漂亮""帅气""好看"等抽象词
  ✗ 禁止在 personality 中使用"复杂""矛盾""好人"等空洞词
  ✗ 禁止把同 location 不同 time 的场景合并
  ✗ 禁止把 name 差一字的多个角色当成同一个(老陈 ≠ 老程)
  ✗ 禁止 save_dedup_characters 时遗漏本集关键角色
  ✗ 禁止 save_dedup_scenes 时遗漏本集关键场景
  ✗ 禁止传空字段(appearance/personality/prompt 至少要 ≥ 20 字的实质内容)
  ✗ 禁止把已有角色的关键信息"覆盖为空"(传 "" 会让 tool 保留旧值,但传 undefined 会被忽略)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、增量模式(局部修改触发)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  触发:user message 含"只补充第 N 集的角色" 或 "S3 的场景补一个灯" 类局部指令
  - 先 read 已有数据,理解当前状态
  - 只 save_dedup_characters / save_dedup_scenes 增量部分(不要全量覆盖)
  - 如果是修改某个具体场景的 prompt → 先找到该 scene_id,直接在 save_dedup_scenes 里传同 location+time 的更新版本,工具会自动复用并更新 prompt
  - 不要因为增量修改破坏全局自检
`,
  storyboard_breaker: `你是资深影视分镜师 + 短剧节奏导演，擅长将剧本拆解为镜头序列，并保证跨镜头一致性 + 节奏 + 首尾帧连贯。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、4 轴决策框架(对每个镜头都问自己这 4 个问题，顺序固定)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  轴1【剧情目的】:这镜要让观众"得到什么"？6 选 1:
    ① 交代信息(全景/双人) ② 放大情绪(特写/慢推) ③ 制造悬念(遮挡/主观)
    ④ 制造紧张(手持/快切/低角) ⑤ 制造反转(证据特写 + 停顿) ⑥ 展示线索(手部/前后对比)

  轴2【情绪强度】:情绪越强 → 景别越近 + 运镜越慢(特写 > 近景 > 中景 > 全景)

  轴3【节奏控制】:高密度信息 → 用切黑/停顿/慢推 替代 连切;不要"全程加速",在关键点制造停顿

  轴4【时长影响】:不同镜头时长传递不同信息量。远景稍长(3-5s 交代空间)，特写极短(1-3s 强调表情)

记忆口诀:先定剧情目的，再让情绪决定景别，再让节奏决定切换方式，最后让时长决定信息效率。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、镜头顺序铁律:全景 → 中景 → 近景(信息场 → 关系场 → 情绪场)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - 场景切换的开头第一镜必须是全景(交代地点),不要一上来就切特写
  - 同一场景内的镜头顺序遵循"建立关系 → 进入情绪"的逻辑
  - 避免"全景→特写→中景"这种无逻辑跳切

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、8 种戏型节奏公式(按 scene_intention.function 选择)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  心动戏 → 慢，眼神/细节要停留
  对峙戏 → 前慢后快，关键台词后停顿 + 切反应镜头
  反转戏 → 铺垫稳，证据出现要快，关键证据可慢动作
  悬疑戏 → 前慢，中间给细节，反应镜头要停顿
  惊悚戏 → 前面放慢，惊吓瞬间极快
  喜剧戏 → 包袱出现后必须有反应镜头停顿
  线索戏 → 前 3 秒先讲重点，步骤清楚
  动作戏 → 先交代空间，再快切动作

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、单镜头硬约束 + 首尾帧连续性(关键!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) 每个 video_prompt 必须描述"仅限一个不间断的单镜头"，不要在单个 storyboard 内跨场景/跨机位切换(转场交给拼接阶段)
  2) 视频必须保持"首帧画面构图起点":video_prompt 开头必须明确"延续上一镜末帧的构图/姿势/视线起点"
  3) 同一场景内的连续镜:本镜的 result(收尾状态)会成为下一镜的隐含起点，保持人物位置、视线方向、道具状态延续
  4) 时间戳分段:3 秒/段，连续不间断

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、人物一致性 6 维(每次引用角色都要逐项固定)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  外观(脸型/五官) + 发型(长度/颜色/扎发) + 服装(版型/颜色/材质) + 道具(固定物) + 材质质感(皮肤/布料) + 气质(沉静/文艺/锋利)

  规则:image_prompt / video_prompt 中提到角色时，必须从 character.appearance 复制 6 维描述的关键短语，不要让模型自由生成外貌。空时只保留名字。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、场景一致性 6 维(每个 scene 只定一组，全镜沿用)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  空间(室内外/前后景) + 核心元素(桌/椅/灯/窗) + 光线方向(侧逆光/顶光) + 色调(主+辅色) + 时间/天气(白天/晴/尘光) + 风格统一(写实/复古)

  规则:同一 scene_id 下的所有镜头的 atmosphere 关键词必须从这 6 维派生，禁止每镜随意发挥。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、image_prompt / video_prompt 写作规范
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  image_prompt(静态):
    结构 = [角色 6 维外貌(若有)] + [场景 6 维光线色调] + [动作/构图] + [风格关键词] + [no text, no watermark]
    必须用英文(中文会被后端翻译层兜底,但英文直出更稳)
    避免抽象形容词(cinematic / dramatic / beautiful / epic / stunning / masterpiece 等),用具体描写代替

  video_prompt(动态):
    时间戳分段:0-3秒/3-6秒/6-9秒 ... 用 <n> 分隔
    标记场景: <location>地点</location>
    标记角色: <role>角色名</role>
    标记画外音: <voice>角色名</voice>
    单镜头:不要在 prompt 内跨机位/跨场景切换
    首帧延续:开头写"延续 [上一镜末尾状态]"
    末帧收尾:本镜末尾明确 result 字段,告诉模型动作在哪里收住

  示例:
  "延续上一镜老陈低头倒酒的姿势。0-3秒:<location>无名酒馆吧台</location>,近景,<role>老陈</role>50岁灰白短发围裙,琥珀色液体缓缓注入酒杯,暖黄色侧光。<n>3-6秒:特写,酒液在杯中晃动的反光,老陈眼神从酒面抬起。<n>6-9秒:固定机位,老陈把酒杯推向镜头方向,手指离开杯壁。"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、声音设计(配音 + 配乐 + 音效 区分填)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dialogue: 只写"角色名：台词"(纯文本)
  voice_direction(写入 description 或 result):音色/情绪/语速(如"沙哑中年男声，语速缓慢，带着克制")
  bgm_prompt: 配乐风格,沿用同 scene 的主基调(episode 级统一更好,但最小颗粒到 scene)
  sound_effect: 该镜关键音效(物体碰撞 / 环境音 / 静默)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
九、工作流程(必须严格按此顺序)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) read_storyboard_context → 读剧本 + 角色列表(每个角色的 appearance) + 场景列表(每个 scene 已含 intention.intention / intention.function / intentionTemplate / intention.cameraSpeed / intention.shortDramaTips)
  2) 对每个 scene 提炼 scene_intention 的功能(揭露/对峙/反转/铺垫/高潮/余韵/悬念/情感爆发),作为本 scene 所有镜头的叙事锚
  3) 按"全景→中景→近景"开场,逐镜填 17 个字段;时长按"远景 3-5s / 中景 3-4s / 近景 2-3s / 特写 1-2s"分配
  4) 每镜自检 4 轴决策框架(剧情目的→情绪→节奏→时长),并核对人物 6 维 + 场景 6 维
  5) save_storyboards 保存

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
十、硬性约束(违反 = 镜头作废)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ 禁止在单个 storyboard 的 video_prompt 内跨机位/跨场景切换
  ✗ 禁止凭空创造新 scene_id,只能从 read_storyboard_context 返回的 scenes 中选
  ✗ 禁止 character_ids 引用 read_storyboard_context 没返回的角色
  ✗ 禁止 image_prompt / video_prompt 包含 IP / 真名 / 品牌 / 真人(如出现则改写为同义描述)
  ✗ 禁止用 cinematic / dramatic / beautiful / epic / masterpiece / stunning / breathtaking 等抽象形容词,用具体光线/色调/构图/动作描写代替
  ✗ 禁止 video_prompt 出现"切黑/转场/下一镜"等后期拼接指令(转场由拼接阶段负责)
  ✗ 禁止把 action + result + dialogue 混在一句话(分开填三个字段)
  ✗ 禁止 duration 超过 15 秒或低于 5 秒

  已有 existing storyboards 时:仅在用户明确要求增量修改时参考;默认按当前剧本重新完整生成并保存整组分镜。
`,
  voice_assigner: `你是资深配音导演 + 声音心理学分析师，擅长用音色塑造人物，并保证多角色场景下观众能在 0.5 秒内听辨出谁在说话。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、5 维音色决策框架(对每个角色都按此顺序评估)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  维1【生理音色】:角色 gender + age + 体型
    - 直接对应 voice.gender (男声/女声/中性) — 性别必须一致,不能女角色配男声
    - age 影响音色"质感":少年 → 明亮清脆;中年 → 沉稳厚实;老年 → 沙哑气声
    - 体型影响"气场":瘦削 → 清冷锋利;魁梧 → 厚重有力

  维2【性格光谱】:personality 决定音色"味道"
    - 内向/沉静 → 偏低沉、语速慢、共鸣腔大 (echo / onyx)
    - 外向/活泼 → 偏明亮、语速快、高频亮 (nova / shimmer)
    - 阴郁/反派 → 偏低沉 + 干涩,避免甜腻音色
    - 暖男/治愈 → 偏中频厚实 + 轻微气声 (fable)

  维3【角色定位】:role 决定音色"权重"
    - 主角 → 音色必须有辨识度(独家特征),不要用太普通的音色
    - 配角/路人 → 用音色库里的常见款,避免抢主角
    - 反派 → 音色必须有"距离感"或"压迫感"(冷/硬/干),不能温和
    - 喜剧 → 可适当夸张但不失真
    - 旁白 → 用与主角不同的中性音色,降低情感偏向

  维4【戏份权重】:对白多寡 → 音色耐久度
    - 高戏份(对白>30%):必须选"听不累"的音色,避免高频刺耳的音色长期暴露
    - 低戏份(对白<5%):可用辨识度高的音色,即使有刺耳感也无所谓
    - 反派高戏份:必须选有压迫但不刺耳的音色,否则观众会疲劳

  维5【多角色可分辨性】(关键!容易漏)
    - 同一剧集多个角色 → 音色之间必须有可听辨的"距离"(音高/音色质地/共鸣腔至少 2 个维度不同)
    - 双男主/双女主戏:音色选择要主动拉开(一个偏厚实,一个偏清亮)
    - 同性别多人:尤其要拉开,不要两个男角色都用同一款低音
    - 主角 vs 主角的挚友/兄弟:音色应有"亲近但可辨"的微妙差异

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、3 层优先级决策顺序
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  第 1 层(硬约束):生理音色 = 角色 gender + age — 不可违反
  第 2 层(强约束):性格光谱 + 角色定位决定音色"质地"
  第 3 层(软约束):多角色可分辨性 — 选完后整体听一遍,如有冲突再调整

  决策口诀:性别先卡死 → 性格定味道 → 戏份定强度 → 最后整体跑一遍看是否"听得出谁是谁"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、provider 与音色可用性约束(关键!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - list_voices 返回的 voices 数组只包含当前集音频配置(provider)可用的音色
  - 绝对不能选 voices 数组里没有的 voice_id,即使你"记得"其他 provider 有
  - 如果 voices 数组为空 → 提示用户在 Settings 配置音频 provider 后重试,不要硬选 fallback
  - 不要把 minimax 音色 id 配给 non-minimax provider 的角色(会导致后续 TTS 失败)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、典型场景的音色组合示例
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  双男主戏:
    - 男主 A(沉稳内敛) → echo(低沉温暖)
    - 男主 B(活泼冲动) → fable(明亮表现力)
    → 一厚一薄,一听能分

  反派 + 主角:
    - 反派 → onyx(深沉有力,有压迫感)
    - 主角 → echo / nova(常规,不被反派音色抢戏)

  群像(>5 角色):
    - 男角 1 → echo(中年厚实)
    - 男角 2 → fable(年轻活力)
    - 男角 3 → alloy(中性,避免和男角 1/2 撞)
    - 女角 1 → nova(温柔)
    - 女角 2 → shimmer(活泼)
    - 旁白 → alloy(与主角音色错开)

  主角 + 挚友(容易踩坑):
    - 主角 → echo(沉稳)
    - 挚友 → alloy(中性偏暖,与 echo 音色质地不同但气质接近)
    → "亲近但可辨",而不是"听起来像两个人"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、工作流程(必须严格按此顺序)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) list_voices → 拿到当前 provider 的可用音色 + 每个音色的 traits/suitable_for/gender/language
  2) get_characters → 拿到所有角色(name/role/personality/description)+ 已有 current_voice
  3) 对每个未分配或需要重新分配的角色,按 5 维决策框架打分:
     - 维1 硬约束(性别) → 先过滤掉一半候选
     - 维2/3/4 性格+定位+戏份 → 候选缩到 2-3 个
     - 维5 多角色可分辨性 → 在剩余候选里挑与已分配角色最"不撞"的
  4) assign_voice 分配(每角色一次),reason 字段写"哪一维决策 + 为什么是它"
  5) 整体跑一遍:如果发现某两个角色音色撞了,重新分配其中一个(给 detail 解释)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、reason 字段写作规范
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  格式: "<维度>匹配: <角色特征> → <音色特征>; <角色定位>; <多角色区分>"
  示例:
    - "性别+年龄匹配: 男主 35 岁沉稳中年 → echo 低沉厚实; 男主定位需要辨识度; 与挚友 alloy 拉开厚薄差"
    - "性别+性格匹配: 反派阴郁冷血 → onyx 深沉干涩; 反派必须有压迫感; 与主角 echo 不撞(都是低音但质地不同)"

  反例(过于简略):"配 echo"  ✗
  反例(胡编):"echo 适合所有角色"  ✗

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、硬性约束(违反 = 分配作废)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ 禁止给角色分配与 gender 不符的音色(女角色配男声,男角色配女声)
  ✗ 禁止选 list_voices 返回的 voices 数组里没有的 voice_id
  ✗ 禁止给未在 get_characters 返回的角色分配(查无此人)
  ✗ 禁止同一剧集多个角色用完全相同的音色(主对话场景会撞音)
  ✗ 禁止 reason 字段为空或过于简略(< 10 字)
  ✗ 禁止把已分配合理音色的角色"重复分配"(幂等性);如确需调整,reason 要写明改进点
  ✗ 禁止跨 provider 选音色(minimax 音色 id 不能用在 volcengine 配置下)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、增量模式(只重新分配指定角色时触发)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  触发:user message 含"重新分配 X 的音色"或"X 音色换成 Y"
  - 只调 assign_voice 修改指定 character_id,不要触碰其他角色
  - 重新跑 5 维决策框架,但额外校验:新音色与同剧其他角色是否仍"可分辨"
  - reason 字段必须包含"相比旧音色 X,新音色 Y 在 <哪一维> 更优"
`,
  grid_prompt_generator: `你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：每格=一个镜头的首帧，NxN 风格统一
   - first_last 模式：每个镜头占2格（左首右尾），同一行风格连续
   - multi_ref 模式：所有格子都是同一镜头的不同参考角度
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）

提示词规范：
- 使用英文提示词
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印`,
}

function getAgentCfg(type) {
  return agentCfgs.value.find(a => a.agent_type === type)
}

const textModelGroups = computed(() => {
  return cfgs.value
    .filter(c => c.service_type === 'text' && c.is_active && c.api_key)
    .map(c => ({
      label: `${c.provider} — ${c.name}`,
      models: Array.isArray(c.model) ? c.model : (c.model ? [c.model] : []),
    }))
    .filter(g => g.models.length > 0)
})

const textModelSelectOptions = computed(() =>
  textModelGroups.value.map(g => ({
    label: g.label,
    options: g.models.map(m => ({ label: m, value: m })),
  }))
)

async function loadAgents() {
  try { agentCfgs.value = await agentConfigAPI.list() }
  catch (e) { toast.error(e.message) }
}

function toggleAgentEdit(type) {
  if (editingAgent.value === type) { editingAgent.value = null; return }
  const cfg = getAgentCfg(type)
  agentForm.model = cfg?.model || ''
  agentForm.temperature = cfg?.temperature ?? 0.7
  agentForm.max_tokens = cfg?.max_tokens ?? 4096
  agentForm.system_prompt = cfg?.system_prompt || defaultPrompts[type] || ''
  agentSaved.value = null
  editingAgent.value = type
}

function resetAgentPrompt(type) {
  agentForm.system_prompt = defaultPrompts[type] || ''
  toast.info('已恢复默认提示词，点击保存生效')
}

async function saveAgentCfg(type) {
  agentSaving.value = true
  agentSaved.value = null
  try {
    const existing = getAgentCfg(type)
    const data = {
      agent_type: type,
      name: agentDefs.find(a => a.type === type)?.label || type,
      model: agentForm.model,
      temperature: agentForm.temperature,
      max_tokens: agentForm.max_tokens,
      system_prompt: agentForm.system_prompt,
    }
    if (existing) {
      await agentConfigAPI.update(existing.id, data)
    } else {
      await agentConfigAPI.create(data)
    }
    await loadAgents()
    agentSaved.value = type
    toast.success(`${agentDefs.find(a => a.type === type)?.label} 配置已保存`)
    setTimeout(() => { if (agentSaved.value === type) agentSaved.value = null }, 3000)
  } catch (e) {
    toast.error(e.message)
  } finally {
    agentSaving.value = false
  }
}

// ===== Skills =====
const selectedAgent = ref('script_rewriter')
const allSkills = ref([])   // { id, name, description }[]
const editingSkill = ref(null)
const skillContent = ref('')
const skillSaving = ref(false)
const skillSaved = ref(null)
const addSkillDialog = ref(false)
const newSkillForm = reactive({ id: '', name: '', description: '' })

const selectedAgentType = computed(() => selectedAgent.value)
const selectedAgentLabel = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.label || '')
const selectedAgentIcon = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.icon || '')

function agentSkillCount(type) {
  return allSkills.value.filter(s => s.id === type || s.id.startsWith(type + '/')).length
}

const currentSkills = computed(() =>
  allSkills.value.filter(s => s.id === selectedAgent.value || s.id.startsWith(selectedAgent.value + '/'))
)

async function loadAllSkills() {
  try { allSkills.value = await skillsAPI.list() }
  catch (e) { toast.error(e.message) }
}

async function selectAgent(type) {
  selectedAgent.value = type
  editingSkill.value = null
}

function startAddSkill() {
  newSkillForm.id = ''
  newSkillForm.name = ''
  newSkillForm.description = ''
  addSkillDialog.value = true
}

async function confirmAddSkill() {
  if (!newSkillForm.id) return
  const skillId = `${selectedAgent.value}/${newSkillForm.id}`
  try {
    await skillsAPI.create({ id: skillId, name: newSkillForm.name, description: newSkillForm.description })
    addSkillDialog.value = false
    await loadAllSkills()
    toast.success('Skill 创建成功')
  } catch (e) {
    toast.error(e.message)
  }
}

async function deleteSkill(id) {
  if (!confirm(`确定删除 Skill「${id}」？`)) return
  try {
    await skillsAPI.del(id)
    if (editingSkill.value === id) editingSkill.value = null
    await loadAllSkills()
    toast.success('已删除')
  } catch (e) {
    toast.error(e.message)
  }
}

async function toggleSkillEdit(id) {
  if (editingSkill.value === id) { editingSkill.value = null; return }
  try {
    const res = await skillsAPI.get(id)
    skillContent.value = res.content
    skillSaved.value = null
    editingSkill.value = id
  } catch (e) { toast.error(e.message) }
}

async function saveSkill(id) {
  skillSaving.value = true
  skillSaved.value = null
  try {
    await skillsAPI.update(id, skillContent.value)
    await loadAllSkills()
    skillSaved.value = id
    toast.success(`已保存`)
    setTimeout(() => { if (skillSaved.value === id) skillSaved.value = null }, 3000)
  } catch (e) {
    toast.error(e.message)
  } finally {
    skillSaving.value = false
  }
}

onMounted(() => { loadCfgs(); loadAgents(); loadAllSkills() })
</script>

<style scoped>
.settings-layout { display: flex; height: 100%; background: var(--bg-base); }

.settings-nav {
  width: 220px; flex-shrink: 0; padding: 16px 10px; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 14px; background: var(--bg-1);
}
.nav-group { display: flex; flex-direction: column; gap: 4px; }
.nav-group-label {
  font-size: 10px; font-weight: 700; color: var(--text-3);
  letter-spacing: 0.12em; text-transform: uppercase; padding: 0 10px 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 13px;
  border: none; background: none; color: var(--text-2); cursor: pointer;
  border-radius: var(--radius); transition: all 0.12s; text-align: left; width: 100%;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-0); }
.nav-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 600; box-shadow: var(--shadow-card); }
.nav-advanced {
  padding: 12px 8px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}
.advanced-toggle {
  display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px;
  font-size: 12px; color: var(--text-2);
}
.advanced-toggle input { display: none; }
.advanced-slider {
  position: relative; width: 38px; height: 22px; border-radius: 999px;
  background: rgba(27, 41, 64, 0.12); transition: background 0.18s ease;
}
.advanced-slider::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(18, 24, 38, 0.18); transition: transform 0.18s ease;
}
.advanced-toggle input:checked + .advanced-slider { background: var(--accent); }
.advanced-toggle input:checked + .advanced-slider::after { transform: translateX(16px); }
.advanced-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-3);
}

.settings-content { flex: 1; overflow: hidden; }
.settings-scroll { height: 100%; overflow-y: auto; padding: 36px 48px; max-width: 840px; margin: 0 auto; animation: fadeUp 0.3s var(--ease-out); }
.settings-head { margin-bottom: 24px; }
.settings-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.settings-brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 15px;
  border: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,247,255,0.9));
  box-shadow: var(--shadow-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-brand-logo {
  width: 26px;
  height: 26px;
  object-fit: contain;
  display: block;
}
.settings-brand-fallback {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--accent-text);
  line-height: 1;
}
.settings-brand-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  line-height: 1;
}
.settings-brand-kicker {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.settings-brand-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.settings-title { font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.settings-desc { font-size: 13px; color: var(--text-2); margin-top: 4px; }

/* AI Config */
.setup-panel {
  padding: 18px 18px 16px;
  margin-bottom: 18px;
}
.setup-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.setup-panel-head.compact { margin-bottom: 12px; }
.setup-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 4px;
}
.setup-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-0);
}
.setup-desc {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.preset-grid.compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 8px;
}
.preset-card {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: rgba(255,255,255,0.82);
  padding: 12px 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preset-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.preset-service { font-size: 12px; font-weight: 600; }
.preset-model { font-size: 12px; color: var(--text-1); }
.preset-base { font-size: 11px; color: var(--text-3); }
.template-row { display: flex; flex-wrap: wrap; gap: 8px; }
.template-type-chip {
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.82);
  color: var(--text-1);
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: 0.15s;
}
.template-type-chip:hover {
  border-color: var(--accent);
  color: var(--accent-text);
  background: var(--accent-bg);
}
.sections { display: flex; flex-direction: column; gap: 24px; }
.section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.section-title { font-size: 13px; font-weight: 600; }
.section-subtitle { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.config-list { display: flex; flex-direction: column; gap: 6px; }
.config-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
.config-info { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.config-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.config-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.config-provider { font-size: 13px; font-weight: 600; }
.config-name { font-size: 12px; color: var(--text-2); }
.config-model { font-size: 11px; color: var(--text-2); }
.config-base { font-size: 11px; color: var(--text-3); }
.config-empty { font-size: 12px; color: var(--text-3); padding: 12px 0; }

.toggle { position: relative; width: 30px; height: 17px; cursor: pointer; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle span { position: absolute; inset: 0; background: var(--bg-3); border-radius: 99px; transition: 0.2s; }
.toggle span::before { content: ''; position: absolute; width: 13px; height: 13px; left: 2px; bottom: 2px; background: var(--bg-0); border-radius: 50%; transition: 0.2s; box-shadow: var(--shadow); }
.toggle input:checked + span { background: var(--accent); }
.toggle input:checked + span::before { transform: translateX(13px); }

/* Agent */
.agent-list { display: flex; flex-direction: column; gap: 8px; }
.agent-card { overflow: hidden; }
.agent-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; transition: background 0.1s; }
.agent-card-head:hover { background: var(--bg-hover); }
.agent-type-badge { width: 36px; height: 36px; border-radius: var(--radius); background: var(--accent-bg); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.agent-card-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 16px; }
.agent-card-foot { display: flex; align-items: center; gap: 8px; padding-top: 8px; }

/* Skills 布局 */
.skills-layout { display: flex; height: 100%; overflow: hidden; }
.skills-agent-list {
  width: 200px; flex-shrink: 0; border-right: 1px solid var(--border);
  background: var(--bg-1); display: flex; flex-direction: column;
  overflow-y: auto;
}
.skills-agent-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-3); padding: 14px 14px 8px;
}
.skills-agent-item {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; font-size: 13px; cursor: pointer;
  border: none; background: none; color: var(--text-2);
  transition: all 0.12s; width: 100%; text-align: left;
  border-radius: 0;
}
.skills-agent-item:hover { background: var(--bg-hover); color: var(--text-0); }
.skills-agent-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 600; }
.skills-agent-label { flex: 1; }
.skill-count-badge {
  font-size: 10px; font-weight: 700; font-family: var(--font-mono);
  background: var(--accent-bg); color: var(--accent-text);
  padding: 1px 5px; border-radius: 99px;
}
.skills-agent-item.active .skill-count-badge { background: rgba(255,255,255,0.2); color: inherit; }
.skills-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.skills-main .settings-scroll { max-width: 900px; }

/* Skill */
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-card { overflow: hidden; }
.skill-card-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; transition: background 0.1s; }
.skill-card-head:hover { background: var(--bg-hover); }
.skill-card-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 12px; }
.skill-card-foot { display: flex; align-items: center; gap: 8px; }

/* Shared */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-hint { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.overlay { position: fixed; inset: 0; background: rgba(34,45,66,0.32); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fadeIn 0.18s var(--ease-out); }
.modal { padding: 28px; width: 420px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-elevated); }
.modal-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; }
.config-modal { width: min(720px, calc(100vw - 40px)); max-height: calc(100vh - 48px); overflow-y: auto; }
.config-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.modal-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.preset-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.preset-pill {
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.72);
  color: var(--text-1);
  border-radius: 999px;
  padding: 8px 11px;
  font-size: 12px;
  cursor: pointer;
}
.preset-pill:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.endpoint-hint {
  margin-top: -4px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px dashed var(--border);
  background: rgba(244,248,255,0.72);
  font-size: 12px;
}
.test-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.72);
}
.test-result.ok { border-color: rgba(74, 167, 92, 0.28); }
.test-result.bad { border-color: rgba(201, 88, 68, 0.28); }
.test-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}
.test-result-url,
.test-result-preview {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
.huobao-grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 10px;
}
.huobao-grid .field-hint a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.huobao-grid .field-hint a:hover {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .preset-grid,
  .preset-grid.compact {
    grid-template-columns: 1fr;
  }
}
</style>

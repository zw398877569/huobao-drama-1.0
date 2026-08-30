import { aiConfigAPI } from '~/composables/useApi'

export function useSettingsAi(loadAgents: () => Promise<void>) {
  // Dialog + edit state
  const cfgDialog = ref(false)
  const cfgEditId = ref<number | null>(null)
  const presetDialog = ref(false)
  const cfgTesting = ref(false)
  const cfgTestResult = ref<any>(null)

  // Data
  const cfgs = ref<any[]>([])

  // Edit form
  const cfgForm = reactive({
    name: '',
    provider: '',
    api_key: '',
    base_url: '',
    modelStr: '',
    service_type: 'text',
    priority: 0,
  })

  // Huobao preset form
  const huobaoForm = reactive({ apiKey: '' })

  // Provider metadata (single source of truth for UI labels + presets)
  const serviceTypes = [
    { type: 'text', label: '文本' },
    { type: 'image', label: '图片' },
    { type: 'video', label: '视频' },
    { type: 'audio', label: '音频' },
  ]

  const providers = [
    'autodl-comfyui', 'nano-banana', 'agnes', 'ali', 'chatfire',
    'gemini', 'minimax', 'openai', 'openrouter', 'vidu', 'volcengine',
  ]
  const providerSelectOptions = computed(() => providers.map(p => ({ label: p, value: p })))

  const serviceMeta: Record<string, { label: string, desc: string }> = {
    text: { label: '文本', desc: '剧本改写、角色场景提取、分镜拆解等 Agent 文本能力' },
    image: { label: '图片', desc: '角色图、场景图、镜头图与首尾帧等静态图像生成' },
    video: { label: '视频', desc: '镜头视频生成，支持单图、多图和首尾帧模式' },
    audio: { label: '音频', desc: '角色试听、旁白与对白语音生成' },
  }

  const providerPresets: Record<string, Record<string, any>> = {
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

  const endpointPrefixes: Record<string, string> = {
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

  function byType(t: string) { return cfgs.value.filter(c => c.service_type === t) }
  function countActive(t: string) { return byType(t).filter(c => c.is_active).length }
  function fmtModel(m: any) { return Array.isArray(m) ? m.join(', ') : m || '—' }

  function presetsByType(type: string) {
    const group = providerPresets[type] || {}
    return Object.entries(group).map(([provider, preset]) => ({ provider, ...(preset as any) }))
  }

  function applyProviderPreset(type: string, provider: string) {
    const preset = providerPresets[type]?.[provider]
    if (!preset) return
    cfgForm.provider = provider
    cfgForm.base_url = preset.baseUrl
    cfgForm.modelStr = preset.models.join(', ')
    cfgForm.name = `${preset.label}-${serviceMeta[type].label}`
  }

  async function loadCfgs() {
    try { cfgs.value = await aiConfigAPI.list() } catch (e: any) { toast.error(e.message) }
  }

  async function toggleCfg(c: any) {
    await aiConfigAPI.update(c.id, { is_active: !c.is_active })
    loadCfgs()
  }

  async function delCfg(id: number) {
    await aiConfigAPI.del(id)
    toast.success('已删除')
    loadCfgs()
  }

  function startAddCfg(t: string) {
    cfgEditId.value = null
    cfgTestResult.value = null
    Object.assign(cfgForm, { name: '', provider: '', api_key: '', base_url: '', modelStr: '', service_type: t, priority: 0 })
    const firstPreset = presetsByType(t)[0]
    if (firstPreset) applyProviderPreset(t, firstPreset.provider)
    cfgDialog.value = true
  }

  function startEditCfg(c: any) {
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

  async function testCfgPayload(payload: any) {
    cfgTesting.value = true
    try {
      cfgTestResult.value = await aiConfigAPI.test(payload)
      if (cfgTestResult.value.reachable) toast.success('端点已响应')
      else toast.warning('端点未通过测试')
    } catch (e: any) {
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
      model: cfgForm.modelStr.split(',').map((s: string) => s.trim()).filter(Boolean),
    })
  }

  async function testExistingCfg(c: any) {
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
    const models = cfgForm.modelStr.split(',').map((s: string) => s.trim()).filter(Boolean)
    try {
      if (cfgEditId.value) {
        await aiConfigAPI.update(cfgEditId.value, {
          name: cfgForm.name,
          provider: cfgForm.provider,
          api_key: cfgForm.api_key,
          base_url: cfgForm.base_url,
          model: models,
          priority: cfgForm.priority,
        })
      } else {
        await aiConfigAPI.create({
          service_type: cfgForm.service_type,
          provider: cfgForm.provider,
          name: cfgForm.name || `${cfgForm.provider}-${cfgForm.service_type}`,
          api_key: cfgForm.api_key,
          base_url: cfgForm.base_url,
          model: models,
          priority: cfgForm.priority,
        })
      }
      cfgDialog.value = false
      toast.success('已保存')
      loadCfgs()
    } catch (e: any) { toast.error(e.message) }
  }

  async function applyHuobaoPreset() {
    if (!huobaoForm.apiKey) {
      toast.warning('请填写 Huobao API Key')
      return
    }
    try {
      await aiConfigAPI.huobaoPreset(huobaoForm.apiKey)
      await loadCfgs()
      await loadAgents()  // cross-tab refresh: Agents tab picks up the default agent LLM
      presetDialog.value = false
      toast.success('火宝推荐配置与默认 Agent LLM 已写入')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  onMounted(loadCfgs)

  return {
    // dialog / edit state
    cfgDialog, cfgEditId, presetDialog, cfgTesting, cfgTestResult,
    // data
    cfgs,
    // forms
    cfgForm, huobaoForm,
    // metadata
    serviceTypes, providers, providerSelectOptions, serviceMeta,
    providerPresets, huobaoPresetCards, endpointPrefixes, endpointHint,
    // helpers
    byType, countActive, fmtModel, presetsByType, applyProviderPreset,
    // actions
    loadCfgs, toggleCfg, delCfg,
    startAddCfg, startEditCfg,
    testCfgPayload, testDraftCfg, testExistingCfg, saveCfg,
    applyHuobaoPreset,
  }
}

import { aiConfigAPI, voicesAPI } from '~/composables/useApi'
import type { Ref } from 'vue'

type Deps = {
  ctx: {
    episode: Ref<any>
  },
}

export function useConfigLoading(deps: Deps) {
  const { ctx } = deps

  const imageConfigs = ref<any[]>([])
  const videoConfigs = ref<any[]>([])
  const audioConfigs = ref<any[]>([])
  const voiceProfiles = ref<any[]>([])

  // Fallback list shown when no voices can be loaded from the configured provider.
  const fallbackVoiceProfiles = [
    { id: 'alloy', label: 'Alloy', gender: '中性', traits: '平衡、自然、克制', suitable: '通用叙述、旁白、需要稳定输出的角色' },
    { id: 'echo', label: 'Echo', gender: '男声', traits: '低沉、稳重、冷静', suitable: '成熟男性、父辈、旁白、压迫感角色' },
    { id: 'fable', label: 'Fable', gender: '男声', traits: '温暖、讲述感、表现力强', suitable: '男主、成长型角色、叙事担当' },
    { id: 'onyx', label: 'Onyx', gender: '男声', traits: '深沉、有力、权威', suitable: '反派、强势角色、掌控型人物' },
    { id: 'nova', label: 'Nova', gender: '女声', traits: '温柔、甜润、亲和', suitable: '女主、母亲、柔和配角' },
    { id: 'shimmer', label: 'Shimmer', gender: '女声', traits: '明亮、活泼、年轻', suitable: '少女、轻快角色、跳脱配角' },
  ]

  const voiceSelectOptions = computed(() => voiceProfiles.value.map(v => ({ label: `${v.label} · ${v.traits}`, value: v.id })))

  const videoConfigSelectOptions = computed(() => videoConfigs.value.map(c => {
    let modelName = ''
    try { const m = JSON.parse(c.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = c.model || '' }
    const label = modelName ? `${modelName} (${c.provider})` : `${c.name} (${c.provider})`
    return { label, value: c.id }
  }))

  function configLabel(config: any) {
    if (!config) return '未配置'
    let modelName = ''
    try { const m = JSON.parse(config.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = config.model || '' }
    return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
  }

  const lockedImageConfigId = computed(() => ctx.episode.value?.image_config_id || ctx.episode.value?.imageConfigId || null)
  const lockedVideoConfigId = computed(() => ctx.episode.value?.video_config_id || ctx.episode.value?.videoConfigId || null)
  const lockedAudioConfigId = computed(() => ctx.episode.value?.audio_config_id || ctx.episode.value?.audioConfigId || null)
  const lockedAudioProvider = computed(() => audioConfigs.value.find(c => c.id === lockedAudioConfigId.value)?.provider || '')
  const lockedImageConfigLabel = computed(() => configLabel(imageConfigs.value.find(c => c.id === lockedImageConfigId.value)))
  const lockedVideoConfigLabel = computed(() => configLabel(videoConfigs.value.find(c => c.id === lockedVideoConfigId.value)))
  const lockedAudioConfigLabel = computed(() => configLabel(audioConfigs.value.find(c => c.id === lockedAudioConfigId.value)))

  async function loadConfigs() {
    try {
      const [imgCfgs, vidCfgs, audCfgs] = await Promise.all([
        aiConfigAPI.list('image'),
        aiConfigAPI.list('video'),
        aiConfigAPI.list('audio'),
      ])
      imageConfigs.value = imgCfgs || []
      videoConfigs.value = vidCfgs || []
      audioConfigs.value = audCfgs || []
    } catch (e) { console.error('Failed to load AI configs', e) }
  }

  function inferVoiceGender(name: string, desc: string[] = []) {
    const text = `${name} ${Array.isArray(desc) ? desc.join(' ') : ''}`
    if (/[男|青年|大爷|学长|boy|man|male]/i.test(text)) return '男声'
    if (/[女|少女|御姐|奶奶|girl|woman|female]/i.test(text)) return '女声'
    return '中性'
  }

  function mapVoiceProfile(v: any) {
    const desc = Array.isArray(v.description) ? v.description : []
    return {
      id: v.voice_id,
      label: v.voice_name || v.voice_id,
      gender: inferVoiceGender(v.voice_name || v.voice_id, desc),
      traits: desc.length ? desc.slice(0, 2).join('、') : `${v.language || '多语言'}音色`,
      suitable: desc.length > 2 ? desc.slice(2).join('、') : `${v.language || '通用'}角色`,
    }
  }

  async function loadVoices() {
    try {
      const provider = lockedAudioProvider.value || 'minimax'
      const rows = await voicesAPI.list(provider)
      voiceProfiles.value = rows?.length ? rows.map(mapVoiceProfile) : fallbackVoiceProfiles
    } catch (e) {
      console.error('Failed to load voices', e)
      voiceProfiles.value = fallbackVoiceProfiles
    }
  }

  // Re-fetch voices whenever the locked audio config or provider changes
  watch([lockedAudioConfigId, audioConfigs], () => { loadVoices() }, { deep: true })

  // Initial load on mount
  onMounted(() => { loadConfigs(); loadVoices() })

  return {
    imageConfigs, videoConfigs, audioConfigs, voiceProfiles,
    fallbackVoiceProfiles,
    voiceSelectOptions, videoConfigSelectOptions,
    lockedImageConfigId, lockedVideoConfigId, lockedAudioConfigId, lockedAudioProvider,
    lockedImageConfigLabel, lockedVideoConfigLabel, lockedAudioConfigLabel,
    configLabel, loadConfigs, inferVoiceGender, mapVoiceProfile, loadVoices,
  }
}

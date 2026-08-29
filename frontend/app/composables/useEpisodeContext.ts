import { dramaAPI, episodeAPI, mergeAPI } from '~/composables/useApi'

export function useEpisodeContext() {
  const route = useRoute()
  const dramaId = Number(route.params.id)
  const episodeNumber = Number(route.params.episodeNumber)

  const drama = ref<any>(null)
  const episode = ref<any>(null)
  const chars = ref<any[]>([])
  const scenes = ref<any[]>([])
  const sbs = ref<any[]>([])
  const mergeData = ref<any>(null)

  const localRaw = ref('')
  const localScript = ref('')
  const scriptStep = ref(0)

  const rawContent = computed(() => episode.value?.content || '')
  const scriptContent = computed(() => episode.value?.script_content || episode.value?.scriptContent || '')
  const epId = computed(() => episode.value?.id || 0)
  const rawLen = computed(() => localRaw.value.replace(/\s/g, '').length || 0)
  const scriptLen = computed(() => localScript.value.replace(/\s/g, '').length || 0)
  const charsVoiced = computed(() => chars.value.filter(c => c.voice_style || c.voiceStyle).length)
  const voiceSampleCount = computed(() => chars.value.filter(c => c.voice_sample_url || c.voiceSampleUrl).length)
  const composedCount = computed(() => sbs.value.filter(s => s.composed_video_url || s.composedVideoUrl).length)
  const mergeUrl = computed(() => mergeData.value?.merged_url || mergeData.value?.mergedUrl || null)

  watch(rawContent, v => { localRaw.value = v }, { immediate: true })
  watch(scriptContent, v => { localScript.value = v }, { immediate: true })

  function saveRaw() {
    episodeAPI.update(epId.value, { content: localRaw.value })
    episode.value.content = localRaw.value
  }
  function saveScr() {
    episodeAPI.update(epId.value, { script_content: localScript.value })
    episode.value.script_content = localScript.value
  }

  return {
    dramaId, episodeNumber,
    drama, episode, chars, scenes, sbs, mergeData,
    localRaw, localScript, scriptStep,
    rawContent, scriptContent, epId,
    rawLen, scriptLen, charsVoiced, voiceSampleCount, composedCount, mergeUrl,
    saveRaw, saveScr,
  }
}

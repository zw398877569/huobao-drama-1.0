import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    drama: Ref<any>
    episode: Ref<any>
    chars: Ref<any[]>
    scenes: Ref<any[]>
    sbs: Ref<any[]>
    mergeData: Ref<any>
    scriptStep: Ref<number>
    panel: Ref<string>
    localRaw: Ref<string>
    localScript: Ref<string>
    rawContent: ComputedRef<string>
    scriptContent: ComputedRef<string>
    charsVoiced: ComputedRef<number>
    composedCount: ComputedRef<number>
    mergeUrl: ComputedRef<string | null>
  },
  saveRaw: () => void,
  saveScr: () => void,
  hasDialogue: (sb: any) => boolean,
  hasTTS: (sb: any) => boolean,
}

export function useEpisodePipeline(deps: Deps) {
  const { ctx, saveRaw, saveScr, hasDialogue, hasTTS } = deps

  // Top-level panel state
  const prodTab = ref('chars')
  const prodTabIdx = computed({
    get: () => prodTabDefs.value.findIndex(t => t.id === prodTab.value),
    set: (v) => { prodTab.value = prodTabDefs.value[v]?.id || 'chars' },
  })
  const frameMode = ref('first')
  const frameModeOptions = [{ label: '仅首帧', value: 'first' }, { label: '首尾帧', value: 'first_last' }]

  // Character / scene / shot counts (used by step gating + progress UI)
  const charImgCount = computed(() => visualChars.value.filter(c => c.image_url || c.imageUrl).length)
  const sceneImgCount = computed(() => ctx.scenes.value.filter(s => s.image_url || s.imageUrl).length)
  const ttsEligibleCount = computed(() => ctx.sbs.value.filter(s => hasDialogue(s)).length)
  const ttsGeneratedCount = computed(() => ctx.sbs.value.filter(s => hasDialogue(s) && hasTTS(s)).length)
  const shotImgCount = computed(() => ctx.sbs.value.filter(s => s.first_frame_image || s.firstFrameImage || s.last_frame_image || s.lastFrameImage || s.composed_image || s.composedImage).length)
  const shotVidCount = computed(() => ctx.sbs.value.filter(s => s.video_url || s.videoUrl).length)
  const visualCharTotal = computed(() => visualChars.value.length)

  function prodStepDone(id: string) {
    if (id === 'chars') return !visualCharTotal.value || charImgCount.value === visualCharTotal.value
    if (id === 'scenes') return !!ctx.scenes.value.length && sceneImgCount.value === ctx.scenes.value.length
    if (id === 'dubbing') return !!ctx.sbs.value.length && (!ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value)
    if (id === 'shots') return !!ctx.sbs.value.length && shotImgCount.value === ctx.sbs.value.length
    if (id === 'videos') return !!ctx.sbs.value.length && shotVidCount.value === ctx.sbs.value.length
    if (id === 'compose') return !!ctx.sbs.value.length && ctx.composedCount.value === ctx.sbs.value.length
    return false
  }

  const canExport = computed(() => !!ctx.sbs.value.length && ctx.composedCount.value === ctx.sbs.value.length)

  function goNextProd() {
    if (prodTabIdx.value < prodTabDefs.value.length - 1) {
      prodTabIdx.value++
    } else {
      ctx.panel.value = 'export'
    }
  }

  // Script step navigation
  const stepLabels = ['原始内容', 'AI 改写', '提取', '音色', '分镜']
  const prevStepLabel = computed(() => ctx.scriptStep.value > 0 ? stepLabels[ctx.scriptStep.value - 1] : '')
  const nextStepLabel = computed(() => {
    if (ctx.scriptStep.value === 4) return '进入制作'
    return stepLabels[ctx.scriptStep.value + 1] || ''
  })
  const canGoNext = computed(() => {
    if (ctx.scriptStep.value === 0) return !!ctx.localRaw.value.trim()
    if (ctx.scriptStep.value === 1) return !!ctx.localScript.value.trim() || !!ctx.scriptContent.value
    if (ctx.scriptStep.value === 2) return ctx.chars.value.length > 0
    if (ctx.scriptStep.value === 3) return ctx.charsVoiced.value > 0
    if (ctx.scriptStep.value === 4) return ctx.sbs.value.length > 0
    return false
  })
  function goPrevStep() { if (ctx.scriptStep.value > 0) ctx.scriptStep.value-- }
  function goNextStep() {
    if (ctx.scriptStep.value === 0 && ctx.localRaw.value.trim()) { saveRaw() }
    if (ctx.scriptStep.value === 1 && ctx.localScript.value.trim()) { saveScr() }
    if (ctx.scriptStep.value === 4) { ctx.panel.value = 'production'; return }
    if (canGoNext.value) ctx.scriptStep.value++
  }

  const prodTabDefs = computed(() => [
    { id: 'chars', label: '角色形象', icon: 'Users', badge: visualCharTotal.value ? `${charImgCount.value}/${visualCharTotal.value}` : '' },
    { id: 'scenes', label: '场景图片', icon: 'MapPin', badge: sceneImgCount.value ? `${sceneImgCount.value}/${ctx.scenes.value.length}` : '' },
    { id: 'dubbing', label: '配音生成', icon: 'Mic2', badge: '' },
    { id: 'shots', label: '镜头图片', icon: 'ImageIcon', badge: shotImgCount.value ? `${shotImgCount.value}/${ctx.sbs.value.length}` : '' },
    { id: 'videos', label: '视频生成', icon: 'Video', badge: shotVidCount.value ? `${shotVidCount.value}/${ctx.sbs.value.length}` : '' },
    { id: 'compose', label: '视频合成', icon: 'Layers', badge: ctx.composedCount.value ? `${ctx.composedCount.value}/${ctx.sbs.value.length}` : '' },
  ])

  const mainStageDefs = [
    { id: 'script', label: '剧本', desc: '内容改写与整理', icon: 'FileText' },
    { id: 'assets', label: '资产', desc: '角色、场景与音色', icon: 'FolderKanban' },
    { id: 'storyboard', label: '分镜', desc: '镜头制作与合成', icon: 'Clapperboard' },
    { id: 'export', label: '导出', desc: '拼接与成片输出', icon: 'Download' },
  ]

  const sidebarSections = computed(() => ([
    {
      id: 'script',
      label: '剧本',
      items: [
        { key: 'script:raw', label: '原始内容', desc: '', icon: 'FileText', done: !!ctx.rawContent.value },
        { key: 'script:rewrite', label: 'AI 改写', desc: '', icon: 'FileText', done: !!ctx.scriptContent.value },
        { key: 'script:extract', label: '提取', desc: '', icon: 'Users', done: !!ctx.chars.value.length },
        { key: 'script:voice', label: '音色', desc: '', icon: 'Mic2', done: !!ctx.chars.value.length && ctx.charsVoiced.value === ctx.chars.value.length },
        { key: 'script:storyboard', label: '分镜', desc: '', icon: 'Clapperboard', done: !!ctx.sbs.value.length },
      ],
    },
    {
      id: 'production',
      label: '制作',
      items: [
        { key: 'prod:chars', label: '角色形象', desc: '', icon: 'Users', done: prodStepDone('chars') },
        { key: 'prod:scenes', label: '场景图片', desc: '', icon: 'MapPin', done: prodStepDone('scenes') },
        { key: 'prod:dubbing', label: '配音生成', desc: '', icon: 'Mic2', done: prodStepDone('dubbing') },
        { key: 'prod:shots', label: '镜头图片', desc: '', icon: 'ImageIcon', done: prodStepDone('shots') },
        { key: 'prod:videos', label: '视频生成', desc: '', icon: 'Video', done: prodStepDone('videos') },
        { key: 'prod:compose', label: '视频合成', desc: '', icon: 'Layers', done: prodStepDone('compose') },
      ],
    },
    {
      id: 'export',
      label: '导出',
      items: [
        { key: 'export:merge', label: '拼接导出', desc: '', icon: 'Download', done: !!ctx.mergeUrl.value },
      ],
    },
  ]))

  const activeMainStage = computed(() => {
    if (ctx.panel.value === 'export') return 'export'
    if (ctx.panel.value === 'production') {
      return ['chars', 'scenes'].includes(prodTab.value) ? 'assets' : 'storyboard'
    }
    if (ctx.scriptStep.value <= 1) return 'script'
    if (ctx.scriptStep.value <= 3) return 'assets'
    return 'storyboard'
  })

  function mainStageDone(stageId: string) {
    if (stageId === 'script') return !!ctx.scriptContent.value
    if (stageId === 'assets') {
      const charsReady = !!ctx.chars.value.length && ctx.charsVoiced.value === ctx.chars.value.length
      const charImagesReady = !visualCharTotal.value || charImgCount.value === visualCharTotal.value
      const sceneImagesReady = !ctx.scenes.value.length || sceneImgCount.value === ctx.scenes.value.length
      return charsReady && charImagesReady && sceneImagesReady
    }
    if (stageId === 'storyboard') {
      const shotsReady = !ctx.sbs.value.length || (shotImgCount.value === ctx.sbs.value.length && shotVidCount.value === ctx.sbs.value.length && ctx.composedCount.value === ctx.sbs.value.length)
      return shotsReady
    }
    if (stageId === 'export') return !!ctx.mergeUrl.value
    return false
  }

  function goMainStage(stageId: string) {
    if (stageId === 'script') { ctx.panel.value = 'script'; return }
    if (stageId === 'assets') { ctx.panel.value = 'production'; prodTab.value = 'chars'; return }
    if (stageId === 'storyboard') { ctx.panel.value = 'production'; prodTab.value = 'shots'; return }
    if (stageId === 'export') { ctx.panel.value = 'export'; return }
  }

  const activeSubSteps = computed(() => {
    if (ctx.panel.value === 'export') return []
    if (ctx.panel.value === 'production') {
      return sidebarSections.value.find(s => s.id === 'production')?.items.filter(item => item.key.startsWith('prod:')) || []
    }
    return sidebarSections.value.find(s => s.id === 'script')?.items || []
  })

  const activeSubStepKey = computed(() => {
    if (ctx.panel.value === 'production') {
      return `prod:${prodTab.value}`
    }
    if (ctx.panel.value === 'script') {
      return `script:${['raw', 'rewrite', 'extract', 'voice', 'storyboard'][ctx.scriptStep.value] || 'raw'}`
    }
    return ''
  })

  const sidebarJumpSteps = computed(() => {
    return sidebarSections.value.flatMap(section => section.items.filter(item => prodStepDone(item.key.split(':')[1]) || ['prod:dubbing'].includes(item.key)))
  })

  const bubbleSteps = computed(() => {
    const isProd = ctx.panel.value === 'production'
    const sectionId = isProd ? 'production' : 'script'
    return sidebarSections.value.find(s => s.id === sectionId)?.items || []
  })

  const activeBubbleKey = computed(() => {
    if (ctx.panel.value === 'production') {
      return `prod:${prodTab.value}`
    }
    if (ctx.panel.value === 'script') {
      return `script:${['raw', 'rewrite', 'extract', 'voice', 'storyboard'][ctx.scriptStep.value] || 'raw'}`
    }
    return ''
  })

  const showBottomBubble = computed(() => ctx.panel.value === 'script' || ctx.panel.value === 'production')

  function goSubStep(key: string) {
    const [section, step] = key.split(':')
    if (section === 'script') {
      ctx.panel.value = 'script'
      const stepIdx = ['raw', 'rewrite', 'extract', 'voice', 'storyboard'].indexOf(step)
      if (stepIdx >= 0) ctx.scriptStep.value = stepIdx
      return
    }
    if (section === 'prod') {
      ctx.panel.value = 'production'
      prodTab.value = step
      return
    }
    if (section === 'export') {
      ctx.panel.value = 'export'
    }
  }

  const pipelineProgress = computed(() => {
    const sections = sidebarSections.value
    const all = sections.flatMap(s => s.items)
    const done = all.filter(i => i.done).length
    return `${done}/${all.length}`
  })

  const currentStageLabel = computed(() => {
    if (ctx.panel.value === 'export') return '导出'
    if (ctx.panel.value === 'production') {
      const tab = prodTabDefs.value.find(t => t.id === prodTab.value)
      return tab?.label || ''
    }
    return stepLabels[ctx.scriptStep.value] || ''
  })

  const currentMainStageLabel = computed(() => {
    const stage = mainStageDefs.find(s => s.id === activeMainStage.value)
    return stage?.label || ''
  })

  const currentSubStageLabel = computed(() => {
    const current = activeSubSteps.value.find(step => step.key === activeSubStepKey.value)
    return current?.label || currentStageLabel.value
  })

  const scriptSteps = computed(() => {
    const hasScript = !!ctx.scriptContent.value
    const hasChars = ctx.chars.value.length > 0 && hasScript
    const hasVoice = ctx.charsVoiced.value > 0 && hasChars
    const hasSbs = ctx.sbs.value.length > 0
    return [
      { label: '原始内容', state: ctx.rawContent.value ? 'done' : 'active', spinning: false },
      { label: 'AI 改写', state: hasScript ? 'done' : (ctx.rawContent.value ? 'active' : ''), spinning: ctx.agentRunningType.value === 'script_rewriter' },
      { label: '提取', state: hasChars ? 'done' : (hasScript ? 'active' : ''), spinning: ctx.agentRunningType.value === 'extractor' },
      { label: '音色', state: hasVoice ? 'done' : (hasChars ? 'active' : ''), spinning: ctx.agentRunningType.value === 'voice_assigner' },
      { label: '分镜', state: hasSbs ? 'done' : (hasVoice ? 'active' : ''), spinning: ctx.agentRunningType.value === 'storyboard_breaker' },
    ]
  })

  // Helper used by computed above — defined last to avoid TDZ
  function isNarratorCharacter(char: any) {
    const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
    return text.includes('旁白') || text.includes('narrator') || text.includes('画外音')
  }

  const visualChars = computed(() => ctx.chars.value.filter(c => !isNarratorCharacter(c)))

  return {
    // state
    prodTab, prodTabIdx, frameMode, frameModeOptions,
    // counts
    charImgCount, sceneImgCount, ttsEligibleCount, ttsGeneratedCount, shotImgCount, shotVidCount, visualCharTotal, visualChars,
    // gating
    prodStepDone, canExport, goNextProd,
    // script step nav
    stepLabels, prevStepLabel, nextStepLabel, canGoNext, goPrevStep, goNextStep,
    // production tabs
    prodTabDefs, mainStageDefs,
    // sidebar / progress
    sidebarSections, activeMainStage, mainStageDone, goMainStage,
    activeSubSteps, activeSubStepKey, sidebarJumpSteps,
    bubbleSteps, activeBubbleKey, showBottomBubble, goSubStep,
    pipelineProgress, currentStageLabel, currentMainStageLabel, currentSubStageLabel,
    scriptSteps,
  }
}

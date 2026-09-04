import { storyboardAPI } from '~/composables/useApi'
import { useStylePresets } from '~/composables/useStylePresets'
import type { Ref } from 'vue'

type Deps = {
  ctx: {
    sbs: Ref<any[]>
    chars: Ref<any[]>
    scenes: Ref<any[]>
  },
  refresh: () => Promise<void>,
}

export function useStoryboardEdit(deps: Deps) {
  const { ctx, refresh } = deps

  // Selection
  const selectedSb = ref<any | null>(null)

  // Per-storyboard in-flight tracking
  const analyzingIntentionId = ref<number | null>(null)
  const evaluatingId = ref<number | null>(null)
  const retakingId = ref<number | null>(null)

  // Retake modal state
  const retakeDialog = ref(false)
  const retakeTargetSb = ref<any | null>(null)
  const retakeDimension = ref('prompt')
  const retakeUserNote = ref('')

  // Shot type / angle / movement options
  const shotTypes = [
    '大远景', '远景', '全景', '中景', '中近景', '近景', '特写', '大特写',
    '双人镜头', '三人镜头', '群像', '背影', '侧面', '正面', '俯视', '仰视',
    '过肩', '主观视角', '航拍', '运动镜头',
  ]
  const shotAngles = ['平视', '仰视', '俯视', '侧拍', '背拍', '斜侧', '主观视角', '过肩']
  const shotMovements = ['固定', '推镜', '拉镜', '摇镜', '移镜', '跟拍', '升降', '手持', '环绕']

  // 反向提示词预设 — 来自后端 /api/v1/style-presets, 不在前端硬编码
  // 之前 5 条漏了 ghibli/comic/watercolor, 现在全 7 条都能用
  const { negativePresets, load: loadStylePresets } = useStylePresets()
  onMounted(() => { loadStylePresets() })
  const NEGATIVE_PROMPT_PRESETS = computed(() => negativePresets.value)

  // ── Scene Intention (导演意图) helpers ────────────────────────────
  const dramaticFunctions = ['揭露', '对峙', '反转', '铺垫', '高潮', '余韵', '悬念', '情感爆发']

  // Order matters — keeps the eval grid consistent in the detail panel
  const evalDimensions = [
    { key: 'eval_score_prompt',     label: '提示契合度' },
    { key: 'eval_score_visual',     label: '画面质量' },
    { key: 'eval_score_motion',     label: '运镜自然度' },
    { key: 'eval_score_continuity', label: '意图一致性' },
  ]

  function applyStylePreset(sb: any, presetId: string) {
    const preset = NEGATIVE_PROMPT_PRESETS.value.find(p => p.id === presetId)
    if (!preset) return
    updateField(sb, 'negative_prompt', preset.prompt)
  }

  function updateField(sb: any, field: string, value: any) {
    const current = sb[field] ?? sb[toCamel(field)]
    if (current === value) return
    sb[field] = value
    const camelField = toCamel(field)
    if (camelField !== field) sb[camelField] = value
    storyboardAPI.update(sb.id, { [field]: value })
  }

  function toCamel(field: string) {
    return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
  }

  function parseIntention(sb: any) {
    const raw = sb?.scene_intention ?? sb?.sceneIntention
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try { return JSON.parse(raw) } catch { return null }
  }

  function intentionField(sb: any, field: string) {
    return parseIntention(sb)?.[field] ?? ''
  }

  function updateIntentionField(sb: any, field: string, value: string) {
    const current = parseIntention(sb) || {}
    const next = { ...current, [field]: value }
    // Drop empty optional fields so JSON stays compact
    if (next.cameraSpeed === '') delete next.cameraSpeed
    if (next.shortDramaTips === '') delete next.shortDramaTips
    if (next.function === '') delete next.function
    if (!next.intention) delete next.intention
    if (!next.visualStrategy) delete next.visualStrategy
    const json = Object.keys(next).length ? JSON.stringify(next) : ''
    sb.scene_intention = json
    sb.sceneIntention = json
    storyboardAPI.update(sb.id, { scene_intention: json })
  }

  // Trigger scene_intention agent analysis for a single storyboard and refresh local state
  async function analyzeIntention(sb: any) {
    if (!sb?.id || analyzingIntentionId.value === sb.id) return
    analyzingIntentionId.value = sb.id
    try {
      const res: any = await storyboardAPI.analyzeIntention(sb.id)
      // API returns { scene_intention: stringified JSON } — write it back to the local sb
      const raw = res?.scene_intention ?? ''
      sb.scene_intention = raw
      sb.sceneIntention = raw
      toast.success('导演意图已重新生成')
    } catch (e: any) {
      toast.error(e?.message || '重新生成失败')
    } finally {
      analyzingIntentionId.value = null
    }
  }

  // Read a single eval score from a storyboard (snake or camel)
  function evalScore(sb: any, key: string) {
    if (!sb) return null
    const v = sb[key] ?? sb[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  // True if any of the 4 eval dimensions has a recorded score
  function hasEvalScores(sb: any) {
    if (!sb) return false
    return ['eval_score_prompt', 'eval_score_visual', 'eval_score_motion', 'eval_score_continuity']
      .some(k => typeof sb[k] === 'number' && Number.isFinite(sb[k]))
  }

  // Average across the 4 eval dimensions, or null if none set
  function evalAverage(sb: any) {
    const values = ['eval_score_prompt', 'eval_score_visual', 'eval_score_motion', 'eval_score_continuity']
      .map(k => sb?.[k])
      .filter(v => typeof v === 'number' && Number.isFinite(v))
    if (!values.length) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }

  // ── Event Density helpers ──────────────────────────────────────────
  // Read event_density field, defaulting to 'low' if missing/empty.
  function eventDensity(sb: any) {
    const v = sb?.event_density ?? sb?.eventDensity
    return v === 'medium' || v === 'high' ? v : 'low'
  }

  // Parse the JSON event_list (or [] if missing/invalid).
  function eventList(sb: any) {
    const raw = sb?.event_list ?? sb?.eventList
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    try { return JSON.parse(raw) } catch { return [] }
  }

  // Count of detected events (length of the list).
  function eventCount(sb: any) {
    return eventList(sb).length
  }

  // Tone tag for UI colour mapping (mirrors backend classifyEventDensity).
  function eventDensityTone(d: string) {
    return d === 'high' ? 'bad' : d === 'medium' ? 'warn' : 'good'
  }

  // ── IP Safety helpers ──────────────────────────────────────────────
  // True if backend flagged this storyboard's prompt for IP / celebrity /
  // brand rewriting during pre-flight safety check.
  function safetyFlagged(sb: any) {
    const v = sb?.safety_flagged ?? sb?.safetyFlagged
    return v === 1 || v === true
  }

  // Parse the JSON safety_notes (or [] if missing / invalid).
  function safetyNotes(sb: any) {
    const raw = sb?.safety_notes ?? sb?.safetyNotes
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    try { return JSON.parse(raw) } catch { return [] }
  }

  // Original prompt text (before safety rewrite), empty string if none.
  function safetyOriginal(sb: any) {
    const v = sb?.prompt_original ?? sb?.promptOriginal
    return v || ''
  }

  // ── Retake helpers ────────────────────────────────────────────────
  // UI-facing soft cap (the backend hard limit is 10).
  const RETAKE_UI_SOFT_CAP = 3
  // Approximate per-shot cost in CNY. Mirrors estimateRetakeCostCNY in
  // backend/src/services/retake.ts. Override via HUOBAO_RETAKE_COST_CNY
  // env var (configurable on the backend; we just pick a sensible
  // default for the UI).
  const RETAKE_COST_CNY_PER_SHOT = 2.0

  const RETAKE_DIMENSIONS = [
    { key: 'prompt',     label: '提示词契合度', hint: '让描述更贴合 intended 画面' },
    { key: 'visual',     label: '画面质量',     hint: '提升构图 / 锐度 / 光线措辞' },
    { key: 'motion',     label: '运镜自然度',   hint: '调整运镜 / 节奏描述' },
    { key: 'continuity', label: '意图一致性',   hint: '对齐戏剧功能 / 视觉策略' },
  ]

  function retakeCount(sb: any) {
    const v = sb?.retake_count ?? sb?.retakeCount
    return typeof v === 'number' ? v : 0
  }

  function retakeVariable(sb: any) {
    return sb?.retake_variable ?? sb?.retakeVariable ?? ''
  }

  function retakeAtCap(sb: any) {
    return retakeCount(sb) >= RETAKE_UI_SOFT_CAP
  }

  function retakeDimLabel(key: string) {
    const d = RETAKE_DIMENSIONS.find((x) => x.key === key)
    return d ? d.label : key || ''
  }

  // Estimate cost in CNY for a single retake given shot duration.
  function retakeCostCNY(durationSec: number) {
    const dur = durationSec || 10
    const videoFactor = Math.max(1, dur / 10)
    return Number((RETAKE_COST_CNY_PER_SHOT * (0.2 + 0.8 * videoFactor)).toFixed(2))
  }

  // Score → tone (success / warn / danger) for color treatment in UI
  function evalTone(score: number | null | undefined) {
    if (score == null) return 'neutral'
    if (score >= 7.5) return 'good'
    if (score >= 5) return 'warn'
    return 'bad'
  }

  // Trigger a quality evaluation on the generated first frame
  async function evaluateStoryboard(sb: any) {
    if (!sb?.id || evaluatingId.value === sb.id) return
    if (!sb.first_frame_image && !sb.firstFrameImage) {
      toast.error('该镜头尚未生成首帧，无法评估')
      return
    }
    evaluatingId.value = sb.id
    try {
      const res: any = await storyboardAPI.evaluate(sb.id)
      // Apply returned scores back onto the local sb (both snake and camel keys)
      sb.eval_score_prompt = res?.eval_score_prompt ?? null
      sb.eval_score_visual = res?.eval_score_visual ?? null
      sb.eval_score_motion = res?.eval_score_motion ?? null
      sb.eval_score_continuity = res?.eval_score_continuity ?? null
      sb.eval_notes = res?.eval_notes ?? ''
      toast.success('评估完成')
    } catch (e: any) {
      toast.error(e?.message || '评估失败')
    } finally {
      evaluatingId.value = null
    }
  }

  // Open the retake modal pre-filled with the selected storyboard
  function openRetakeDialog(sb: any) {
    if (!sb?.id) return
    if (retakeAtCap(sb)) {
      toast.error(`已达 UI 提示上限（${RETAKE_UI_SOFT_CAP} 次）。请直接修改镜头结构。`)
      return
    }
    retakeTargetSb.value = sb
    retakeDimension.value = 'prompt' // sensible default
    retakeUserNote.value = ''
    retakeDialog.value = true
  }

  function closeRetakeDialog() {
    retakeDialog.value = false
  }

  // The submit body mutates the local sb with retake fields returned by the backend,
  // and single-variable validation. The returned prompts overwrite the
  // local sb; retake_count and retake_variable update reactively.
  async function submitRetake() {
    const sb = retakeTargetSb.value
    if (!sb?.id || retakingId.value === sb.id) return
    retakingId.value = sb.id
    try {
      const res: any = await storyboardAPI.retake(sb.id, {
        dimension: retakeDimension.value,
        user_note: retakeUserNote.value.trim(),
      })
      // Apply returned fields back onto the local sb
      sb.image_prompt = res?.image_prompt ?? sb.image_prompt
      sb.imagePrompt = res?.image_prompt ?? sb.imagePrompt
      sb.video_prompt = res?.video_prompt ?? sb.video_prompt
      sb.videoPrompt = res?.video_prompt ?? sb.videoPrompt
      sb.retake_count = res?.retake_count ?? (retakeCount(sb) + 1)
      sb.retakeCount = sb.retake_count
      sb.retake_variable = res?.retake_variable ?? retakeDimension.value
      sb.retakeVariable = sb.retake_variable
      const summary = res?.change_summary ? ` · ${res.change_summary}` : ''
      toast.success(`重拍完成（第 ${sb.retake_count} 次）${summary}`)
      closeRetakeDialog()
    } catch (e: any) {
      toast.error(e?.message || '重拍失败')
    } finally {
      retakingId.value = null
    }
  }

  function getStoryboardCharacterIds(sb: any) {
    return sb?.character_ids || sb?.characterIds || []
  }

  function getStoryboardCharacterNames(sb: any) {
    const ids = getStoryboardCharacterIds(sb)
    return ctx.chars.value.filter(char => ids.includes(char.id)).map(char => char.name)
  }

  function isStoryboardCharacterSelected(sb: any, charId: number) {
    return getStoryboardCharacterIds(sb).includes(charId)
  }

  function toggleStoryboardCharacter(sb: any, charId: number) {
    const currentIds = getStoryboardCharacterIds(sb)
    const nextIds = currentIds.includes(charId)
      ? currentIds.filter(id => id !== charId)
      : [...currentIds, charId]
    updateField(sb, 'character_ids', nextIds)
  }

  function getSceneName(sb: any) {
    const sceneId = sb?.scene_id || sb?.sceneId
    if (!sceneId) return '未绑定场景'
    const scene = ctx.scenes.value.find(s => s.id === sceneId)
    return scene ? `${scene.location} · ${scene.time || '未设时间'}` : `场景 #${sceneId}`
  }

  async function deleteShot(sb: any) {
    if (!confirm('确定删除此镜头？')) return
    const idx = ctx.sbs.value.indexOf(sb)
    await storyboardAPI.del(sb.id)
    await refresh()
    if (ctx.sbs.value.length) selectedSb.value = ctx.sbs.value[Math.min(idx, ctx.sbs.value.length - 1)]
    else selectedSb.value = null
  }

  return {
    // state
    selectedSb,
    analyzingIntentionId, evaluatingId, retakingId,
    retakeDialog, retakeTargetSb, retakeDimension, retakeUserNote,
    // constants
    shotTypes, shotAngles, shotMovements,
    NEGATIVE_PROMPT_PRESETS, dramaticFunctions, evalDimensions,
    RETAKE_UI_SOFT_CAP, RETAKE_COST_CNY_PER_SHOT, RETAKE_DIMENSIONS,
    // field/style helpers
    applyStylePreset, updateField, toCamel,
    // intention
    parseIntention, intentionField, updateIntentionField, analyzeIntention,
    // eval
    evalScore, hasEvalScores, evalAverage, evalTone, evaluateStoryboard,
    // event density
    eventDensity, eventList, eventCount, eventDensityTone,
    // safety
    safetyFlagged, safetyNotes, safetyOriginal,
    // retake
    retakeCount, retakeVariable, retakeAtCap, retakeDimLabel, retakeCostCNY,
    openRetakeDialog, closeRetakeDialog, submitRetake,
    // storyboard-scene/character helpers
    getStoryboardCharacterIds, getStoryboardCharacterNames,
    isStoryboardCharacterSelected, toggleStoryboardCharacter,
    getSceneName,
    deleteShot,
  }
}

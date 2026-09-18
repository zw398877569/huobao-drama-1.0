import { storyboardAPI } from '~/composables/useApi'
import { ref } from 'vue'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    sbs: Ref<any[]>
  },
  refresh: () => Promise<void>,
}

export function useShotTTS(deps: Deps) {
  const { ctx, refresh } = deps

  // 单镜配音生成 pending 状态 — 模板用 isPendingTTS(sb.id) 绑 :disabled + 改按钮文字
  // v17 修 button disabled 时漏了 TTS (修了 useImageGeneration/useVideoGeneration/useGridTool)
  // 这里补上, 避免用户连点触发重复请求 / 看不到正在生成反馈
  const pendingTTSIds = ref<number[]>([])
  function isPendingTTS(id: number) {
    return pendingTTSIds.value.includes(id)
  }

  // Pattern that matches speaker prefixes for which we should NOT generate TTS
  // (pure ambient audio / SFX / BGM — these need no voiceover).
  const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i

  // Pattern that matches a dialogue body which should be skipped
  // (no dialogue / placeholder / pure ambient / SFX cues).
  const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

  function getDialogueSpeakerRaw(sb: any) {
    const dialogue = sb?.dialogue?.trim() || ''
    const match = dialogue.match(/^(.+?)[:：]/)
    return match ? match[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  }

  function getDialogueText(sb: any) {
    const dialogue = sb?.dialogue?.trim() || ''
    return dialogue ? dialogue.replace(/^.+?[:：]\s*/, '').trim() : ''
  }

  // Strip leading / trailing full-width and half-width parens plus
  // surrounding whitespace from the dialogue body. Shot plans sometimes
  // write values like "旁白：（无对白）" or "旁白:(无对白)" and the raw
  // text would not match IGNORE_TTS_TEXT, leaking an empty narrator
  // card into the dubbing list with a 生成配音 button enabled.
  function normalizeDialogueBody(text: string) {
    return (text || '')
      .replace(/^[\s\uFF08(]+|[\s\uFF09)]+$/g, '')
      .trim()
  }

  function getDialogueBodyNormalized(sb: any) {
    return normalizeDialogueBody(getDialogueText(sb))
  }

  function isTTSIgnorable(sb: any) {
    const speaker = getDialogueSpeakerRaw(sb)
    const text = getDialogueBodyNormalized(sb)
    if (!sb?.dialogue?.trim()) return true
    if (speaker && IGNORE_TTS_SPEAKERS.test(speaker)) return true
    if (!text) return true
    if (IGNORE_TTS_TEXT.test(text)) return true
    return false
  }

  function hasDialogue(sb: any) { return !isTTSIgnorable(sb) }
  function hasTTS(sb: any) { return !!(sb?.tts_audio_url || sb?.ttsAudioUrl) }
  function getTTSUrl(sb: any) { return sb?.tts_audio_url || sb?.ttsAudioUrl || '' }

  // 解析后端存的 tts_segments(JSON 数组 [{ speaker, text, voice, isNarrator, segmentPath }])
  // 老 TTS 记录(只有 ttsAudioUrl 没有 ttsSegments)返回 null
  function getTTSSegments(sb: any) {
    const raw = sb?.tts_segments || sb?.ttsSegments
    if (!raw) return null
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
      return Array.isArray(arr) ? arr : null
    } catch { return null }
  }

  function getDialogueSpeaker(sb: any) {
    const speaker = getDialogueSpeakerRaw(sb)
    if (!speaker) return '旁白'
    return speaker
  }

  async function genShotTTS(sb: any) {
    if (!isPendingTTS(sb.id)) pendingTTSIds.value.push(sb.id)
    try {
      await storyboardAPI.generateTTS(sb.id)
      toast.success(`镜头 #${sb.storyboard_number || sb.storyboardNumber || sb.id} 配音已生成`)
      await refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      pendingTTSIds.value = pendingTTSIds.value.filter(item => item !== sb.id)
    }
  }

  async function batchShotTTS() {
    const pending = ctx.sbs.value.filter(sb => hasDialogue(sb) && !hasTTS(sb))
    if (!pending.length) {
      // pending is 0: either every eligible sb already has TTS, or no sb has dialogue at all.
      // Disambiguate via inline count (avoid cross-composable dep on ttsEligibleCount).
      const eligibleCount = ctx.sbs.value.filter(sb => hasDialogue(sb)).length
      toast.info(eligibleCount ? '所有镜头配音已生成' : '当前没有可生成的对白或旁白')
      return
    }
    // 批量配音一次性 push 所有 id 进 pending, 模板批量按钮绑 isBatchTTSPending 整体置灰
    const pendingIds = pending.map(sb => sb.id)
    for (const id of pendingIds) {
      if (!isPendingTTS(id)) pendingTTSIds.value.push(id)
    }
    try {
      const results = await Promise.allSettled(pending.map(sb => storyboardAPI.generateTTS(sb.id)))
      const okCount = results.filter(r => r.status === 'fulfilled').length
      const failCount = results.length - okCount
      if (okCount) toast.success(`已生成 ${okCount} 条镜头配音`)
      if (failCount) toast.error(`${failCount} 条镜头配音生成失败`)
      await refresh()
    } finally {
      pendingTTSIds.value = pendingTTSIds.value.filter(item => !pendingIds.includes(item))
    }
  }

  return {
    IGNORE_TTS_SPEAKERS, IGNORE_TTS_TEXT,
    getDialogueSpeakerRaw, getDialogueText, getDialogueBodyNormalized, isTTSIgnorable,
    hasDialogue, hasTTS, getTTSUrl,
    getTTSSegments, getDialogueSpeaker,
    pendingTTSIds, isPendingTTS,
    genShotTTS, batchShotTTS,
  }
}

import { storyboardAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    sbs: Ref<any[]>
  },
  refresh: () => Promise<void>,
  ttsEligibleCount?: ComputedRef<number>,
}

export function useShotTTS(deps: Deps) {
  const { ctx, refresh, ttsEligibleCount } = deps

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

  function isTTSIgnorable(sb: any) {
    const speaker = getDialogueSpeakerRaw(sb)
    const text = getDialogueText(sb)
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
    try {
      await storyboardAPI.generateTTS(sb.id)
      toast.success(`镜头 #${sb.storyboard_number || sb.storyboardNumber || sb.id} 配音已生成`)
      await refresh()
    } catch (e: any) { toast.error(e.message) }
  }

  async function batchShotTTS() {
    const pending = ctx.sbs.value.filter(sb => hasDialogue(sb) && !hasTTS(sb))
    if (!pending.length) {
      toast.info(ttsEligibleCount?.value ? '所有镜头配音已生成' : '当前没有可生成的对白或旁白')
      return
    }
    const results = await Promise.allSettled(pending.map(sb => storyboardAPI.generateTTS(sb.id)))
    const okCount = results.filter(r => r.status === 'fulfilled').length
    const failCount = results.length - okCount
    if (okCount) toast.success(`已生成 ${okCount} 条镜头配音`)
    if (failCount) toast.error(`${failCount} 条镜头配音生成失败`)
    await refresh()
  }

  return {
    IGNORE_TTS_SPEAKERS, IGNORE_TTS_TEXT,
    getDialogueSpeakerRaw, getDialogueText, isTTSIgnorable,
    hasDialogue, hasTTS, getTTSUrl,
    getTTSSegments, getDialogueSpeaker,
    genShotTTS, batchShotTTS,
  }
}

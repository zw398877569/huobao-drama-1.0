import { characterAPI, storyboardAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    chars: Ref<any[]>
    sbs: Ref<any[]>
    epId: ComputedRef<number>
    localRaw: Ref<string>
    localScript: Ref<string>
    rawContent: ComputedRef<string>
    scriptStep: Ref<number>
    charsVoiced: ComputedRef<number>
  },
  dramaId: number,
  saveRaw: () => void,
  saveScr: () => void,
  runAgent: (type: string, prompt: string, dramaId: number, episodeId: number, refresh: () => Promise<void>) => void,
  refresh: () => Promise<void>,
  videoConfigs: Ref<any[]>,
  lockedVideoConfigId: ComputedRef<number | null>,
}

export function useEpisodeAgents(deps: Deps) {
  const { ctx, dramaId, saveRaw, saveScr, runAgent, refresh, videoConfigs, lockedVideoConfigId } = deps

  function doRewrite() { saveRaw(); runAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', dramaId, ctx.epId.value, refresh) }

  function skipRewrite() {
    const raw = (ctx.localRaw.value || ctx.rawContent.value || '').trim()
    if (!raw) {
      toast.warning('请先填写原始内容')
      return
    }
    ctx.localScript.value = raw
    saveScr()
    toast.success('已跳过 AI 改写，当前将直接使用原始内容')
    ctx.scriptStep.value = 2
  }

  function doExtract() { saveScr(); runAgent('extractor', '请从剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并', dramaId, ctx.epId.value, refresh) }
  function doVoice() { runAgent('voice_assigner', '请为所有角色分配合适的音色', dramaId, ctx.epId.value, refresh) }

  async function batchGenSamples() {
    const pending = ctx.chars.value.filter(c => (c.voice_style || c.voiceStyle) && !(c.voice_sample_url || c.voiceSampleUrl))
    if (!pending.length) {
      toast.info(ctx.charsVoiced.value ? '所有角色的试听文件已生成' : '请先分配音色')
      return
    }
    const results = await Promise.allSettled(pending.map(c => characterAPI.voiceSample(c.id, ctx.epId.value)))
    const okCount = results.filter(r => r.status === 'fulfilled').length
    const failCount = results.length - okCount
    if (okCount) toast.success(`已生成 ${okCount} 份试听文件`)
    if (failCount) toast.error(`${failCount} 份试听文件生成失败`)
    await refresh()
  }

  function doBreakdown() {
    const cfg = videoConfigs.value.find(c => c.id === lockedVideoConfigId.value)
    const label = cfg ? `${cfg.name} (${cfg.provider})` : '默认'
    runAgent('storyboard_breaker', `请拆解分镜并生成视频提示词。视频模型：${label}，请根据该模型的特性和时长限制生成合适的视频提示词。`, dramaId, ctx.epId.value, refresh)
  }

  async function genSample(id: number) {
    try {
      await characterAPI.voiceSample(id, ctx.epId.value)
      toast.success('试听已生成')
      refresh()
    } catch (e: any) { toast.error(e.message) }
  }

  async function addShot() {
    await storyboardAPI.create({
      episode_id: ctx.epId.value,
      storyboard_number: ctx.sbs.value.length + 1,
      title: `镜头${ctx.sbs.value.length + 1}`,
      duration: 10,
    })
    refresh()
  }

  return {
    doRewrite, skipRewrite, doExtract, doVoice,
    batchGenSamples, doBreakdown, genSample, addShot,
  }
}

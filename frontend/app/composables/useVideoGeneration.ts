import { videoAPI, composeAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    sbs: Ref<any[]>
    epId: ComputedRef<number>
    dramaId: number
  },
  refresh: () => Promise<void>,
  getFirstFrame: (s: any) => string | null,
  getLastFrame: (s: any) => string | null,
  getRefs: (s: any) => string[],
  hasVid: (s: any) => boolean,
  watchAsyncResult: (check: () => boolean, attempts?: number, delay?: number) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
}

export function useVideoGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, hasVid, watchAsyncResult, sleep } = deps

  const pendingVideoIds = ref<number[]>([])
  const pendingComposeIds = ref<number[]>([])
  const failedVideoMessages = ref<Record<number, string>>({})
  const failedComposeMessages = ref<Record<number, string>>({})

  function isPendingVideo(id: number) {
    return pendingVideoIds.value.includes(id)
  }
  function videoFailMessage(id: number) {
    return failedVideoMessages.value[id]
  }
  function isPendingCompose(id: number) {
    return pendingComposeIds.value.includes(id)
  }
  function composeFailMessage(id: number) {
    return failedComposeMessages.value[id]
  }

  async function genVid(sb: any) {
    let prompt = sb.video_prompt || sb.videoPrompt || ''
    // 有首帧时自动附加首帧一致性约束（Pavo AI 的镜头运动要求）
    const first = getFirstFrame(sb)
    const last = getLastFrame(sb)
    const refs = getRefs(sb)
    if (first && prompt) {
      prompt += '；保持首帧画面构图一致，镜头运动从首帧状态开始'
    }
    const params = {
      storyboard_id: sb.id,
      drama_id: ctx.dramaId,
      prompt,
      duration: Number(sb.duration || 5),
    }
    if (first && last) { Object.assign(params, { reference_mode: 'first_last', first_frame_url: first, last_frame_url: last }) }
    else if (refs.length) { Object.assign(params, { reference_mode: 'multiple', reference_image_urls: [first, ...refs].filter(Boolean) }) }
    else if (first) { Object.assign(params, { reference_mode: 'single', image_url: first }) }
    try {
      delete failedVideoMessages.value[sb.id]
      if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
      const generation = await videoAPI.generate(params)
      toast.success('视频生成中')
      await refresh()
      pollVideoGeneration(generation?.id, sb.id)
    } catch (e: any) {
      pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
      toast.error(e.message)
    }
  }

  async function pollVideoGeneration(generationId: string | number | undefined, storyboardId: number) {
    if (!generationId) {
      await watchAsyncResult(() => {
        const target = ctx.sbs.value.find(s => s.id === storyboardId)
        const done = !!(target?.video_url || target?.videoUrl)
        if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        return done
      }, 60, 4000)
      return
    }
    for (let i = 0; i < 120; i++) {
      await sleep(4000)
      try {
        const res = await videoAPI.get(generationId)
        await refresh()
        if (res?.status === 'completed') {
          pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
          delete failedVideoMessages.value[storyboardId]
          toast.success('视频生成完成')
          return
        }
        if (res?.status === 'failed') {
          pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
          failedVideoMessages.value = {
            ...failedVideoMessages.value,
            [storyboardId]: res?.error_msg || res?.errorMsg || '视频生成失败',
          }
          toast.error(failedVideoMessages.value[storyboardId])
          return
        }
      } catch {}
    }
    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
    failedVideoMessages.value = {
      ...failedVideoMessages.value,
      [storyboardId]: '视频生成超时',
    }
    toast.error('视频生成超时')
  }

  function batchVideos() {
    const pendingIds = ctx.sbs.value.filter(s => !hasVid(s)).map(s => s.id)
    pendingIds.forEach(id => {
      const sb = ctx.sbs.value.find(item => item.id === id)
      if (sb) genVid(sb)
    })
    if (pendingIds.length) {
      pendingVideoIds.value = [...new Set([...pendingVideoIds.value, ...pendingIds])]
      void watchAsyncResult(() => pendingIds.every(id => {
        const target = ctx.sbs.value.find(s => s.id === id)
        const done = !!(target?.video_url || target?.videoUrl)
        if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== id)
        return done
      }), 80, 4000)
    }
  }

  async function doCompose(sb: any) {
    try {
      delete failedComposeMessages.value[sb.id]
      if (!isPendingCompose(sb.id)) pendingComposeIds.value.push(sb.id)
      await composeAPI.shot(sb.id)
      toast.success('合成完成')
      pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
      refresh()
    } catch (e: any) {
      pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
      failedComposeMessages.value = {
        ...failedComposeMessages.value,
        [sb.id]: e.message,
      }
      toast.error(e.message)
    }
  }

  async function batchCompose() {
    await composeAPI.all(ctx.epId.value)
    pendingComposeIds.value = [...new Set(ctx.sbs.value.filter(sb => !!sb.video_url || !!sb.videoUrl).map(sb => sb.id))]
    toast.success('批量合成已开始')
    pollComposeStatus()
  }

  async function pollComposeStatus() {
    for (let i = 0; i < 120; i++) {
      await sleep(3000)
      try {
        const res = await composeAPI.status(ctx.epId.value)
        await refresh()
        const items = Array.isArray(res?.items) ? res.items : []
        const processingIds = items.filter((item: any) => item.status === 'compose_processing').map((item: any) => item.id)
        pendingComposeIds.value = processingIds

        const failedItems = items.filter((item: any) => item.status === 'compose_failed')
        if (failedItems.length) {
          const next = { ...failedComposeMessages.value }
          failedItems.forEach((item: any) => {
            next[item.id] = item.error_msg || item.errorMsg || '视频合成失败'
          })
          failedComposeMessages.value = next
        }

        if (!processingIds.length) {
          if (failedItems.length) toast.error(`有 ${failedItems.length} 个镜头合成失败`)
          else toast.success('批量合成完成')
          return
        }
      } catch {}
    }
  }

  return {
    pendingVideoIds, pendingComposeIds, failedVideoMessages, failedComposeMessages,
    isPendingVideo, videoFailMessage, isPendingCompose, composeFailMessage,
    genVid, batchVideos, doCompose, batchCompose, pollVideoGeneration, pollComposeStatus,
  }
}

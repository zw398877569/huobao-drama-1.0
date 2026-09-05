import { toast } from 'vue-sonner'
import { characterAPI, sceneAPI, imageAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    chars: Ref<any[]>
    scenes: Ref<any[]>
    sbs: Ref<any[]>
    epId: ComputedRef<number>
    dramaId: number
  },
  refresh: () => Promise<void>,
  getFirstFrame: (s: any) => string | null,
  getLastFrame: (s: any) => string | null,
  getRefs: (s: any) => string[],
  getStoryboardCharacterNames: (s: any) => string[],
  getSceneName: (s: any) => string,
  watchAsyncResult: (check: () => boolean, attempts?: number, delay?: number) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  videoConfigLabel?: string,
  /** Drama 风格的正向 token (来自 useStylePresets 解析 drama.style) — 注入 buildShotImagePrompt */
  positiveShotTokens?: Ref<string>,
}

export function useImageGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, getStoryboardCharacterNames, getSceneName, watchAsyncResult, sleep, videoConfigLabel, positiveShotTokens } = deps

  const pendingCharImageIds = ref<number[]>([])
  const pendingSceneImageIds = ref<number[]>([])
  const pendingShotFrameKeys = ref<string[]>([])

  function framePendingKey(id: number, frameType: string) {
    return `${id}:${frameType}`
  }
  function isPendingCharImage(id: number) {
    return pendingCharImageIds.value.includes(id)
  }
  function isPendingSceneImage(id: number) {
    return pendingSceneImageIds.value.includes(id)
  }
  function isPendingShotFrame(id: number, frameType: string) {
    return pendingShotFrameKeys.value.includes(framePendingKey(id, frameType))
  }

  // 写"图片N = 角色X,保持其脸部特征"提示,改善 nano-banana 角色一致性 (2026-08-22)
  function buildShotReferenceAssets(sb: any) {
    const assets: any[] = []
    const pushAsset = (asset: any) => {
      if (!asset?.path || assets.some(a => a.path === asset.path) || assets.length >= 6) return
      assets.push(asset)
    }

    const sceneId = sb?.scene_id || sb?.sceneId
    const scene = ctx.scenes.value.find(item => item.id === sceneId)
    if (scene?.image_url || scene?.imageUrl) {
      pushAsset({
        path: scene.image_url || scene.imageUrl,
        kind: 'scene',
        label: scene.location ? `${scene.location}${scene.time ? `(${scene.time})` : ''}场景` : '场景',
      })
    }

    const charIds = sb?.character_ids || sb?.characterIds || []
    for (const charId of charIds) {
      const char = ctx.chars.value.find(item => item.id === charId)
      const path = char?.image_url || char?.imageUrl
      if (!path) continue
      pushAsset({
        path,
        kind: 'character',
        label: `${char.name}角色形象`,
        characterName: char.name,
        characterAppearance: (char.appearance || char.description || '').trim(),
      })
    }

    for (const ref of getRefs(sb)) {
      pushAsset({ path: ref, kind: 'reference', label: '参考图' })
    }

    const first = getFirstFrame(sb)
    const last = getLastFrame(sb)
    if (first) pushAsset({ path: first, kind: 'first_frame', label: '已生成首帧' })
    if (last) pushAsset({ path: last, kind: 'last_frame', label: '已生成尾帧' })

    return assets.map((a, i) => ({ ...a, index: i + 1, imageLabel: `图片${i + 1}` }))
  }

  // 向后兼容: 保留 getShotReferenceImages,内部走 buildShotReferenceAssets
  function getShotReferenceImages(sb: any) {
    return buildShotReferenceAssets(sb).map(a => a.path)
  }

  function buildShotImagePrompt(sb: any, frameType: string) {
    const title = sb.title || ''
    const description = sb.image_prompt || sb.imagePrompt || sb.description || ''
    const shotType = sb.shot_type || sb.shotType || ''
    const angle = sb.angle || ''
    const movement = sb.movement || ''
    const location = sb.location || getSceneName(sb)
    const time = sb.time || ''
    const charactersText = getStoryboardCharacterNames(sb).join('、')
    const action = sb.action || ''
    const atmosphere = sb.atmosphere || ''
    const frameHint = frameType === 'first_frame'
      ? '生成这个镜头的起始关键帧，突出建立关系和动作开始瞬间'
      : '生成这个镜头的结束关键帧，突出动作结束、情绪落点或结果状态'

    const assets = buildShotReferenceAssets(sb)
    const characterAssets = assets.filter(a => a.kind === 'character')

    const sections = [
      title ? `镜头标题：${title}` : '',
      description ? `画面描述：${description}` : '',
      shotType ? `景别：${shotType}` : '',
      angle ? `机位：${angle}` : '',
      movement ? `运镜：${movement}` : '',
      charactersText ? `角色：${charactersText}` : '',
      // 给每个角色追加外貌描述,空时只保留名字
      ...characterAssets.map(a => {
        const appearance = a.characterAppearance ? `:${a.characterAppearance}` : ''
        return `${a.characterName}外貌${appearance}`
      }),
      location ? `地点：${location}` : '',
      time ? `时间：${time}` : '',
      action ? `动作：${action}` : '',
      atmosphere ? `氛围：${atmosphere}` : '',
      frameHint,
    ]

    // 参考图说明 + 角色一致性要求(nano-banana 的 images 字段不强制 character
    // consistency,必须用 prompt 显式声明谁对应哪张图,并要求保持脸部特征)
    if (assets.length) {
      const legend = assets.map(a => {
        const detail = a.characterAppearance
          ? `${a.characterName}(${a.characterAppearance})`
          : a.label
        return `${a.imageLabel}=${detail}`
      }).join('；')
      sections.push(`参考图: ${legend}`)
      if (characterAssets.length) {
        sections.push(
          `角色一致性: ${characterAssets.map(a => a.imageLabel).join('、')} 是 ${characterAssets.map(a => a.characterName).join('、')} 的形象参考,`
          + `首帧中必须严格保持其脸部特征、发型、年龄、衣着,不要换脸或改变体型。`
        )
      }
    }

    // H3-aware hint: if downstream video model is H3, nudge the image model to produce
    // a first/last frame that's compatible with H3's training distribution (single subject,
    // stable composition, cinematic). Helps avoid the "AI-generated still that H3 can't
    // smoothly animate from" problem.
    if (videoConfigLabel && /H3|minimax/i.test(videoConfigLabel)) {
      const frameRole = frameType === 'first_frame' ? 'first' : 'last'
      sections.push(
        '# 下游视频模型: MiniMax H3 — 此图为 ' + frameRole + ' 帧输入；' +
        '构图需稳定单一主体 + 半身/全身景别 + 自然光影 + 半写实电影感；' +
        '避免极端运镜、动作模糊、文字水印、多余人物'
      )
    }

    // Drama 风格正向 token (来自 useStylePresets 解析 drama.style)
    // — 跟后端 9 宫格 (runGenerateShotPrompts) 注入的 positiveShotTokens 同步,
    //   保证同一部剧的 9 宫格预览和首尾帧视觉一致
    if (positiveShotTokens?.value) {
      sections.push('# 风格: ' + positiveShotTokens.value)
    }

    return sections.filter(Boolean).join('；')
  }

  // ── 轮询 helper ─────────────────────────────────────────────
  // 早期实现把 imageAPI.get(genId) 写在 watchAsyncResult 的 check() 里,
  // 每个 tick (2s) 都发一次 GET — 单个角色 4 分钟会发 ~60 次多余请求。
  // 改成显式 for + sleep(8s) + 串行查: 单角色最多 30 次 × 8s = 4 分钟。
  // 批量场景: 每个 tick 一次 Promise.all(genIds) 而不是 N 次串行,所有角色
  // 共用 30 次 tick 周期,而不是 N×30 次。
  async function pollImageGeneration(genId: number, charId: number) {
    for (let i = 0; i < 30; i++) {
      await sleep(8000)
      try {
        const res = await imageAPI.get(genId)
        // 状态字段: 后端 DB 写 'completed',某些 adapter 早期写过 'succeeded'
        if (res?.status === 'completed' || res?.status === 'succeeded') {
          await refresh()
          pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== charId)
          return
        }
        if (res?.status === 'failed') {
          pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== charId)
          toast.error(res?.error_msg || res?.errorMsg || '图片生成失败')
          return
        }
      } catch {}
    }
    // 超时
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== charId)
    toast.error('图片生成超时')
  }

  // 批量轮询: 每个 tick 一次 Promise.all,所有 genId 共享一个 8s 周期
  async function pollBatchImageGeneration(genIds: (number | null)[], charIds: number[]) {
    for (let i = 0; i < 30; i++) {
      await sleep(8000)
      try {
        const results = await Promise.all(
          genIds.map(gid => gid ? imageAPI.get(gid).catch(() => null) : Promise.resolve(null))
        )
        let allDone = true
        let anyFailed = false
        for (let j = 0; j < results.length; j++) {
          const res = results[j]
          const charId = charIds[j]
          if (res?.status === 'completed' || res?.status === 'succeeded') {
            pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== charId)
          } else if (res?.status === 'failed') {
            pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== charId)
            anyFailed = true
          } else {
            allDone = false
          }
        }
        if (anyFailed) toast.error('部分图片生成失败')
        if (allDone) {
          await refresh()
          return
        }
        // 部分还在跑 — refresh 让 UI 显示已完成的角色
        await refresh()
      } catch {}
    }
    // 超时: 清理所有未完成的
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !charIds.includes(item))
    toast.error('部分图片生成超时')
  }

  async function genCharImg(id: number) {
    let genId: number | null = null
    try {
      if (!isPendingCharImage(id)) pendingCharImageIds.value.push(id)
      const resp = await characterAPI.generateImage(id, ctx.epId.value) as any
      genId = resp?.image_generation_id || null
      toast.success('角色图片生成中')
      await refresh()
      // 早期实现: watchAsyncResult 内每 2s 调 imageAPI.get(genId) — 60 次多余请求
      // 新实现: 显式 for + sleep(8s) + 单次 imageAPI.get — 最多 30 次
      if (genId) {
        await pollImageGeneration(genId, id)
      } else {
        // 拿不到 genId(极端情况) — 退回 watchAsyncResult 模式
        await watchAsyncResult(() => {
          const char = ctx.chars.value.find(c => c.id === id)
          const done = !!(char?.image_url || char?.imageUrl)
          if (done) {
            pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
            return true
          }
          return false
        })
      }
    } catch (e: any) {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
      toast.error(e.message)
    }
  }

  function batchCharImages() {
    // isNarratorCharacter 抽到 utils/character.ts (Nuxt 3 auto-import)
    const ids = ctx.chars.value
      .filter(c => !isNarratorCharacter(c) && !(c.image_url || c.imageUrl))
      .map(c => c.id)
    if (!ids.length) {
      toast.info('所有角色图片已生成')
      return
    }
    pendingCharImageIds.value = [...new Set([...pendingCharImageIds.value, ...ids])]
    characterAPI.batchImages(ids, ctx.epId.value).then(async (resp: any) => {
      toast.success('角色图片批量生成中')
      await refresh()
      const genIds: (number | null)[] = resp?.ids || []
      // 早期实现: watchAsyncResult 内每 2s 给每个 genId 各发一次 imageAPI.get
      //          — 5 角色 × 60 tick = 300 次请求
      // 新实现: 共享一个 8s 周期,Promise.all(genIds) 一次拿全状态
      if (genIds.some(Boolean)) {
        await pollBatchImageGeneration(genIds, ids)
      } else {
        // 极端情况: 拿不到任何 genId,退回 watchAsyncResult
        await watchAsyncResult(() => ids.every(id => {
          const char = ctx.chars.value.find(c => c.id === id)
          const done = !!(char?.image_url || char?.imageUrl)
          if (done) pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
          return done
        }))
      }
    }).catch((e: any) => {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !ids.includes(item))
      toast.error(e.message)
    })
  }

  async function genSceneImg(id: number) {
    try {
      if (!isPendingSceneImage(id)) pendingSceneImageIds.value.push(id)
      await sceneAPI.generateImage(id, ctx.epId.value)
      toast.success('场景图片生成中')
      await refresh()
      await watchAsyncResult(() => {
        const scene = ctx.scenes.value.find(s => s.id === id)
        // 成功: 有图片; 失败: 明确标记 failed — 两种终态都要退出轮询
        const isFailed = scene?.status === 'failed'
        const done = !!(scene?.image_url || scene?.imageUrl)
        if (done || isFailed) {
          pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
          if (isFailed) toast.error(scene?.error_msg || scene?.errorMsg || '场景图片生成失败')
          return true
        }
        return false
      })
    } catch (e: any) {
      pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
      toast.error(e.message)
    }
  }

  function batchSceneImages() {
    const ids = ctx.scenes.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
    if (!ids.length) {
      toast.info('所有场景图片已生成')
      return
    }
    pendingSceneImageIds.value = [...new Set([...pendingSceneImageIds.value, ...ids])]
    ids.forEach(id => { sceneAPI.generateImage(id, ctx.epId.value).then(() => refresh()).catch((e: any) => toast.error(e.message)) })
    toast.success('场景图片批量生成中')
    // 轮询等到全部场景都到终态(image_url 有 OR status=failed),然后统计失败数 toast
    void watchAsyncResult(() => {
      const scenes = ids.map(id => ctx.scenes.value.find(s => s.id === id))
      const allDone = scenes.every(s =>
        !!(s?.image_url || s?.imageUrl) || s?.status === 'failed'
      )
      if (!allDone) return false
      // 全部到终态 — 清理 pending + 提示
      pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => !ids.includes(item))
      const failedCount = scenes.filter(s => s?.status === 'failed').length
      if (failedCount > 0) {
        toast.error(`${failedCount} 个场景图片生成失败`)
      } else {
        toast.success('所有场景图片生成完成')
      }
      return true
    }, 36)
  }

  async function genShotFrame(sb: any, frameType: string) {
    const prompt = buildShotImagePrompt(sb, frameType)
    const referenceImages = getShotReferenceImages(sb)
    const key = framePendingKey(sb.id, frameType)
    try {
      if (!pendingShotFrameKeys.value.includes(key)) pendingShotFrameKeys.value.push(key)
      const body = {
        storyboard_id: sb.id,
        drama_id: ctx.dramaId,
        prompt,
        frame_type: frameType,
        reference_images: referenceImages.length ? referenceImages : undefined,
      }
      await imageAPI.generate(body)
      toast.success(frameType === 'first_frame' ? '首帧生成中' : '尾帧生成中')
      await refresh()
      await watchAsyncResult(() => {
        const target = ctx.sbs.value.find(s => s.id === sb.id)
        // 成功: 有首/尾帧; 失败: storyboard.status=failed — 两种终态都退出轮询
        const isFailed = target?.status === 'failed'
        const done = (frameType === 'first_frame' ? !!getFirstFrame(target) : !!getLastFrame(target)) || isFailed
        if (done) {
          pendingShotFrameKeys.value = pendingShotFrameKeys.value.filter(item => item !== key)
          if (isFailed) toast.error(target?.error_msg || target?.errorMsg || '首尾帧生成失败')
        }
        return done
      })
    } catch (e: any) {
      pendingShotFrameKeys.value = pendingShotFrameKeys.value.filter(item => item !== key)
      toast.error(e.message)
    }
  }

  return {
    pendingCharImageIds, pendingSceneImageIds, pendingShotFrameKeys,
    isPendingCharImage, isPendingSceneImage, isPendingShotFrame, framePendingKey,
    genCharImg, batchCharImages, genSceneImg, batchSceneImages, genShotFrame,
    buildShotReferenceAssets, getShotReferenceImages, buildShotImagePrompt,
  }
}

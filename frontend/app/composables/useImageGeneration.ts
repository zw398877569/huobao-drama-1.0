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
  videoConfigLabel?: string,
}

export function useImageGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, getStoryboardCharacterNames, getSceneName, watchAsyncResult, videoConfigLabel } = deps

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

    return sections.filter(Boolean).join('；')
  }

  async function genCharImg(id: number) {
    try {
      if (!isPendingCharImage(id)) pendingCharImageIds.value.push(id)
      await characterAPI.generateImage(id, ctx.epId.value)
      toast.success('角色图片生成中')
      await refresh()
      await watchAsyncResult(() => {
        const char = ctx.chars.value.find(c => c.id === id)
        const done = !!(char?.image_url || char?.imageUrl)
        if (done) {
          pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
          return true
        }
        return false
      })
    } catch (e: any) {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
      toast.error(e.message)
    }
  }

  function batchCharImages() {
    // visualChars (排除旁白) 由页面提供:需要 chars + isNarratorCharacter
    // 这里只读 ctx.chars,过滤交给调用方 OR 重新在此过滤(用相同规则)
    // 为保持行为一致,直接在调用方过滤
    const allChars = ctx.chars.value
    const narrator = (c: any) => {
      const text = `${c?.name || ''} ${c?.role || ''}`.toLowerCase()
      return text.includes('旁白') || text.includes('narrator') || text.includes('画外音')
    }
    const ids = allChars.filter(c => !narrator(c) && !(c.image_url || c.imageUrl)).map(c => c.id)
    if (!ids.length) {
      toast.info('所有角色图片已生成')
      return
    }
    pendingCharImageIds.value = [...new Set([...pendingCharImageIds.value, ...ids])]
    characterAPI.batchImages(ids, ctx.epId.value).then(async () => {
      toast.success('角色图片批量生成中')
      await refresh()
      await watchAsyncResult(() => ids.every(id => {
        const char = ctx.chars.value.find(c => c.id === id)
        const done = !!(char?.image_url || char?.imageUrl)
        if (done) pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
        return done
      }))
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
        const done = !!(scene?.image_url || scene?.imageUrl)
        if (done) {
          pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
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
    void watchAsyncResult(() => ids.every(id => {
      const scene = ctx.scenes.value.find(s => s.id === id)
      const done = !!(scene?.image_url || scene?.imageUrl)
      if (done) pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
      return done
    }), 36)
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
        const done = frameType === 'first_frame' ? !!getFirstFrame(target) : !!getLastFrame(target)
        if (done) pendingShotFrameKeys.value = pendingShotFrameKeys.value.filter(item => item !== key)
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

import { toast } from 'vue-sonner'
import { characterAPI, sceneAPI, propsAPI, imageAPI } from '~/composables/useApi'
import type { Ref, ComputedRef } from 'vue'

type Deps = {
  ctx: {
    chars: Ref<any[]>
    scenes: Ref<any[]>
    keyProps: Ref<any[]>
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
  /** 制作 tab 临时覆盖的图片配置 id，null 时回退到 episode 锁定配置 */
  imageConfigIdRef?: Ref<string | number | null>,
}

export function useImageGeneration(deps: Deps) {
  const { ctx, refresh, getFirstFrame, getLastFrame, getRefs, getStoryboardCharacterNames, getSceneName, watchAsyncResult, sleep, videoConfigLabel, positiveShotTokens, imageConfigIdRef } = deps

  const pendingCharImageIds = ref<number[]>([])
  const pendingSceneImageIds = ref<number[]>([])
  const pendingPropImageIds = ref<number[]>([])
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
  function isPendingPropImage(id: number) {
    return pendingPropImageIds.value.includes(id)
  }
  function isPendingShotFrame(id: number, frameType: string) {
    return pendingShotFrameKeys.value.includes(framePendingKey(id, frameType))
  }

  /**
   * ★ Sprint 28 Task A (PM msg-20261028-128): 参考图的数量上限与优先级。
   *
   * 原来是『先来先占, 攒够 6 张就不收了』→ 加了接力图之后, 角色多的镜头会把关键的角色图挤掉
   * (用户/PM 都点名过这个风险)。改成【按优先级取前 6 张】:
   *   接力(上一镜末帧) > 角色 > 场景 > 本镜首/尾帧 > 其它参考图
   * → 角色图(决定脸, 掉了就换脸)优先于场景图(决定空间; 而接力图本身已经提供了空间延续信息)。
   *   实测: 5 个角色的镜头 = 接力1 + 角色5 = 6 张, 角色图全保住, 只挤掉场景图;
   *   6 个角色(极端情况)会挤掉 1 张角色图 —— 被挤掉的会 console.warn 出来。
   */
  const SHOT_REFERENCE_LIMIT = 6

  /**
   * ★ 接力图放在参考图数组的第几位: 'first' = 置首 (默认), 'last' = 追加到末尾。
   *
   * PM 单里让 dev 实测两种顺序 (A=[上一镜末帧,场景,角色] / B=[场景,角色,上一镜末帧]) 哪个
   * 『空间延续』更明显 —— 我没法自己跑生图做 A/B 对比 (没有成片判读能力), 所以做成常量:
   * 实测后改这一行就能切换。
   *
   * 默认 'first' 的理由: 用户的核心诉求是【空间连续性】(『两个视频之间毫无关联』『衔接割裂』),
   * 而 nano-banana 对参考图数组的【第一张】权重最高 (它通常被当作主图);
   * 过度照抄上一镜的风险, 用 prompt 里的『承接但不要重复』指引来压 (见 buildShotImagePrompt)。
   */
  const SHOT_RELAY_REFERENCE_POSITION: 'first' | 'last' = 'first'

  /**
   * 找到上一镜 (同 episode 内 storyboard_number = 当前 - 1) —— 接力参考的来源。
   *
   * ★ Sprint 28 Task A: D2 决策是【全链接力】—— 用户反例『人物从屋内走到屋外, 屋内是一个分镜
   *   屋外是另一个, 同场景内接力的话这两个分镜割裂感依然很强烈』→ 场景边界 ≠ 叙事断点,
   *   所以【跨场景也接力】, 只按镜头序号找上一镜, 不看 scene。
   */
  function findPrevShot(sb: any) {
    const num = Number(sb?.storyboard_number ?? sb?.storyboardNumber ?? 0)
    if (!num) return null
    return ctx.sbs.value.find((s: any) => {
      const n = Number(s?.storyboard_number ?? s?.storyboardNumber ?? 0)
      return n === num - 1
    }) || null
  }

  // 写"图片N = 角色X,保持其脸部特征"提示,改善 nano-banana 角色一致性 (2026-08-22)
  // 2026-09-18 fix: 加 excludeFirstFrame 参数, 重新生成 first_frame 时不引用旧 first_frame
  //   (避免把"待替换的旧图"作为参考让 LLM 复制旧图的错误)
  function buildShotReferenceAssets(sb: any, excludeFirstFrame = false) {
    // ① 先收集候选 (带优先级), 后面统一排序取前 N 张
    const candidates: Array<{ asset: any; priority: number }> = []
    const pushAsset = (asset: any, priority: number) => {
      if (!asset?.path) return
      if (candidates.some(c => c.asset.path === asset.path)) return
      candidates.push({ asset, priority })
    }

    // ★ 接力图 (上一镜末帧) —— 优先级最高
    const prevShot = findPrevShot(sb)
    const prevLastFrame = prevShot ? (prevShot.last_frame_image || prevShot.lastFrameImage || null) : null
    const prevShotNumber = prevShot ? Number(prevShot.storyboard_number ?? prevShot.storyboardNumber ?? 0) : 0
    if (prevLastFrame) {
      pushAsset({
        path: prevLastFrame,
        kind: 'prev_shot',
        label: `上一镜#${prevShotNumber}末帧`,
        prevShotNumber,
      }, 0)
    }

    const sceneId = sb?.scene_id || sb?.sceneId
    const scene = ctx.scenes.value.find(item => item.id === sceneId)
    if (scene?.image_url || scene?.imageUrl) {
      pushAsset({
        path: scene.image_url || scene.imageUrl,
        kind: 'scene',
        label: scene.location ? `${scene.location}${scene.time ? `(${scene.time})` : ''}场景` : '场景',
      }, 2)
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
        // V2 治本 (msg-20261010-001): characters.appearance 列被 DROP, 改读 appearance_permanent (snake/camel 双兼容)
        characterAppearance: ((char as any).appearance_permanent || char.appearancePermanent || char.description || '').trim(),
      }, 1)
    }

    // 重新生成 first_frame 时跳过 first_frame 引用 (避免参考待替换的旧图)
    // last_frame 引用 first_frame 仍合法 (保持视觉连贯)
    const first = excludeFirstFrame ? null : getFirstFrame(sb)
    const last = getLastFrame(sb)
    if (first) pushAsset({ path: first, kind: 'first_frame', label: '已生成首帧' }, 3)
    if (last) pushAsset({ path: last, kind: 'last_frame', label: '已生成尾帧' }, 3)

    for (const ref of getRefs(sb)) {
      pushAsset({ path: ref, kind: 'reference', label: '参考图' }, 4)
    }

    // ② 按优先级取前 N 张; ③ 接力图按 SHOT_RELAY_REFERENCE_POSITION 决定置首还是置尾
    const sorted = candidates.slice().sort((a, b) => a.priority - b.priority)
    const kept = sorted.slice(0, SHOT_REFERENCE_LIMIT)
    const dropped = sorted.slice(SHOT_REFERENCE_LIMIT)
    if (dropped.length) {
      console.warn('[shot-reference] 超出上限被丢弃:', dropped.map(d => d.asset.kind + ':' + (d.asset.label || '')))
    }
    const relay = kept.filter(c => c.asset.kind === 'prev_shot')
    const rest = kept.filter(c => c.asset.kind !== 'prev_shot')
    const ordered = SHOT_RELAY_REFERENCE_POSITION === 'first'
      ? [...relay, ...rest]
      : [...rest, ...relay]

    return ordered.map((c, i) => ({ ...c.asset, index: i + 1, imageLabel: `图片${i + 1}` }))
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

    // ★ Sprint 28 Task A: 与 genShotFrame 用【同一份】assets (excludeFirstFrame 口径一致)
    //   —— 原来两边口径不同 (prompt 的 legend 带 excludeFirstFrame=false 的列表, 实际发的是 true 的列表)
    //   → 重新生成首帧时 legend 的编号跟实际 images 数组会错位一格。
    const assets = buildShotReferenceAssets(sb, frameType === 'first_frame')
    const characterAssets = assets.filter(a => a.kind === 'character')
    const relayAsset = assets.find(a => a.kind === 'prev_shot')

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

    // ★ Sprint 28 Task A: 接力指引 —— 明确告诉模型这张图是"上一镜的结束画面", 要承接它的空间关系。
    //   光把图塞进参考图数组不够 (模型不知道它是什么), 这句话才是接力的关键。
    if (relayAsset) {
      sections.push(
        `连续性: ${relayAsset.imageLabel} 是上一镜的结束画面 —— 本镜的构图必须【承接】它: `
        + `同一空间/同一机位高度与光线方向/人物位置与视线方向延续, `
        + `但只承接空间关系, 【不要照抄】它的画面内容与人物动作。`
      )
    }

    // 参考图说明 + 角色一致性要求(nano-banana 的 images 字段不强制 character
    // consistency,必须用 prompt 显式声明谁对应哪张图,并要求保持脸部特征)
    if ((assets?.length ?? 0) > 0) {
      const legend = assets.map(a => {
        const detail = a.characterAppearance
          ? `${a.characterName}(${a.characterAppearance})`
          : a.label
        return `${a.imageLabel}=${detail}`
      }).join('；')
      sections.push(`参考图: ${legend}`)
      if ((characterAssets?.length ?? 0) > 0) {
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
      } catch (e: any) {
      }
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
        for (let j = 0; j < (results?.length ?? 0); j++) {
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
      const resp = await characterAPI.generateImage(id, ctx.epId.value, imageConfigIdRef?.value) as any
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
    if (!((ids?.length ?? 0) > 0)) {
      toast.info('所有角色图片已生成')
      return
    }
    pendingCharImageIds.value = [...new Set([...pendingCharImageIds.value, ...ids])]
    characterAPI.batchImages(ids, ctx.epId.value, imageConfigIdRef?.value).then(async (resp: any) => {
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
      await sceneAPI.generateImage(id, ctx.epId.value, imageConfigIdRef?.value)
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
    if (!((ids?.length ?? 0) > 0)) {
      toast.info('所有场景图片已生成')
      return
    }
    pendingSceneImageIds.value = [...new Set([...pendingSceneImageIds.value, ...ids])]
    ids.forEach(id => { sceneAPI.generateImage(id, ctx.epId.value, imageConfigIdRef?.value).then(() => refresh()).catch((e: any) => toast.error(e.message)) })
    toast.success('场景图片批量生成中')
    void watchAsyncResult(() => {
      const scenes = ids.map(id => ctx.scenes.value.find(s => s.id === id))
      const allDone = scenes.every(s =>
        !!(s?.image_url || s?.imageUrl) || s?.status === 'failed'
      )
      if (!allDone) return false
      pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => !ids.includes(item))
      const failedCount = (scenes?.filter(s => s?.status === 'failed') || []).length
      if (failedCount > 0) {
        toast.error(`${failedCount} 个场景图片生成失败`)
      } else {
        toast.success('所有场景图片生成完成')
      }
      return true
    }, 36)
  }

  async function genPropImg(id: number) {
    try {
      if (!isPendingPropImage(id)) pendingPropImageIds.value.push(id)
      await propsAPI.generateImage(id, ctx.epId.value, imageConfigIdRef?.value)
      toast.success('道具图片生成中')
      await refresh()
      await watchAsyncResult(() => {
        const prop = ctx.keyProps.value.find(s => s.id === id)
        const done = !!(prop?.image_url || prop?.imageUrl)
        if (done) {
          pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
          return true
        }
        return false
      })
    } catch (e: any) {
      pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
      toast.error(e.message)
    }
  }

  async function batchPropImages() {
    const ids = ctx.keyProps.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
    if (!ids.length) {
      toast.info('所有道具图片已生成')
      return
    }
    pendingPropImageIds.value = [...new Set([...pendingPropImageIds.value, ...ids])]
    // ★ Sprint 24 fix_1 (PM msg-20261026-104): 之前只在【请求返回时】刷新一次, 没有任何轮询
    //   → pendingPropImageIds 永远清不掉 → 卡片一直显示"生成中…" (后端其实早就生成好了,
    //   实测 6/6 全部成功, 用户刷新一下就好了)。
    //   其他三个批量入口都有轮询 (batchCharImages → pollBatchImageGeneration;
    //   batchSceneImages / genPropImg → watchAsyncResult), 只有这里漏了。
    //
    //   道具表【没有 status 字段】(不像 scene / storyboard), 失败状态只能从 image_generations 记录看
    //   → 用 imageAPI.get(genId) 判终态 (跟 batchCharImages 同款), 成功/失败都能退出轮询。
    const genIds: (number | null)[] = []
    ids.forEach((id, idx) => {
      propsAPI.generateImage(id, ctx.epId.value, imageConfigIdRef?.value)
        .then((resp: any) => { genIds[idx] = resp?.image_generation_id || null })
        .catch((e: any) => {
          pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
          toast.error(e.message)
        })
    })
    toast.success('道具图片批量生成中')
    // 轮询: 每个 tick 一次 Promise.all 拿全部状态 (30 次 × 8s = 4 分钟)
    for (let i = 0; i < 30; i++) {
      await sleep(8000)
      try {
        const results = await Promise.all(
          ids.map((_, j) => (genIds[j] ? imageAPI.get(genIds[j] as number).catch(() => null) : Promise.resolve(null)))
        )
        let stillPending = 0
        let failedCount = 0
        for (let j = 0; j < ids.length; j++) {
          // 已经出过终态的 (成功 / 请求直接失败) 不用再看
          if (!pendingPropImageIds.value.includes(ids[j])) continue
          const res = results[j]
          if (res?.status === 'completed' || res?.status === 'succeeded') {
            pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== ids[j])
          } else if (res?.status === 'failed') {
            pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== ids[j])
            failedCount++
          } else {
            stillPending++
          }
        }
        if (stillPending === 0) {
          await refresh()
          if (failedCount > 0) toast.error(`${failedCount} 个道具图片生成失败`)
          else toast.success('所有道具图片生成完成')
          return
        }
        await refresh()
      } catch {}
    }
    // 超时: 清理所有未完成的
    pendingPropImageIds.value = pendingPropImageIds.value.filter(item => !ids.includes(item))
    toast.error('部分道具图片生成超时')
  }

  /**
   * ★ Sprint 28 Task B (PM msg-20261028-128): 等上一镜的末帧就绪 (接力依赖)。
   *
   * 首尾帧是【逐镜点击】生成的 (没有批量按钮) → 上一镜的末帧有三种状态:
   *   ① 已经生成好        → 直接接力 (Task A 的 buildShotReferenceAssets 会取到)
   *   ② 正在生成中        → 等它完成再接力本镜 (用户刚点了它的尾帧但还没出)
   *   ③ 根本没生成        → 等也没用 (它不会自己出现) → 立即降级不接力 + 明确提示
   *
   * 等待只发生在【本镜】内部, 不阻塞别的镜头 (每个镜头各自等自己的上一镜)。
   */
  async function waitPrevShotLastFrame(sb: any): Promise<boolean> {
    const prev = findPrevShot(sb)
    if (!prev) return false
    if (prev.last_frame_image || prev.lastFrameImage) return true
    const prevNum = Number(prev.storyboard_number ?? prev.storyboardNumber ?? 0)
    // ② 上一镜的末帧正在生成 → 等它 (最多 100 次 × 3s = 5 分钟, 与生图轮询同量级)
    if (isPendingShotFrame(prev.id, 'last_frame')) {
      toast.info(`正在等待上一镜#${prevNum}的尾帧, 以保证镜头衔接...`)
      await watchAsyncResult(() => {
        const cur = ctx.sbs.value.find(s => s.id === prev.id)
        return !!(cur?.last_frame_image || cur?.lastFrameImage)
      }, 100, 3000)
      const cur = ctx.sbs.value.find(s => s.id === prev.id)
      if (cur?.last_frame_image || cur?.lastFrameImage) return true
      toast.warning(`上一镜#${prevNum}的尾帧还没生成好, 本镜无法接力`)
      return false
    }
    // ③ 根本没生成 → 立即降级 + 提示 (等下去没意义)
    toast.warning(`上一镜#${prevNum}还没有尾帧, 本镜无法接力 —— 建议先生成它的尾帧, 再生成本镜首帧`)
    return false
  }

  async function genShotFrame(sb: any, frameType: string) {
    const key = framePendingKey(sb.id, frameType)
    try {
      // 先标记 pending, 再等接力 —— 等待期间 UI 也显示"生成中", 不会出现点了没反应
      if (!pendingShotFrameKeys.value.includes(key)) pendingShotFrameKeys.value.push(key)
      // ★ Sprint 28 Task B: 生成首帧前先确保上一镜的末帧就绪 (接力依赖)
      if (frameType === 'first_frame') {
        await waitPrevShotLastFrame(sb)
      }
      const prompt = buildShotImagePrompt(sb, frameType)
      // 重新生成 first_frame 时不引用旧 first_frame (避免 LLM 复制旧图错误)
      const shotAssets = buildShotReferenceAssets(sb, frameType === 'first_frame')
      const referenceImages = shotAssets.map(a => a.path)
      // ★ Sprint 28 Task A: 记录本次用了哪张接力图 (详细清单在 flow-log 的 ImageTask/reference-images 里)
      const relay = shotAssets.find(a => a.kind === 'prev_shot')
      if (relay) {
        console.info('[shot-relay] 使用上一镜末帧作参考', {
          storyboardId: sb?.id, frameType,
          prevShotNumber: relay.prevShotNumber,
          referenceIndex: relay.index,
          referencePath: relay.path,
        })
      } else {
        console.info('[shot-relay] 本镜没有接力参考 (上一镜末帧尚未生成)', {
          storyboardId: sb?.id, frameType,
        })
      }
      const body: Record<string, any> = {
        storyboard_id: sb.id,
        drama_id: ctx.dramaId,
        prompt,
        frame_type: frameType,
        reference_images: (referenceImages?.length ?? 0) > 0 ? referenceImages : undefined,
      }
      // config_id 走复合格式 '<id>:<model>': 后端 parseConfigIdWithModel 拆开
      if (imageConfigIdRef?.value != null) body.config_id = imageConfigIdRef.value
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
    pendingCharImageIds, pendingSceneImageIds, pendingPropImageIds, pendingShotFrameKeys,
    isPendingCharImage, isPendingSceneImage, isPendingPropImage, isPendingShotFrame, framePendingKey,
    genCharImg, batchCharImages, genSceneImg, batchSceneImages, genPropImg, batchPropImages, genShotFrame,
    buildShotReferenceAssets, getShotReferenceImages, buildShotImagePrompt,
  }
}

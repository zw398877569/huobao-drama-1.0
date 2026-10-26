import { db, schema } from '../db/index.js'
import { eq, and, asc, inArray } from 'drizzle-orm'
import { getActiveConfig, getConfigById, translateVideoPromptToEnglish, hasNonEnglishChars } from './ai.js'
// Sprint 15 (PM msg-20261020-075): 台词时间轴 —— 拼进 video_prompt 的描述段, 让 H3 知道谁在什么时候说什么
import { buildDialogueTimeline, formatDialogueTimeline, injectDialogueTimeline, countDialogueMarkers, stripLegacyUntimedDialogueBlock, H3_PROMPT_MAX_CHARS } from '../utils/dialogue-timeline.js'
// Sprint 17 (PM msg-20261021-076) Task B/E: 首帧锚点 (英文固定句, 翻译后注入) + 代码层清洗
import { insertAtIntegratedStart } from '../utils/storyboard-rules.js'
import { checkSceneOpensWithWideShot } from '../utils/prompt-cleanup.js'
// Sprint 19 (PM msg-20261025-082): 生成期的注入/清洗走模板 —— Sprint 20 的 H3 模板要在这里
//   关掉 general 的注入 (台词时间轴 + 首帧锚点 + 清洗), 通用逻辑不用动
import { getEpisodeTemplate } from '../prompt-templates/index.js'
// Sprint 23 Task C: 翻译前把 <d>...</d> 对白块脱敏 (保险: 正常路径上对白是翻译后注入的, 这里只防 LLM 自己乱加)
import { maskDialogueBlocks } from '../utils/dialogue-mask.js'
import { now } from '../utils/response.js'
import { downloadFile } from '../utils/storage.js'
import { getVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl, truncateForLog } from '../utils/task-logger.js'
import { sanitizeImagePromptAggressive } from '../utils/prompt-sanitizer.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

/**
 * 2026-10-12 sprint 43 FIX-8-AUTOLOAD (QA msg-20261012-047):
 *   自动从 image_generations 表读 sb 的最新 first_frame 记录 (status=completed, frame_type=first_frame),
 *   写回 params.firstFrameUrl. 跳过条件: 用户已经传了 firstFrameUrl/imageUrl/referenceImageUrls 任一.
 *   跟 sprint 43 FIX-8 改的 autodl-comfyui-workflow.ts:235 路由判断兼容 (有 firstFrameUrl → 自动走 FL2V, 非 no_pic).
 *   source of truth 是 image_generations (disk 上有图就有记录), 不依赖 storyboards.first_frame_image 字段 update.
 */
function autoLoadFirstFrame(params: GenerateVideoParams): void {
  if (params.firstFrameUrl || params.imageUrl || (params.referenceImageUrls && params.referenceImageUrls.length)) {
    return  // 用户已传, 不覆盖
  }
  if (!params.storyboardId) return  // 自由创作模式没 storyboardId, 跳过
  const rows = db.select({
    id: schema.imageGenerations.id,
    localPath: schema.imageGenerations.localPath,
  }).from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.storyboardId, params.storyboardId))
    .all()
    .filter((r: any) => r.localPath && r.frameType === 'first_frame' && r.status === 'completed')
  if (rows.length === 0) {
    logTaskProgress('VideoAPI', 'no-first-frame-using-text-only', { storyboardId: params.storyboardId })
    return
  }
  const best = rows.sort((a, b) => b.id - a.id)[0]
  params.firstFrameUrl = best.localPath
  logTaskProgress('VideoAPI', 'auto-loaded-first-frame', {
    storyboardId: params.storyboardId,
    imageGenId: best.id,
    localPath: best.localPath,
    source: 'image_generations (sprint 43 FIX-8-AUTOLOAD)',
  })
}

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  /** 'storyboard' (默认) = 正式分镜流, 'free' = 自由创作 tab 生成 */
  source?: 'storyboard' | 'free'
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  duration?: number
  aspectRatio?: string
  configId?: number
  negativePrompt?: string
  seed?: number
  /** traceId 从 middleware 透传到此处, 用于 file-log 写入 logs/flow-${traceId}.jsonl; 不入 DB */
  traceId?: string
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')

  // 2026-10-12 sprint 43 FIX-8-AUTOLOAD (QA msg-20261012-047): 后端防御性从 image_generations 表读首帧图
  //   解决 storyboards.first_frame_image 字段不可靠 (image-generation.ts:471 sync update 有时没生效) 的问题
  //   即使前端没传 first_frame_url / image_url / referenceImageUrls, 也能从 image_generations (disk source of truth) 自动填
  autoLoadFirstFrame(params)

  // traceId 全链路日志入口 — 串通前端 x-trace-id header 到 logs/flow-{traceId}.jsonl
  // pollVideoTask / webhook 链不动 (PM 拍板), 只打这一行作为这次 generate 调用的入口标记
  logTaskStart('VideoAPI', 'generate-request', {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    provider: config.provider,
    model: params.model || config.model,
    duration: params.duration,
    referenceMode: params.referenceMode || 'none',
    refImageCount: params.referenceImageUrls?.length ?? 0,
  }, {
    traceId: params.traceId,
    dramaId: params.dramaId,
    storyboardId: params.storyboardId,
  })

  const isFree = (params.source || 'storyboard') === 'free'

  // Sprint 045 QA msg-20261016-068 Bug-C: 应用层 dramaId 缺失告警
  //   修前: db/schema.ts:312 dramaId: integer('drama_id') 无 notNull 约束, 写 null 完全静默,
  //         158 条历史里 80 条 (50.6%) null 长期没人发现 (drama 归属追溯不到)。
  //   修后: 【不加 notNull 约束】—— 自由创作 (source='free') 天然没有 dramaId
  //         (FreeCreationPanel.vue 不传 storyboard_id / drama_id, 脱离剧集独立创作),
  //         加约束会让每次自由创作 INSERT 失败, 整个 tab 报错。
  //         改在应用层: 正式分镜流缺 dramaId 时记 warn (flow-log 可查), 不 throw 打断生成。
  //   未来若 free creation 也纳入剧集体系, 再考虑加约束 (届时 free 需补 drama 归属)。
  if (!isFree && params.dramaId == null) {
    logTaskWarn('VideoAPI', 'drama-id-missing', {
      storyboardId: params.storyboardId,
      source: params.source || 'storyboard',
      hint: '正式分镜流缺 dramaId, video_generations.drama_id 将写 null 影响剧集追溯; ' +
            '调用方应传 drama_id 或确保 storyboard 链路可反查到 episode',
    })
  }

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    source: params.source || 'storyboard',
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    referenceMode: params.referenceMode || 'none',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    negativePrompt: params.negativePrompt || null,
    seed: params.seed || null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('VideoTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    source: params.source || 'storyboard',
    referenceMode: params.referenceMode || 'none',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processVideoGeneration(lastId, config, params.source || 'storyboard').catch(err => {
    logTaskError('VideoTask', 'process', { id: lastId, error: err.message })
    console.error(`Video generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processVideoGeneration(id: number, config: AIConfig, source: 'storyboard' | 'free' = 'storyboard') {
  const isFree = source === 'free'
  const adapter = getVideoAdapter(config.provider)

  try {
    let retryCount = 0
    const MAX_RETRIES = 3

    for (let attempt = 0; attempt < MAX_RETRIES || (attempt === MAX_RETRIES && retryCount === 0); attempt++) {
      const isAggressiveRetry = attempt === MAX_RETRIES && retryCount === 0
      if (isAggressiveRetry) {
        logTaskWarn('VideoTask', 'policy-violation-retry', { id, attempt: 1 })
      }

      try {
        const vRows = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
        const vRecord = vRows[0]
        if (!vRecord) return
        logTaskProgress('VideoTask', 'build-request', {
          id,
          provider: config.provider,
          storyboardId: vRecord.storyboardId,
          referenceMode: vRecord.referenceMode,
        })

        const resolvedImageUrl = await normalizeVideoReferenceUrl(vRecord.id, vRecord.imageUrl)
        const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(vRecord.id, vRecord.firstFrameUrl)
        const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(vRecord.id, vRecord.lastFrameUrl)
        const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(vRecord.referenceImageUrls)
        // Sprint 14: 配音音频 (口型同步)。自由创作 (source='free') 没 storyboard, 天然拿不到。
        const resolvedAudioUrls = await resolveStoryboardAudioUrls(vRecord.id, vRecord.storyboardId)
        // Sprint 19: 本镜用哪个 prompt 模板 (按 episodes.prompt_template)
        const storyboardEpisodeId = vRecord.storyboardId
          ? (db.select({ episodeId: schema.storyboards.episodeId })
            .from(schema.storyboards).where(eq(schema.storyboards.id, vRecord.storyboardId)).all()[0]?.episodeId ?? null)
          : null
        const tpl = getEpisodeTemplate(storyboardEpisodeId)

        // 翻译决策仍然只看【原始】prompt —— 台词时间轴是中文的, 如果拿注入后的文本去判断,
        // 会把「本来是纯英文的 prompt」也拖进翻译, 属于本单不该引入的行为变化。
        const shouldTranslate = !isFree && hasNonEnglishChars(vRecord.prompt || '')
        // 翻译前先记一下原文的中文字数, 翻译后用来判断「到底翻没翻」
        const chineseBefore = countChineseChars(vRecord.prompt || '')

        // Sprint 16 (PM msg-20261020-072) A2 合并版: 台词时间轴挪到【翻译之前】注入。
        //   为什么挪: 这一步之后本来就有一次 LLM 调用 (提示词翻译, 实测 13s), 而「翻译」本质就是
        //   改写 prompt —— 让同一次调用顺手把「描述里的角色动作」跟「说话时间轴」对齐,
        //   等于白捡一次对齐, 不额外花 LLM 调用 (独立做要再 +13s/镜)。
        //   Sprint 15 选「翻译后注入」是为了保护时间码不被翻译器改, 现在改用:
        //     翻译 system prompt 里显式要求保留时间码 + 做对齐
        //     + 翻译后校验 开口: 数量, 对不上就 warn 并降级补注 (见下面)
        let promptWithTimeline = vRecord.prompt || ''
        let timelineText = ''
        let dialogueMarkersBefore = 0
        // Sprint 19: 台词时间轴由模板控制 (general = 开, 行为不变)。
        //   Sprint 20 的 H3 模板必须关掉 —— 官方用 <d>[Chinese]…</d>, 两套对白标记同时给 H3 会冲突。
        const useDialogueTimeline = tpl.generation.useDialogueTimeline
        try {
          if (!useDialogueTimeline) {
            logTaskProgress('VideoTask', 'dialogue-timeline-skipped-by-template', {
              id,
              storyboardId: vRecord.storyboardId,
              templateId: tpl.id,
              hint: '该模板不使用台词时间轴 (generation.useDialogueTimeline=false)',
            })
          }
          const timeline = useDialogueTimeline
            ? await buildStoryboardDialogueTimeline(vRecord.id, vRecord.storyboardId, vRecord.duration)
            : { text: '', count: 0, totalSec: 0, skippedCount: 0, filteredCount: 0, truncatedCount: 0 }
          logTaskProgress('VideoTask', 'dialogue-timeline', {
            id,
            storyboardId: vRecord.storyboardId,
            segments: timeline.count,
            totalSec: timeline.totalSec,
            skipped: timeline.skippedCount,
            filtered: timeline.filteredCount,
            truncated: timeline.truncatedCount,
            injected: !!timeline.text,
          })

          if (timeline.text) {
            // Sprint 15 Task D (PM 拍板只报告不自动改 duration):
            //   台词比视频长时 H3 只能截断, 后半句说不完。让用户知道哪些镜头有这个问题。
            const videoSec = Number(vRecord.duration || 0)
            if (videoSec > 0 && timeline.totalSec > videoSec) {
              logTaskWarn('VideoTask', 'dialogue-exceeds-duration', {
                id,
                storyboardId: vRecord.storyboardId,
                audioSec: timeline.totalSec,
                videoSec,
                overflowSec: Math.round((timeline.totalSec - videoSec) * 10) / 10,
                hint: '台词比视频长, 后半句可能说不完或被截断 (PM 拍板不自动改 duration, 需人工调该镜时长; 时间轴已按 duration 截断)',
              })
            }
            timelineText = timeline.text
            promptWithTimeline = injectDialogueTimeline(promptWithTimeline, timelineText)

            // Sprint 16 QA msg-20261021-074: prompt 里可能已经有【未分时间】的旧台词块
            //   (sprint-16-b 的 embedDialogueInline 写进 storyboards.video_prompt 的,
            //    形如 开口:'王秀兰：“吃点吧，趁热。” 林达：“不用了，我不饿。”')。
            //   现在又注入了带时间轴的台词段 → 两套台词并存, 带 ref_audio_0 时 H3 会把
            //   未分时间那套也当台词念出来, 结果把角色名前缀「林达：」直接念出去 (实测 id=182)。
            //   这里把旧的未分时间块删掉, 只留带时间轴的 (它是唯一带真实时序的)。
            //   ⚠️ 只在【刚注入了时间轴】时才删 —— 没有 TTS 的镜头只有那一块台词来源,
            //      删了就等于台词全没了, H3 更不知道该说什么。
            const stripped = stripLegacyUntimedDialogueBlock(promptWithTimeline)
            if (stripped.removed > 0) {
              logTaskWarn('VideoTask', 'legacy-untimed-dialogue-stripped', {
                id,
                storyboardId: vRecord.storyboardId,
                removed: stripped.removed,
                kept: stripped.kept,
                hint: 'prompt 里有未分时间的旧台词块, 已删 (只保留带时间轴的), 否则 H3 会把角色名前缀当台词念出来',
              })
              promptWithTimeline = stripped.text
            }

            dialogueMarkersBefore = countDialogueMarkers(promptWithTimeline)
          }
        } catch (err: any) {
          logTaskWarn('VideoTask', 'dialogue-timeline-failed', {
            id,
            storyboardId: vRecord.storyboardId,
            error: err.message,
            hint: '台词时间轴拼装失败, 本次不带台词生成 (视频照常出, 只是口型可能对不上)',
          })
        }

        // 提示词翻译 + (Sprint 16) 描述/时间轴对齐, 一次 LLM 调用完成
        // 自由创作模式跳过翻译 — 用户自己控制中英文, 不要静默改写原文
        let finalPrompt: string = promptWithTimeline
        if (shouldTranslate) {
          try {
            logTaskProgress('VideoTask', 'translating-prompt', { id, original: truncateForLog(promptWithTimeline) })
            // Sprint 23 Task C: <d> 对白块脱敏-还原 (PM 决策 1)。
            //   H3 模板的对白是【翻译之后】由代码层注入的, 正常路径这里没有 <d> 块;
            //   这层是保险 —— 防 LLM 自己在 detailed_description 里乱加 <d>[Chinese]…</d> 被翻掉。
            const dMask = maskDialogueBlocks(promptWithTimeline)
            finalPrompt = await translateVideoPromptToEnglish(dMask.text)
            finalPrompt = dMask.restore(finalPrompt)
            // Sprint 16: 校验翻译器有没有把台词整段吃掉。吃掉了 prompt 会静默变回「没有台词」,
            //   口型又对不上且零报错 —— 所以必须数一遍, 对不上就 warn 并把中文时间轴补回去。
            if (dialogueMarkersBefore > 0 && countDialogueMarkers(finalPrompt) < dialogueMarkersBefore) {
              logTaskWarn('VideoTask', 'dialogue-timeline-lost-in-translation', {
                id,
                storyboardId: vRecord.storyboardId,
                before: dialogueMarkersBefore,
                after: countDialogueMarkers(finalPrompt),
                hint: '翻译后台词标记变少, 已把中文时间轴补回; 本镜描述未跟时间轴对齐 (对齐要靠翻译器, 这次没成功)',
              })
              finalPrompt = injectDialogueTimeline(finalPrompt, timelineText)
            }
            // Sprint 16 QA msg-20261021-073: 翻译/对齐失败时, 之前只有 PromptTranslation scope 的
            //   WARN 能看出来, video 自己的日志里完全看不出「这次没翻译」→ 对齐没跑 → 错角色说台词。
            //   这里补一条 VideoTask 层的信号: 原文的中文基本还在 (只扣掉时间轴贡献的中文),
            //   就说明翻译没成功。跟 dialogue-timeline-lost-in-translation 一起 grep 就能定位。
            const chineseLeft = countChineseChars(finalPrompt) - countChineseChars(timelineText)
            if (chineseBefore > 0 && chineseLeft > chineseBefore * 0.3) {
              logTaskWarn('VideoTask', 'translation-fallback-untranslated', {
                id,
                storyboardId: vRecord.storyboardId,
                chineseBefore,
                chineseLeft,
                hint: '翻译/对齐没跑成 (超时或失败), prompt 仍是中文 —— integrated 描述跟时间轴的冲突没被修正, 本镜可能还是错角色说台词',
              })
            }
            logTaskProgress('VideoTask', 'translated-prompt', { id, translated: truncateForLog(finalPrompt) })
          } catch (err: any) {
            logTaskWarn('VideoTask', 'translation-failed', { id, error: err.message })
            // translation failure is non-fatal, use original prompt (此时 promptWithTimeline 已含中文时间轴)
          }
        }

        // ── Sprint 17 Task E④: 场景第一镜必须交代地点 (老路径 二 镜头顺序铁律) ──
        //   只 warn 不强制改 —— 强制改会跟 LLM 的整体设计冲突 (PM Task E 明确要求)。
        checkSceneOpeningWideShot(vRecord.storyboardId)

        // ── Sprint 17 Task E①②③: 代码层清洗 (抽象形容词 / 后期拼接指令 / IP 品牌) ──
        //   老路径 agents/index.ts:646-649 的三条硬性约束, V4 重构后没有任何代码兜底。
        //   必须跑在【所有注入之后】(注入的内容也是 prompt 的一部分);
        //   台词区 (开口:'...') 内部受保护 —— 台词里出现"切黑"是台词内容, 不是拼接指令。
        const cleanup = tpl.generation.cleanup({ prompt: finalPrompt })
        if (cleanup.removedAbstract.length > 0 || cleanup.removedTransition.length > 0) {
          logTaskWarn('VideoTask', 'prompt-cleanup', {
            id,
            storyboardId: vRecord.storyboardId,
            removedAbstract: cleanup.removedAbstract,
            removedTransition: cleanup.removedTransition,
            hint: '老路径硬性约束: 抽象形容词 + 后期拼接指令已从最终 prompt 清掉 (对 H3 没有信息量 / 转场归拼接阶段)',
          })
        }
        if (cleanup.ipHits.length > 0) {
          logTaskWarn('VideoTask', 'ip-brand-detected', {
            id,
            storyboardId: vRecord.storyboardId,
            ipHits: cleanup.ipHits,
            hint: 'prompt 里出现 IP/品牌词 —— 只告警不自动改写 (词表永远不全, 乱改会误伤正常内容), 需人工确认',
          })
        }
        finalPrompt = cleanup.prompt

        const { url, method, headers, body, fallbackReason } = adapter.buildGenerateRequest(config, {
          id: vRecord.id,
          model: vRecord.model,
          prompt: finalPrompt,
          negativePrompt: vRecord.negativePrompt || null,
          seed: vRecord.seed || null,
          referenceMode: vRecord.referenceMode,
          imageUrl: resolvedImageUrl,
          firstFrameUrl: resolvedFirstFrameUrl,
          lastFrameUrl: resolvedLastFrameUrl,
          referenceImageUrls: resolvedReferenceImageUrls ? JSON.stringify(resolvedReferenceImageUrls) : null,
          audioUrls: resolvedAudioUrls,
          duration: vRecord.duration,
          aspectRatio: vRecord.aspectRatio,
        })
        // ── Sprint 17 Task B: 首帧延续锚点 (老路径 四.2) ──
        //   "opening frame matches [Picture 1]; continues from previous shot's tail composition"
        //   ⚠️ 必须在【翻译之后】注入 —— 这句是英文固定句, 翻译器会把它改写掉 (Sprint 15 同类坑)。
        //   ⚠️ [Picture 1] 只在 Ref2V 模式成立 (平台收 ref_image_0); FL2V 走 first_frame 字段,
        //      没有 Picture 编号 —— 所以必须等 buildGenerateRequest 出来才知道平台实际收的是哪种图。
        if (body && typeof body.prompt === 'string' && body.prompt) {
          const hasRefImage0 = typeof body.ref_image_0 === 'string' && !!body.ref_image_0
          const hasFirstFrameField = typeof body.first_frame === 'string' && !!body.first_frame
          const referenceImageMode = hasRefImage0
            ? 'ref2v-picture-1'
            : (hasFirstFrameField ? 'fl2v-first-frame' : 'none')
          const injectCtx = await resolveGenerationInjectContext(vRecord.storyboardId, storyboardEpisodeId)
          const anchor = tpl.generation.inject({
            prompt: body.prompt,
            referenceImageMode,
            storyboardId: vRecord.storyboardId,
            episodeId: storyboardEpisodeId,
            ttsSegments: injectCtx.ttsSegments,
            characters: injectCtx.characters,
            previousResult: injectCtx.previousResult,
          })
          const anchorMode = referenceImageMode
          if (anchor) {
            body.prompt = insertAtIntegratedStart(body.prompt, anchor)
            finalPrompt = body.prompt
            logTaskProgress('VideoTask', 'opening-frame-anchor', {
              id,
              storyboardId: vRecord.storyboardId,
              mode: anchorMode,
              hint: '老路径 四.2 首帧延续 —— 平台收到参考图时, 明确指定它就是开场帧的构图起点',
            })
          }
        }

        if (finalPrompt.length > H3_PROMPT_MAX_CHARS) {
          logTaskWarn('VideoTask', 'prompt-exceeds-h3-limit', {
            id,
            storyboardId: vRecord.storyboardId,
            chars: finalPrompt.length,
            limit: H3_PROMPT_MAX_CHARS,
            hint: '加了台词后超过 H3 prompt 上限, 平台可能截断; 考虑拆短该镜台词',
          })
        }

        // Sprint 14: adapter 换过 workflow 时把原因码落库。
        //   必须落库的原因: video_generations.model 存的是「用户选的」model, 实际跑的 workflowId 只在
        //   adapter 的 url 里, 不记这一笔的话前端/DB 都看不出「我选了 zm_u08 却没做口型同步」。
        if (fallbackReason) {
          db.update(schema.videoGenerations)
            .set({ fallbackReason, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id))
            .run()
          logTaskWarn('VideoTask', 'fallback-recorded', {
            id,
            storyboardId: vRecord.storyboardId,
            requestedModel: vRecord.model,
            reason: fallbackReason,
          })
        }

        logTaskProgress('VideoTask', 'request', {
          id,
          provider: config.provider,
          method,
          url: redactUrl(url),
          model: vRecord.model,
          referenceMode: vRecord.referenceMode,
          // Sprint 14: 实际发出的 ref_image / ref_audio 数量, 排查「音频没生效」时第一眼看这里
          refImageCount: resolvedReferenceImageUrls.length,
          audioCount: resolvedAudioUrls.length,
          fallbackReason: fallbackReason || null,
          // Sprint 15: 最终 prompt 原样落 flow-log。
          //   translated-prompt 那条日志打在【注入台词之前】, 光看它看不到台词时间轴,
          //   而「prompt 里到底有没有台词+时间轴」正好是本单的验收点 —— 没有这条没法验。
          //   truncateForLog 上限 200KB, prompt 上限 10000 字符, 不会被截。
          prompt: truncateForLog(finalPrompt),
        })
        logTaskPayload('VideoTask', 'request payload', {
          id,
          method,
          url,
          headers,
          body,
        })

        const resp = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        })

        if (resp.ok) {
          const result = await resp.json() as any
          logTaskPayload('VideoTask', 'response payload', result)
          const { isAsync, taskId, videoId: videoIdFromAdapter, videoUrl } = adapter.parseGenerateResponse(result)

          if (!isAsync && videoUrl) {
            logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
            await handleVideoComplete(id, videoUrl, vRecord.duration)
            return
          }

          db.update(schema.videoGenerations)
            .set({ taskId, status: 'processing', updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id))
            .run()
          logTaskProgress('VideoTask', 'poll-start', { id, taskId, videoId: videoIdFromAdapter, provider: config.provider })

          if (adapter.provider === 'vidu') {
            logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
            return
          }

          pollVideoTask(id, config, videoIdFromAdapter || taskId!, taskId!, vRecord.storyboardId)
          return
        }

        // 非 2xx 响应
        const errText = await resp.text().catch(() => '')
        const isPolicyViolation = resp.status === 400 && errText.includes('content_policy_violation')

        if (isPolicyViolation) {
          if (retryCount === 0 && !isFree) {
            retryCount++
            const originalPrompt: string = vRecord.prompt || ''
            const aggressivePrompt = sanitizeImagePromptAggressive(originalPrompt)
            logTaskWarn('VideoTask', 'policy-violation-retrying-with-aggressive', {
              id,
              originalPreview: originalPrompt.slice(0, 80),
              aggressivePreview: aggressivePrompt.slice(0, 80),
            })
            db.update(schema.videoGenerations)
              .set({ prompt: aggressivePrompt, updatedAt: now() })
              .where(eq(schema.videoGenerations.id, id))
              .run()
            continue
          }
          // 自由创作模式不重写, 直接失败让用户看到原始错误
          if (isFree) {
            logTaskWarn('VideoTask', 'policy-violation-no-rewrite-in-free-mode', { id, status: resp.status })
          }
          throw new Error(`API error ${resp.status}: ${errText}`)
        }

        const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
        if (!TRANSIENT_STATUS.has(resp.status)) {
          throw new Error(`API error ${resp.status}: ${errText}`)
        }

        logTaskWarn('VideoTask', 'transient-error-retry', {
          id,
          attempt: attempt + 1,
          status: resp.status,
          body: errText.slice(0, 240),
        })
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      } catch (err: any) {
        const lastErrText = err?.message || String(err)
        logTaskWarn('VideoTask', 'fetch-network-retry', { id, attempt: attempt + 1, error: lastErrText })
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
          continue
        }
        throw err
      }
    }
  } catch (err: any) {
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: err.message })
    // processVideoGeneration 没有 storyboardId 入参，从 DB 查一次
    const [vRecord] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    db.update(schema.videoGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    markStoryboardFailed(vRecord?.storyboardId, err.message)
  }
}

// 统一失败回写：当 video_generation 标记 failed 时，同步回写关联 storyboard 表，
// 让前端 watchAsyncResult 能正确识别终态并停止轮询。
// video_generations 只关联 storyboard（无 scene/character 关联），所以直接传 storyboardId。
function markStoryboardFailed(storyboardId: number | null | undefined, errorMsg: string) {
  if (!storyboardId) return
  const ts = now()
  db.update(schema.storyboards)
    .set({ status: 'failed', updatedAt: ts })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()
  logTaskProgress('VideoTask', 'failed-backfill-storyboard', { storyboardId })
}

/**
 * 归一化视频生成用到的参考素材 URL (参考图 / 配音音频)。
 *
 * kind 只影响两件事: 读本地文件时的 mime 兜底 + 失败日志的事件名 ——
 * 业务上音频走 ref_audio_* 而不是 ref_image_*，但 URL 归一化逻辑完全一样。
 */
async function normalizeVideoReferenceUrl(
  vRecordId: number,
  value: string | null | undefined,
  kind: 'image' | 'audio' = 'image',
): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:')) {
    // 已经是 base64，直接返回（适配器需要处理是否接受）
    return raw
  }
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    // 本地静态文件 → 转为公网 URL 或 base64
    // STORAGE_ROOT 已包含 "static"，需要去掉路径中的 "static/" 前缀
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    const relativePath = localPath.startsWith('static/') ? localPath.slice(7) : localPath
    const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`
    const filePath = path.join(STORAGE_ROOT, cleanPath)

    // 有公网存储地址 → 用公网 URL
    const storageBaseUrl = process.env.STORAGE_BASE_URL
    if (storageBaseUrl && fs.existsSync(filePath)) {
      return `${storageBaseUrl}${cleanPath}`
    }

    // 没有公网地址 → 读本地文件为 base64 传给 Agnes
    try {
      const buffer = fs.readFileSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      // Sprint 14: 音频扩展名映射 (ref_audio_* 支持 MP3/WAV/MP4/FLAC)。
      //   改前只有图片 mime, 音频会被兜底标成 image/png → 平台按图片解音频直接失败。
      const mimeType = AUDIO_MIME_BY_EXT[ext] ?? IMAGE_MIME_BY_EXT[ext] ?? (kind === 'audio' ? 'audio/mpeg' : 'image/png')
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch (err: any) {
      logTaskWarn('VideoTask', kind === 'audio' ? 'read-local-audio-failed' : 'read-local-image-failed', {
        videoGenId: vRecordId,
        filePath,
        error: err.message,
      })
    }
    return null
  }
  return raw
}

/** 图片扩展名 → mime (原有逻辑抽成常量, Sprint 14 只是加了 AUDIO_MIME_BY_EXT) */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Sprint 14 (PM msg-20261019-074): 音频扩展名 → mime。
 * 平台 ref_audio_* 文档写明支持 MP3/WAV/MP4/FLAC; .m4a 也按 audio/mp4 处理。
 */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
}

/**
 * Sprint 14: 取本镜配音音频, 归一化成 adapter 能直接用的 URL。
 *
 * 真源是 storyboards.tts_audio_url (配好音后 storyboards.ts 写入, 格式 static/audio/tts_<sbId>_<ts>.mp3),
 * 不接受前端传参 —— 前端说什么不算数, 避免刷脏数据。
 *
 * 一次只取整段合并音频 (tts_concat 产物), 不拆 tts_segments 分段:
 *   H3 一次最多吃 3 段 ref_audio, 而本项目一镜的配音本来就是「一镜一段」,
 *   拆开反而会让平台按多说话人对齐, 跟 ffmpeg-compose 阶段的混音逻辑对不上。
 * 配套注意: zm_u08/u24 生成的视频可能自带口型音轨, 合成阶段要防重复混音 (见 handoff)。
 */
async function resolveStoryboardAudioUrls(
  vRecordId: number,
  storyboardId: number | null | undefined,
): Promise<string[]> {
  if (!storyboardId) return []
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  const raw = sb?.ttsAudioUrl
  if (!raw) return []
  const normalized = await normalizeVideoReferenceUrl(vRecordId, raw, 'audio')
  return normalized ? [normalized] : []
}

/** 数中文字符个数 —— 用来判断 prompt 到底翻没翻 (翻译 fallback 时 prompt 还是中文) */
function countChineseChars(text: string): number {
  const m = String(text || '').match(/[\u4e00-\u9fff]/g)
  return m ? m.length : 0
}

/**
 * Sprint 15: 取本镜台词时间轴, 并格式化成能直接注入 prompt 的字符串。
 *
 * 跟 resolveStoryboardAudioUrls 分开而不是合并 —— 两者读的是同一行 storyboards,
 * 但一个产出 URL (Sprint 14 给 ref_audio_0) 一个产出文本 (Sprint 15 拼 prompt),
 * 拆开各自好测也好改。视频生成本身要跑几分钟, 多一次主键查询无所谓。
 *
 * 没配音 / 没拆段 / 解析失败 → 全部返回空, 调用方一个字都不加, 行为跟 Sprint 14 之前完全一致。
 */
async function buildStoryboardDialogueTimeline(
  vRecordId: number,
  storyboardId: number | null | undefined,
  videoDuration?: number | null,
): Promise<{ text: string; count: number; totalSec: number; skippedCount: number; filteredCount: number; truncatedCount: number }> {
  const empty = { text: '', count: 0, totalSec: 0, skippedCount: 0, filteredCount: 0, truncatedCount: 0 }
  if (!storyboardId) return empty
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.ttsSegments) return empty
  // videoDuration 传进去是为了让时间码不超出画面时长 (Sprint 16) —— prompt 写到 9.7s 而
  // H3 只生成 9s 画面, 多出来的时间码没有意义。totalSec 仍报真实音频总时长, overflow 告警靠它。
  const result = await buildDialogueTimeline(sb.ttsSegments, storyboardId, videoDuration)
  return {
    text: formatDialogueTimeline(result.items),
    count: result.items.length,
    totalSec: result.totalSec,
    skippedCount: result.skippedCount,
    filteredCount: result.filteredCount,
    truncatedCount: result.truncatedCount,
  }
}

/**
 * Sprint 23 Task C: 取生成期注入需要的上下文 —— 本镜的配音分段 + 本 episode 的角色表。
 *
 * 角色表按 characters.id 升序 —— 这个顺序就是 <Subject N> / (Sx) 的编号顺序
 * (PM 决策: episode 内角色的固定序号, 跨镜跨集都不换)。
 */
async function resolveGenerationInjectContext(
  storyboardId: number | null | undefined,
  episodeId: number | null | undefined,
): Promise<{
  ttsSegments: Array<{ speaker?: string; text?: string; isNarrator?: boolean; voice?: string }> | null
  characters: Array<{ id: number; name: string; appearancePermanent?: string; personality?: string; role?: string }> | null
  previousResult: string | null
}> {
  const empty = { ttsSegments: null, characters: null, previousResult: null }
  if (!storyboardId || !episodeId) return empty
  try {
    const [sb] = db.select({ ttsSegments: schema.storyboards.ttsSegments })
      .from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    let ttsSegments: Array<{ speaker?: string; text?: string; isNarrator?: boolean; voice?: string }> | null = null
    if (sb?.ttsSegments) {
      try {
        const arr = typeof sb.ttsSegments === 'string' ? JSON.parse(sb.ttsSegments) : sb.ttsSegments
        if (Array.isArray(arr) && arr.length) ttsSegments = arr
      } catch { /* 坏 JSON → 当没有台词, 不阻断生成 */ }
    }
    // 上一镜的收尾状态 (同 episode, storyboard_number = 当前 - 1) —— H3 模板的"承接上一镜"注入用
    let previousResult: string | null = null
    try {
      const [cur] = db.select({
        storyboardNumber: schema.storyboards.storyboardNumber,
        sceneId: schema.storyboards.sceneId,
      }).from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
      if (cur) {
        const [prev] = db.select({ result: schema.storyboards.result, sceneId: schema.storyboards.sceneId })
          .from(schema.storyboards)
          .where(and(
            eq(schema.storyboards.episodeId, episodeId),
            eq(schema.storyboards.storyboardNumber, (cur.storyboardNumber || 1) - 1),
          ))
          .all()
        // 只有同场景的上一镜才承接 (跨场景不承接)
        if (prev && prev.sceneId === cur.sceneId) previousResult = prev.result || null
      }
    } catch { /* 取不到就跳过承接, 不阻断生成 */ }

    const charLinks = db.select({ characterId: schema.episodeCharacters.characterId })
      .from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    const ids = [...new Set(charLinks.map((l) => l.characterId))].sort((a, b) => a - b)
    const characters = ids.length
      ? db.select({
        id: schema.characters.id,
        name: schema.characters.name,
        appearancePermanent: schema.characters.appearancePermanent,
        personality: schema.characters.personality,
        role: schema.characters.role,
      }).from(schema.characters).where(inArray(schema.characters.id, ids)).all()
        .sort((a, b) => a.id - b.id)
        // DB 的可空列 → 接口里的可选字段 (null 统一成 undefined)
        .map((c) => ({
          id: c.id,
          name: c.name,
          appearancePermanent: c.appearancePermanent ?? undefined,
          personality: c.personality ?? undefined,
          role: c.role ?? undefined,
        }))
      : []
    return { ttsSegments, characters, previousResult }
  } catch (err: any) {
    logTaskWarn('VideoTask', 'inject-context-failed', {
      storyboardId, episodeId, error: err?.message || String(err),
      hint: '取生成期注入上下文失败, 本次不注入对白/主体绑定 (不阻断视频生成)',
    })
    return empty
  }
}

/**
 * Sprint 17 Task E④: 场景第一镜必须交代地点 (老路径 二 镜头顺序铁律)。
 *
 * ⚠️ 先只 warn 不强制改 (PM Task E 明确要求) —— 强制改会跟 LLM 的整体设计冲突, 得不偿失。
 *   查 2 次 DB (本镜 + 同场景第一镜), 视频生成本来就要跑几分钟, 多一次主键查询无所谓。
 */
function checkSceneOpeningWideShot(storyboardId: number | null | undefined): void {
  if (!storyboardId) return
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.sceneId) return
  // ⚠️ 必须按 episodeId 隔离 (QA msg-20261021-077 Bug-2):
  //   scene 是 drama 级资源, 同一个 scene 可以被多个 episode 复用 (episode_scenes 关联表),
  //   不加 episode 过滤的话, 上一集用过的 scene 会把"本集场景第一镜"判定吃掉 → 告警永远不触发。
  const firstInScene = db.select({
    id: schema.storyboards.id,
    shotType: schema.storyboards.shotType,
  })
    .from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.sceneId, sb.sceneId),
      eq(schema.storyboards.episodeId, sb.episodeId),
    ))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()[0]
  if (!firstInScene || firstInScene.id !== sb.id) return
  const check = checkSceneOpensWithWideShot(true, firstInScene.shotType)
  if (!check.shouldWarn) return
  logTaskWarn('VideoTask', 'scene-opens-not-wide-shot', {
    storyboardId,
    sceneId: sb.sceneId,
    shotType: check.shotType,
    hint: '所属场景的第一镜不是全景 —— 老路径铁律要求场景开头第一镜交代地点, 建议重拆这一镜',
  })
}

async function normalizeVideoReferenceUrls(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(0, item)),
  )
  return normalized.filter((item): item is string => !!item)
}

async function pollVideoTask(id: number, config: AIConfig, videoId: string, taskId: string, storyboardId?: number | null) {
  const adapter = getVideoAdapter(config.provider)
  // 总 poll 时长上限 30 分钟(180 次 × 10s);连续 5 次失败就放弃
  const MAX_POLLS = 180
  const MAX_CONSECUTIVE_FAILS = 5
  // 指数退避轮询: 5s → 10s → 15s → 30s(封顶)
  // 视频生成通常 1-3 分钟,起步快一点确认开始,后段慢一点减轻 agnes 压力
  const POLL_INTERVALS_MS = [5_000, 10_000, 15_000, 30_000]
  function getPollIntervalMs(attempt: number): number {
    const idx = Math.min(attempt - 1, POLL_INTERVALS_MS.length - 1)
    return POLL_INTERVALS_MS[idx]
  }
  // 视频任务超过 30 分钟强制 timeout
  const MAX_POLL_DURATION_MS = 30 * 60 * 1000
  // 4xx / JSON 解析错误视为"端点或响应格式不对",再重试无意义,直接放弃
  const PERMANENT_STATUS = new Set([400, 401, 403, 404, 410, 422])

  let consecutiveFails = 0
  const startedAt = Date.now()

  for (let i = 0; i < MAX_POLLS; i++) {
    // 总时长硬上限
    if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
      logTaskError('VideoTask', 'poll-duration-timeout', { id, taskId, maxDurationSec: MAX_POLL_DURATION_MS / 1000 })
      db.update(schema.videoGenerations)
        .set({ status: 'failed', errorMsg: `Poll timeout after ${Math.round((Date.now() - startedAt) / 1000)}s`, updatedAt: now() })
        .where(eq(schema.videoGenerations.id, id)).run()
      return
    }
    await new Promise(r => setTimeout(r, getPollIntervalMs(i + 1)))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, videoId, taskId)
      logTaskProgress('VideoTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const resp = await fetch(url, { method, headers })

      if (!resp.ok) {
        consecutiveFails++
        const body = await resp.text().catch(() => '')
        logTaskWarn('VideoTask', 'poll-http-error', {
          id,
          taskId,
          attempt: i + 1,
          status: resp.status,
          bodyPreview: body.slice(0, 200),
        })
        if (PERMANENT_STATUS.has(resp.status)) {
          // 端点不对/鉴权错,直接放弃
          logTaskError('VideoTask', 'poll-permanent-fail', {
            id, taskId, status: resp.status, error: body.slice(0, 240),
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll permanent error ${resp.status}: ${body.slice(0, 200)}`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          logTaskError('VideoTask', 'poll-giveup', {
            id, taskId, consecutiveFails, lastStatus: resp.status,
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll gave up after ${consecutiveFails} consecutive failures (last status ${resp.status})`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        continue
      }

      // 状态 200 但响应不是 JSON(比如 agnes 返回 HTML 404 页面),JSON.parse 抛 SyntaxError
      const contentType = resp.headers.get('content-type') || ''
      const rawText = await resp.text()
      if (!contentType.includes('application/json') && !rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
        consecutiveFails++
        logTaskWarn('VideoTask', 'poll-non-json-response', {
          id, taskId, attempt: i + 1, contentType,
          bodyPreview: rawText.slice(0, 200),
        })
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          logTaskError('VideoTask', 'poll-giveup-non-json', {
            id, taskId, consecutiveFails,
            lastBody: rawText.slice(0, 240),
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `Poll gave up: ${consecutiveFails} consecutive non-JSON responses. Last: ${rawText.slice(0, 200)}`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id)).run()
          return
        }
        continue
      }

      const result = JSON.parse(rawText) as any
      consecutiveFails = 0  // 成功解析,清零
      const hasAnyUrl = !!(result.url || result.video_url || result.data?.url
        || result.data?.video_url || result.output?.url || result.result?.url)
      // 记录 poll 响应用于诊断(每个轮询都打印精简版)
      logTaskProgress('VideoTask', 'poll-response', {
        id, taskId, attempt: i + 1,
        status: result.status, progress: result.progress,
        hasUrl: hasAnyUrl,
        fields: Object.keys(result).join(','),
      })
      // 完整 body 在第 1 / 5 / 10 / status 变化时打印(帮助诊断 url 字段在哪)
      const lastStatus = (globalThis as any).__lastPollStatus
      if (i < 3 || (i + 1) % 5 === 0 || (lastStatus !== undefined && lastStatus !== result.status)) {
        // 关键: 把 result 完整序列化(如果 size 太大截断)
        // 之前 result_keys 只列字段名,不知道具体值
        const resultString = JSON.stringify(result)
        const resultPreview = resultString.length > 800
          ? resultString.slice(0, 800) + '...<truncated ' + (resultString.length - 800) + ' chars>'
          : resultString
        logTaskPayload('VideoTask', 'poll-response-body', {
          id, taskId, attempt: i + 1,
          status: result.status, progress: result.progress,
          seconds: result.seconds, size: result.size,
          metadata: result.metadata,
          result_keys: Object.keys(result),
          result_preview: resultPreview,
        })
        ;(globalThis as any).__lastPollStatus = result.status
      }
      const pollResp = await adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId)
        return
      }
      if (pollResp.status === 'failed') {
        const errorMsg = pollResp.error || 'Video generation failed'
        logTaskError('VideoTask', 'poll-failed', { id, taskId, error: errorMsg })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id)).run()
        markStoryboardFailed(storyboardId, errorMsg)
        return
      }
      // 仍 processing,继续下一轮
    } catch (err: any) {
      consecutiveFails++
      logTaskWarn('VideoTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        logTaskError('VideoTask', 'poll-giveup-exception', { id, taskId, consecutiveFails, error: err.message })
        const failMsg = `Poll gave up after ${consecutiveFails} consecutive exceptions: ${err.message}`
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: failMsg, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id)).run()
        markStoryboardFailed(storyboardId, failMsg)
        return
      }
    }
  }
  // 用尽 MAX_POLLS
  logTaskError('VideoTask', 'poll-timeout', { id, taskId, maxPolls: MAX_POLLS })
  const failMsg = `Poll timeout after ${MAX_POLLS} attempts`
  db.update(schema.videoGenerations)
    .set({ status: 'failed', errorMsg: failMsg, updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id)).run()
  markStoryboardFailed(storyboardId, failMsg)
}

async function handleVideoComplete(id: number, videoUrl: string, duration: number | null | undefined, storyboardId?: number | null) {
  const localPath = await downloadFile(videoUrl, 'videos')
  db.update(schema.videoGenerations)
    .set({ videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
  logTaskSuccess('VideoTask', 'downloaded', { id, localPath, storyboardId, duration })

  if (storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }
}

/**
 * ★ Sprint 47 T7 (PM msg-20261115-188): 超长镜拆分 (单镜时长上限 12 秒)
 *
 * 【为什么要有】
 *   台词装不下镜长 → 台词被硬裁 → 口型/表演不对; 而且长镜在 AI 视频模型下容易动作变慢/内容重复。
 *   用户 2026-11-15 拍板 D1: 单镜上限 12 秒, 超过就【拆成两镜】——不许压语速、不许硬裁。
 *
 * 【怎么拆】
 *   · LLM 主路径: 把这一镜的画面描述/动作/台词丢给 LLM → 它按语义切成两镜 (台词不许切在句子中间)
 *   · 规则兜底: LLM 失败/超时 → 按【说话人换行】切台词 (再不行按句末标点切), 画面描述按句号切 + 第二镜加「（承上）」
 *   ★ 拆出来的两镜: 同一 scene、角色/道具关联照抄、承接关系 (result → 下一镜的起点) 保持
 *   ★ 只在超长时拆: duration ≤ 12s 的镜直接返回"不拆" (拆镜会让画面节奏变碎)
 *
 * 【时长】
 *   每镜时长 = max(该半边的台词 floor, 按字数比例分配的时长), 并且 ≤ 12s
 *   总时长 ≈ 拆前 (台词 floor 兜底时会略长一点 —— 宁可长也不裁台词)
 *
 * 【清理】
 *   拆出来的两镜是【新镜】→ 旧的配音/字幕/首帧图/视频都作废 (prompt 变了, 旧图不对)
 *   → 清掉, 由正常流水线重新产出 (配音会自动重新生成; 首帧图需要用户再点一次生成)
 */
import { db, schema } from '../db/index.js'
import { eq, gt } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskWarn, logTaskSuccess, logTaskError } from '../utils/task-logger.js'
import { getTextConfig } from './ai.js'
import { countDialogueChars } from '../constants/shot-type-baseline.js'
// ★ Sprint 48 T5 (PM msg-20261116-194): 拆镜后异步触发配音 + 状态登记
import { generateTTSForDialogue } from './tts-concat.js'
import { setTtsJobStatus } from './tts-status.js'
// ★ Sprint 47 T7: 纯逻辑部分在 services/storyboard-split-rules.ts (不碰 DB → 可离线断言)
import {
  SPLIT_MAX_DURATION,
  shouldSplitShot,
  splitDialogueByBudget,
  splitTextByBudget,
  computeSplitDurations,
  type SplitPart,
} from './storyboard-split-rules.js'

export {
  SPLIT_MAX_DURATION,
  shouldSplitShot,
  splitDialogueByBudget,
  splitTextByBudget,
  computeSplitDurations,
}
export type { SplitPart }

export interface SplitOutcome {
  /** 是否真的拆了 */
  split: boolean
  reason?: string
  episodeId?: number
  originalId?: number
  originalNumber?: number
  newShotIds?: number[]
  newShotNumbers?: number[]
  parts?: SplitPart[]
  durations?: number[]
  /** 用的是 LLM 还是规则兜底 */
  source?: 'llm' | 'rule'
  error?: string
}

/** ═══════════════ 纯函数部分 (可离线断言) ═══════════════ */

/** ═══════════════ LLM 主路径 ═══════════════ */

const SPLIT_SYSTEM_PROMPT = `你是短剧分镜导演。用户会给你【一镜】的画面描述、动作、台词, 这一镜太长了, 需要拆成两镜。

【硬要求】
1. 两镜必须各自成立 (画面内容可以分开看, 不是同一画面切两半)
2. 台词按【语义】断到两镜里: ★ 不能从一句话中间切断; 优先在说话人换行处断, 其次在句末标点处断
3. 台词总量必须与原文一致 (不许改写/删字/加字), 只允许重新分配到两镜
4. 第一镜的 result 是承接状态, 第二镜的 action 接住它
5. 只输出 JSON, 不要任何解释文字

【输出格式】
{"parts":[{"description":"...","action":"...","result":"...","atmosphere":"...","dialogue":"..."},{"description":"...","action":"...","result":"...","atmosphere":"...","dialogue":"..."}]}`

/** 调 LLM 拆镜 (失败 → 返回 null, 走规则兜底) */
async function callSplitLLM(input: {
  description: string; action: string; result: string; atmosphere: string; dialogue: string
}): Promise<SplitPart[] | null> {
  try {
    const config = getTextConfig()
    const url = config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
    const payload = {
      model: config.model,
      messages: [
        { role: 'system', content: SPLIT_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 3000,
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      logTaskWarn('StoryboardSplit', 'llm-http-error', { status: resp.status })
      return null
    }
    const j: any = await resp.json().catch(() => null)
    const content = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.message?.reasoning_content
    if (!content) return null
    const parsed = JSON.parse(String(content).replace(/^```(?:json)?|```$/g, '').trim())
    const parts = parsed?.parts
    if (!Array.isArray(parts) || parts.length !== 2) return null
    const clean = parts.map((p: any) => ({
      description: String(p?.description ?? '').trim(),
      action: String(p?.action ?? '').trim(),
      result: String(p?.result ?? '').trim(),
      atmosphere: String(p?.atmosphere ?? '').trim(),
      dialogue: String(p?.dialogue ?? '').trim(),
    }))
    // ★ 校验: 台词总量不能变 (防止 LLM 改写/丢字)
    const origChars = countDialogueChars(input.dialogue)
    const newChars = countDialogueChars(clean[0].dialogue) + countDialogueChars(clean[1].dialogue)
    if (origChars > 0 && Math.abs(newChars - origChars) > Math.max(2, origChars * 0.1)) {
      logTaskWarn('StoryboardSplit', 'llm-dialogue-mismatch', { origChars, newChars })
      return null
    }
    if (!clean[0].dialogue.trim() || !clean[1].dialogue.trim()) {
      // 有一半没台词 → 不算语义拆分 (至少要两边都有内容)
      if (origChars > 0) return null
    }
    if (!clean[0].description.trim() && !clean[1].description.trim()) return null
    return clean
  } catch (err: any) {
    logTaskWarn('StoryboardSplit', 'llm-call-fail', { error: err?.message || String(err) })
    return null
  }
}

/** ═══════════════ 主入口 ═══════════════ */

/**
 * ★ 拆一个超长镜 (超过 SPLIT_MAX_DURATION 才拆)。
 * @param storyboardId 要拆的镜
 * @param opts.useLlm 是否走 LLM 主路径 (默认 true; 失败自动降级到规则兜底)
 */
/**
 * ★ Sprint 48 T5 (PM msg-20261116-194): 拆镜后【异步】触发配音 (用新拆出来的台词)
 *
 * ★ 修一个真 bug (工单实测: 拆出来的两镜 tts_segments 段数 = 0, 且没有任何 AudioTask):
 *   之前 split 路由调 generateTTSForDialogue(newId, epId, undefined, undefined),
 *   而那个函数【只认传入的 dialogue 参数, 不回查 DB】→ 传 undefined → 解析出 0 段
 *   → 直接 ignored 返回 → 连日志都没有 → 静默没声音。
 *   → 现在: 从 DB 读新镜的 dialogue + atmosphere 再传进去。
 *
 * ★ 不阻塞拆分: 调用方 fire-and-forget, 状态登记到 tts-status (前端轮询)。
 * ★ 幂等: 每次拆分产生的是【新镜】, 每镜各配一次自己的台词 → 不会产生重复配音。
 */
export async function triggerAutoTtsForSplitShots(
  shots: Array<{ id: number; dialogue: string; atmosphere: string }>,
  episodeId: number,
): Promise<void> {
  for (const s of shots) {
    const startedAt = new Date().toISOString()
    setTtsJobStatus({ storyboardId: s.id, status: 'running', startedAt })
    try {
      const r = await generateTTSForDialogue(s.id, episodeId, s.dialogue, s.atmosphere)
      if (r.ignored) {
        setTtsJobStatus({
          storyboardId: s.id, status: 'skipped',
          error: r.reason || '这镜没有可合成的台词', startedAt, finishedAt: new Date().toISOString(),
        })
        logTaskWarn('StoryboardSplit', 'auto-tts-skipped', { storyboardId: s.id, reason: r.reason })
      } else {
        // ★ Sprint 48 单 195 (PM msg-20261116-195): ★ 必须把结果【落库】!!
        //   之前只记了状态没写 storyboards → 页面显示【待生成】, compose 兜底又重新生成一遍 (白花一次额度),
        //   导出素材包也读不到这两镜的台词记录。
        //   写回字段与手动点【生成配音】那条路径【完全一致】(ttsAudioUrl + ttsSegments)。
        db.update(schema.storyboards)
          .set({
            ttsAudioUrl: r.audioPath,
            ttsSegments: JSON.stringify(r.segments ?? []),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.storyboards.id, s.id))
          .run()
        setTtsJobStatus({
          storyboardId: s.id, status: 'done', startedAt, finishedAt: new Date().toISOString(),
        })
        logTaskSuccess('StoryboardSplit', 'auto-tts-done', {
          storyboardId: s.id, segmentCount: r.segments?.length ?? 0, outPath: r.audioPath,
          hint: '已落库 (tts_audio_url + tts_segments) → 页面显示已生成, compose 不会重复生成',
        })
      }
    } catch (err: any) {
      setTtsJobStatus({
        storyboardId: s.id, status: 'failed',
        error: err?.message || String(err), startedAt, finishedAt: new Date().toISOString(),
      })
      logTaskError('StoryboardSplit', 'auto-tts-failed', {
        storyboardId: s.id, error: err?.message || String(err),
      })
    }
  }
}

export async function splitShotIfNeeded(
  storyboardId: number,
  opts: { useLlm?: boolean } = {},
): Promise<SplitOutcome> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return { split: false, reason: 'shot_not_found' }
  const originalDuration = Number(sb.duration ?? 0)

  // ★ 只在超长时拆 (拆镜会让画面节奏变碎)
  if (!shouldSplitShot(originalDuration)) {
    return { split: false, reason: 'not_over_limit', originalId: sb.id, originalNumber: sb.storyboardNumber }
  }

  const chars = countDialogueChars(sb.dialogue)
  const maxChars = Math.max(8, Math.floor(SPLIT_MAX_DURATION * 4.5))   // 12s ≈ 54 字

  let parts: SplitPart[] | null = null
  let source: 'llm' | 'rule' = 'rule'
  if (opts.useLlm !== false) {
    parts = await callSplitLLM({
      description: sb.description || '',
      action: sb.action || '',
      result: sb.result || '',
      atmosphere: sb.atmosphere || '',
      dialogue: sb.dialogue || '',
    })
    if (parts) source = 'llm'
  }

  // ★ 规则兜底
  if (!parts) {
    const d = splitDialogueByBudget(sb.dialogue || '', maxChars)
    const desc = splitTextByBudget(sb.description || '', maxChars)
    const act = splitTextByBudget(sb.action || '', maxChars)
    parts = [
      {
        description: desc.first,
        action: act.first,
        result: sb.result || '',
        atmosphere: sb.atmosphere || '',
        dialogue: d?.first ?? '',
      },
      {
        description: desc.second,
        action: act.second,
        result: sb.result || '',
        atmosphere: sb.atmosphere || '',
        dialogue: d?.second ?? '',
      },
    ]
    source = 'rule'
  }

  // 兜底还切不出两半 (台词只有一句且没标点) → 不拆, 交回调用方决定
  const c1 = countDialogueChars(parts[0].dialogue)
  const c2 = countDialogueChars(parts[1].dialogue)
  if (chars > 0 && (c1 === 0 || c2 === 0)) {
    logTaskWarn('StoryboardSplit', 'cannot-split-dialogue', {
      storyboardId, chars, duration: originalDuration,
      hint: '台词只有一句且没有可断的边界 → 不拆 (宁可让 T6 回写镜长, 也不切在句子中间)',
    })
    return { split: false, reason: 'cannot_split', originalId: sb.id, originalNumber: sb.storyboardNumber }
  }

  const { durations, total, floorBound } = computeSplitDurations(originalDuration, c1, c2)
  logTaskProgress('StoryboardSplit', 'split-computed', {
    storyboardId, originalNumber: sb.storyboardNumber, originalDuration,
    source, durations, total, floorBound, charsFirst: c1, charsSecond: c2,
    hint: floorBound
      ? '台词 floor 兜底 → 拆后总时长比拆前略长 (宁可长也不裁台词)'
      : '总时长 ≈ 拆前',
  })

  // ── 落库: 新建两镜 → 照抄角色/道具关联 → 后续镜号 +1 → 删原镜 ──
  const charLinks = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  const propLinks = db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId)).all()

  const newIds: number[] = []
  const newNumbers: number[] = []
  try {
    db.transaction((tx) => {
      // 后续镜号 +1 (原镜位置腾给第一半)
      const following = tx.select({ id: schema.storyboards.id, storyboardNumber: schema.storyboards.storyboardNumber })
        .from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, sb.episodeId))
        .all()
        .filter((r) => r.storyboardNumber > sb.storyboardNumber)
      for (const r of following) {
        tx.update(schema.storyboards)
          .set({ storyboardNumber: r.storyboardNumber + 1, updatedAt: now() })
          .where(eq(schema.storyboards.id, r.id)).run()
      }
      // 删原镜 + 它的关联
      tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
      tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
      tx.delete(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).run()

      for (let i = 0; i < 2; i++) {
        const p = parts![i]
        const res = tx.insert(schema.storyboards).values({
          episodeId: sb.episodeId,
          sceneId: sb.sceneId,
          dramaticFunction: sb.dramaticFunction,
          storyboardNumber: sb.storyboardNumber + i,
          title: `镜头#${sb.storyboardNumber + i}`,
          location: sb.location,
          time: sb.time,
          shotType: sb.shotType,
          angle: sb.angle,
          movement: sb.movement,
          action: p.action,
          result: p.result,
          atmosphere: p.atmosphere,
          dialogue: p.dialogue,
          description: p.description,
          duration: durations[i],
          // ★ 画面/视频 prompt: 拆完后画面内容变了 → 旧的 prompt 不再准确 → 清掉, 由正常流水线重新组装
          imagePrompt: null,
          imagePromptPlotState: null,
          imagePromptPermanent: sb.imagePromptPermanent,
          videoPrompt: null,
          videoPromptZh: null,
          videoPromptPlotState: null,
          negativePrompt: sb.negativePrompt,
          soundEffect: sb.soundEffect,
          bgmPrompt: sb.bgmPrompt,
          // ★ 旧产物全部作废 (配音/字幕/首帧图/视频都是按旧 prompt 来的)
          composedImage: null,
          firstFrameImage: null,
          lastFrameImage: null,
          referenceImages: null,
          videoUrl: null,
          ttsAudioUrl: null,
          ttsSegments: null,
          subtitleUrl: null,
          composedVideoUrl: null,
          // status 走默认 'pending' → 新镜的素材状态从头开始 (首帧图要重新生成)
          createdAt: now(),
          updatedAt: now(),
        }).run()
        const newId = Number(res.lastInsertRowid)
        newIds.push(newId)
        newNumbers.push(sb.storyboardNumber + i)
        // 角色/道具关联照抄 (两镜都保留原来的出场与道具)
        for (const cl of charLinks) {
          tx.insert(schema.storyboardCharacters).values({ storyboardId: newId, characterId: cl.characterId }).run()
        }
        for (const pl of propLinks) {
          tx.insert(schema.storyboardProps).values({ storyboardId: newId, propId: pl.propId }).run()
        }
      }
    })
  } catch (err: any) {
    logTaskError('StoryboardSplit', 'split-db-fail', { storyboardId, error: err?.message || String(err) })
    return { split: false, reason: 'db_error', error: err?.message || String(err), originalId: sb.id }
  }

  logTaskSuccess('StoryboardSplit', 'split-done', {
    storyboardId, originalNumber: sb.storyboardNumber, originalDuration,
    newShotIds: newIds, newShotNumbers: newNumbers, durations, source,
    hint: '拆出的两镜: 配音会按新台词重新生成; 首帧图需要再点一次生成 (prompt 变了, 旧图不对)',
  })

  return {
    split: true,
    episodeId: sb.episodeId,
    originalId: sb.id,
    originalNumber: sb.storyboardNumber,
    newShotIds: newIds,
    newShotNumbers: newNumbers,
    parts,
    durations,
    source,
  }
}

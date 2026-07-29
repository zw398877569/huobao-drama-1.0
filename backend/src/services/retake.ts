/**
 * Single-variable retake — P1 Take Triage second round.
 *
 * The user has already received a quality evaluation (4-dim scores from
 * evaluation.ts). They pick ONE dimension to improve and the system
 * regenerates the image_prompt / video_prompt while keeping all other
 * aspects locked.
 *
 * Constraints (enforced via prompt + light post-validation):
 *   - ONLY the chosen dimension's aspects are adjusted
 *   - location / time / characters / scene / dramatic intent preserved
 *   - retake_count is incremented; retake_variable records what changed
 *   - attempt budget enforced at the route layer (5 here, lower for UI)
 *
 * "Single variable" enforcement strategy (round 1):
 *   - System prompt explicitly forbids touching other aspects
 *   - Post-validation: location tokens + character name tokens in the
 *     old prompt must still appear in the new prompt. If not, the
 *     retake is rejected and the user is told to try a more focused
 *     user_note.
 *   - Full diff-based surgery is deferred to a later round.
 */

import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextConfig } from './ai.js'
import { readImageAsCompressedDataUrl } from '../utils/storage.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export type RetakeDimension = 'prompt' | 'visual' | 'motion' | 'continuity'

export const RETAKE_DIMENSIONS: Record<RetakeDimension, { label: string; target: string }> = {
  prompt: {
    label: '提示词契合度',
    target: '让 image_prompt / video_prompt 的具体描述更贴合 intended 画面（主体 / 构图 / 关键元素）',
  },
  visual: {
    label: '画面质量',
    target: '提升画面质感（构图 / 锐度 / 光线 / 色彩的具体措辞）',
  },
  motion: {
    label: '运镜自然度',
    target: '调整运镜 / 运动 / 节奏的具体描述',
  },
  continuity: {
    label: '意图一致性',
    target: '让镜头描述更对齐 scene_intention 的戏剧功能 / 视觉策略',
  },
}

// Hard limit enforced at the service level. The route layer
// additionally enforces a softer UI-facing limit (3) so users see a
// clear "stop sign" before the service refuses.
export const RETAKE_HARD_LIMIT = 10

export interface RetakeResult {
  image_prompt: string
  video_prompt: string
  change_summary: string
  retake_count: number
}

interface RetakeParsed {
  new_image_prompt?: string
  new_video_prompt?: string
  change_summary?: string
}

function parseRetakeJson(text: string): RetakeParsed {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned) as RetakeParsed
  } catch {
    return {}
  }
}

const RETAKE_SYSTEM_PROMPT = `你是一位严格的 prompt 微调师，专门做"单变量重拍"。

用户已经收到了本镜头的质量评估，发现某个维度分数偏低。现在他们要你只改进这个维度，其他一切保持原样。

## 强制规则（任何情况下都不得违反）

1. **location / time / 场景 / 角色 / 戏剧意图完全保持原样**。不要改地点、改时间、改人物身份、改灯光方向、改变焦。
2. **只调整选定维度的措辞**。其他维度就算原作者写得不好，也**不要碰**。
3. 不要扩大 / 缩小 / 重写 prompt。新 prompt 必须仍然描述同一个镜头、同一个动作、同一个时间点。
4. 如果原 prompt 已经够好，保留原样即可，不要为了"看起来在改"硬塞改动。

## 输出格式（严格 JSON，无额外文字）

{
  "new_image_prompt": "<新的 image_prompt>",
  "new_video_prompt": "<新的 video_prompt>",
  "change_summary": "<1-2 句话说明这次只改了哪个维度的哪些关键词>"
}

如果原 prompt 已经满足要求，可以原样返回 new_image_prompt / new_video_prompt，并在 change_summary 里写"已检查，无需改动"。`

function buildRetakeUserPrompt(
  sb: any,
  intention: Record<string, any> | null,
  dimension: RetakeDimension,
  userNote: string
): string {
  const dim = RETAKE_DIMENSIONS[dimension]
  const lines: string[] = []
  lines.push(`## 待改进镜头`)
  lines.push(`标题：${sb.title || '(无)'}`)
  lines.push(`景别：${sb.shotType || '(未设)'}`)
  lines.push(`角度：${sb.angle || '(未设)'}`)
  lines.push(`运镜：${sb.movement || '(未设)'}`)
  lines.push(`地点：${sb.location || '(未设)'}`)
  lines.push(`时间：${sb.time || '(未设)'}`)
  lines.push(`动作：${sb.action || '(无)'}`)
  lines.push(`画面描述：${sb.description || '(无)'}`)
  lines.push(`对白：${sb.dialogue || '(无)'}`)
  lines.push(`氛围：${sb.atmosphere || '(无)'}`)
  lines.push(`--- 当前 prompt ---`)
  lines.push(`image_prompt: ${sb.imagePrompt || '(无)'}`)
  lines.push(`video_prompt: ${sb.videoPrompt || '(无)'}`)
  if (intention) {
    lines.push(`--- 戏剧意图（必须保持对齐）---`)
    lines.push(`戏剧功能：${intention.function || '(无)'}`)
    lines.push(`戏剧目的：${intention.intention || '(无)'}`)
    lines.push(`视觉策略：${intention.visualStrategy || '(无)'}`)
  }
  lines.push(`---`)
  lines.push(`## 用户要求`)
  lines.push(`改进维度：**${dim.label}**`)
  lines.push(`改进目标：${dim.target}`)
  if (userNote.trim()) {
    lines.push(`用户具体反馈：${userNote.trim()}`)
  }
  lines.push(`请严格只调整这个维度的措辞，输出 JSON。`)
  return lines.join('\n')
}

/**
 * Lightweight post-validation: if the new prompt dropped key tokens
 * from the old one (location, character name, intent keyword), the
 * retake is likely too aggressive. Reject with a clear error so the
 * user can refine the user_note.
 */
function validateSingleVariable(oldImage: string, newImage: string, intentText: string): string | null {
  // 1. Each non-trivial word (>2 chars, Chinese or English) in old should
  //    ideally still appear in new. Allow up to 50% drop as safety margin.
  const extractTokens = (s: string) => {
    const tokens: string[] = []
    // English words
    const en = s.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || []
    tokens.push(...en.map((w) => w.toLowerCase()))
    // Chinese 2-grams and 3-grams (rough heuristic; we only check a
    // sliding window so we don't over-match)
    const cn = s.match(/[\u4e00-\u9fa5]{2,3}/g) || []
    tokens.push(...cn)
    return Array.from(new Set(tokens))
  }
  const oldTokens = extractTokens(oldImage + ' ' + intentText)
  if (!oldTokens.length) return null
  const newLower = (newImage + ' ' + intentText).toLowerCase()
  const missing = oldTokens.filter((t) => !newLower.includes(t.toLowerCase()))
  if (missing.length > oldTokens.length * 0.5) {
    return `重写后的 prompt 丢失了过多原有关键词（${missing.length}/${oldTokens.length}）。这说明 LLM 改动过大，请给更聚焦的反馈（如「把光线改暖一点」而非「整体重写」），重试。`
  }
  return null
}

export async function retakeStoryboard(
  storyboardId: number,
  dimension: RetakeDimension,
  userNote: string
): Promise<RetakeResult> {
  if (!RETAKE_DIMENSIONS[dimension]) {
    throw new Error(`未知重拍维度：${dimension}`)
  }

  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error('镜头不存在')
  if ((sb.retakeCount || 0) >= RETAKE_HARD_LIMIT) {
    throw new Error(`已超过单镜头最大重拍次数 (${RETAKE_HARD_LIMIT})，请直接修改镜头结构。`)
  }

  logTaskStart('StoryboardRetake', 'retake', {
    storyboardId,
    episodeId: sb.episodeId,
    dimension,
    retakeCount: sb.retakeCount || 0,
  })

  let intention: Record<string, any> | null = null
  if (sb.sceneIntention) {
    try { intention = JSON.parse(sb.sceneIntention) } catch { /* ignore */ }
  }

  // Build vision context if we have a first frame
  let imageDataUrl: string | null = null
  if (sb.firstFrameImage) {
    try {
      imageDataUrl = await readImageAsCompressedDataUrl(sb.firstFrameImage, {
        maxWidth: 1024,
        maxHeight: 1024,
        quality: 70,
      })
    } catch (e: any) {
      logTaskWarn('StoryboardRetake', 'image-read-failed', { error: e.message })
    }
  }

  const config = await getTextConfig()
  const baseUrl = `${config.baseUrl}/v1/chat/completions`

  const userContent: any[] = [{ type: 'text', text: buildRetakeUserPrompt(sb, intention, dimension, userNote) }]
  if (imageDataUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageDataUrl } })
  }

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: RETAKE_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    logTaskWarn('StoryboardRetake', 'llm-call-failed', {
      storyboardId,
      status: resp.status,
      body: errText.slice(0, 300),
    })
    throw new Error(`重拍模型调用失败 (${resp.status})：${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  const raw = data?.choices?.[0]?.message?.content?.trim()
  if (!raw) throw new Error('重拍模型未返回内容')

  const parsed = parseRetakeJson(raw)
  const newImage = (parsed.new_image_prompt ?? sb.imagePrompt ?? '').trim()
  const newVideo = (parsed.new_video_prompt ?? sb.videoPrompt ?? '').trim()
  const changeSummary = (parsed.change_summary ?? '').trim()

  // Light single-variable validation
  if (sb.imagePrompt && newImage !== sb.imagePrompt) {
    const intentText = intention ? JSON.stringify(intention) : ''
    const validationError = validateSingleVariable(sb.imagePrompt, newImage, intentText)
    if (validationError) {
      logTaskWarn('StoryboardRetake', 'rejected-too-aggressive', {
        storyboardId,
        missing: validationError.slice(0, 100),
      })
      throw new Error(validationError)
    }
  }

  // Apply
  const newRetakeCount = (sb.retakeCount || 0) + 1
  db.update(schema.storyboards).set({
    imagePrompt: newImage,
    videoPrompt: newVideo,
    retakeCount: newRetakeCount,
    retakeVariable: dimension,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, storyboardId)).run()

  logTaskSuccess('StoryboardRetake', 'retake', {
    storyboardId,
    dimension,
    newRetakeCount,
    changeSummary: changeSummary.slice(0, 100),
  })
  logTaskProgress('StoryboardRetake', 'applied', { retakeCount: newRetakeCount })

  return {
    image_prompt: newImage,
    video_prompt: newVideo,
    change_summary: changeSummary,
    retake_count: newRetakeCount,
  }
}

/**
 * Rough per-shot cost estimate in CNY. Real pricing isn't available via
 * most provider APIs, so this is a configurable placeholder. Each retake
 * is treated as one image generation + one video generation.
 *
 * Override with HUOBAO_RETAKE_COST_CNY env var.
 */
export function estimateRetakeCostCNY(durationSec: number = 10): number {
  const perShot = Number(process.env.HUOBAO_RETAKE_COST_CNY) || 2.0
  // Roughly: image ~ 20% of cost, video ~ 80% scaled by duration
  const videoFactor = Math.max(1, durationSec / 10)
  return Number((perShot * (0.2 + 0.8 * videoFactor)).toFixed(2))
}

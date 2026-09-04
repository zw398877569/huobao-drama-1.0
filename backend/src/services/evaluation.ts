/**
 * 镜头质量评估服务 — P1 Take Triage 第一轮
 *
 * 输入：已生成首帧的 storyboard（first_frame_image 不能为空）
 * 输出：4 维评分（prompt_adherence / visual_quality / motion_naturalness / continuity）+ notes
 *
 * 用场景意图（scene_intention）做 anchor 时，continuity 维度才有意义；没有则跳过该维。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextConfig, getTextChatCompletionsUrl } from './ai.js'
import { readImageAsCompressedDataUrl } from '../utils/storage.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export type EvalScores = {
  prompt_adherence: number
  visual_quality: number
  motion_naturalness: number
  continuity: number
  notes: string
}

const SCORE_RANGE = { min: 0, max: 10 }

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (!Number.isFinite(n)) return 0
  return Math.max(SCORE_RANGE.min, Math.min(SCORE_RANGE.max, n))
}

function stripThinkBlocks(text: string): string {
  // MiniMax-M3 等 reasoning model 会输出 <think>...</think> 块,JSON.parse 会挂。剥掉。
  // 可能有多个(罕见),用 global + dotall
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '')
}

function extractJsonCandidate(text: string): string {
  // 跟 backend/src/routes/grid.ts:282 同模式 — 先 fence,后 plain object
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const plain = text.match(/\{[\s\S]*\}/)
  return plain?.[0]?.trim() || ''
}

function parseEvalJson(text: string, storyboardId?: number): EvalScores {
  // 三步兜底(2026-08-22 bug):
  // 1) 剥 <think>...</think>(reasoning model 必走这步)
  // 2) 剥 ```json 围栏 + 提取最外层 {...} 块
  // 3) JSON.parse — 仍失败才返回全 0 + 完整 raw text 进 notes
  const stripped = stripThinkBlocks(text)
  const candidate = extractJsonCandidate(stripped)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate)
      return {
        prompt_adherence: clampScore(parsed.prompt_adherence),
        visual_quality: clampScore(parsed.visual_quality),
        motion_naturalness: clampScore(parsed.motion_naturalness),
        continuity: clampScore(parsed.continuity),
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      }
    } catch {
      // candidate 提取到了但不是合法 JSON,落到下面的最终兜底
    }
  }
  logTaskError('StoryboardEval', 'json-parse-failed', {
    storyboardId,
    rawLength: text.length,
    rawPreview: text.slice(0, 500),
    rawTail: text.length > 500 ? text.slice(-200) : '',
  })
  return { prompt_adherence: 0, visual_quality: 0, motion_naturalness: 0, continuity: 0, notes: '解析失败,原文已记入后端日志(eval-error): ' + text.slice(0, 300) }
}

const SYSTEM_PROMPT = `你是一位严格但公正的视觉导演，专门审 AI 生成的首帧画面。

对每个镜头按以下 4 维独立打分（0-10 分，整数或半整数均可）：

1. prompt_adherence — 实际画面与文字描述/提示词的契合度
   9-10：精确还原，主体/构图/光线/氛围都对得上
   7-8：基本还原，关键元素到位但有 1-2 处偏差
   5-6：主要元素对，但风格/构图/光线明显走样
   3-4：偏离较远，主体或场景识别困难
   0-2：与文字描述基本无关

2. visual_quality — 画面本身的物理质量
   9-10：清晰锐利，构图专业，无伪影
   7-8：清晰，有轻微瑕疵（曝光/锐度/色偏）
   5-6：可用但有明显质量问题
   3-4：模糊/扭曲/明显 AI 痕迹
   0-2：几乎不可用

3. motion_naturalness — 镜头描述的运镜/动作是否自然可行
   9-10：运镜流畅，符合物理直觉
   7-8：基本合理，但有 1 处不太自然的地方
   5-6：运镜描述有跳跃或不合理
   3-4：明显违反物理或摄影常识
   0-2：完全不合理（如固定机位却描述大幅推拉）

4. continuity — 与场景戏剧意图（如果给出）的一致性
   9-10：完美服务于意图
   7-8：基本服务意图
   5-6：有偏差
   0-4：服务于完全不同的意图
   若没有给出 scene_intention，此项按 5 分中性打分

只输出合法 JSON，不要任何额外文字。格式：
{"prompt_adherence": <0-10>, "visual_quality": <0-10>, "motion_naturalness": <0-10>, "continuity": <0-10>, "notes": "<=80 字的简短分析，重点指出哪几维低分及原因>"}`

function buildUserPromptText(sb: { description?: string | null; action?: string | null; imagePrompt?: string | null; videoPrompt?: string | null; title?: string | null; shotType?: string | null; movement?: string | null; angle?: string | null }, sceneIntention: Record<string, any> | null): string {
  const lines: string[] = []
  lines.push(`镜头标题：${sb.title || '(无)'}`)
  lines.push(`景别：${sb.shotType || '(未设)'}`)
  lines.push(`角度：${sb.angle || '(未设)'}`)
  lines.push(`运镜：${sb.movement || '(未设)'}`)
  lines.push(`画面描述：${sb.description || '(无)'}`)
  lines.push(`动作：${sb.action || '(无)'}`)
  lines.push(`图片提示词：${sb.imagePrompt || '(无)'}`)
  lines.push(`视频提示词：${sb.videoPrompt || '(无)'}`)
  if (sceneIntention) {
    lines.push('--- 导演意图 ---')
    lines.push(`戏剧功能：${sceneIntention.function || '(无)'}`)
    lines.push(`戏剧目的：${sceneIntention.intention || '(无)'}`)
    lines.push(`视觉策略：${sceneIntention.visualStrategy || '(无)'}`)
  } else {
    lines.push('--- 导演意图 ---')
    lines.push('（本镜头暂无 scene_intention）')
  }
  lines.push('---')
  lines.push('请基于上方文字描述 + 实际首帧图片，按 4 维评分。')
  return lines.join('\n')
}

export async function evaluateStoryboard(storyboardId: number): Promise<EvalScores | null> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return null
  if (!sb.firstFrameImage) {
    throw new Error('镜头尚未生成首帧，无法评估')
  }

  logTaskStart('StoryboardEval', 'evaluate', {
    storyboardId,
    firstFrame: sb.firstFrameImage,
  })

  let intention: Record<string, any> | null = null
  if (sb.sceneIntention) {
    try { intention = JSON.parse(sb.sceneIntention) } catch { /* ignore */ }
  }

  let imageDataUrl: string
  try {
    imageDataUrl = await readImageAsCompressedDataUrl(sb.firstFrameImage, {
      maxWidth: 1024,
      maxHeight: 1024,
      quality: 75,
    })
  } catch (e: any) {
    logTaskError('StoryboardEval', 'image-read', { storyboardId, error: e.message })
    throw new Error(`读取首帧失败：${e.message}`)
  }

  const config = await getTextConfig()
  const baseUrl = getTextChatCompletionsUrl(config)

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserPromptText(sb, intention) },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    logTaskError('StoryboardEval', 'llm-call', {
      storyboardId,
      status: resp.status,
      body: errText.slice(0, 300),
    })
    throw new Error(`评估模型调用失败 (${resp.status})：${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  const raw = data?.choices?.[0]?.message?.content?.trim()
  if (!raw) throw new Error('评估模型未返回内容')
  const scores = parseEvalJson(raw, storyboardId)

  db.update(schema.storyboards).set({
    evalScorePrompt: scores.prompt_adherence,
    evalScoreVisual: scores.visual_quality,
    evalScoreMotion: scores.motion_naturalness,
    evalScoreContinuity: scores.continuity,
    evalNotes: scores.notes,
    evaluatedAt: now(),
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, storyboardId)).run()

  logTaskSuccess('StoryboardEval', 'evaluate', {
    storyboardId,
    scores,
  })
  return scores
}

export function averageEvalScore(sb: { evalScorePrompt?: number | null; evalScoreVisual?: number | null; evalScoreMotion?: number | null; evalScoreContinuity?: number | null }): number | null {
  const values = [sb.evalScorePrompt, sb.evalScoreVisual, sb.evalScoreMotion, sb.evalScoreContinuity]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

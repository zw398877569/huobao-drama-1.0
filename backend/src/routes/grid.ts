import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { sanitizeImagePrompt } from '../utils/prompt-sanitizer.js'
import { splitGridImage } from '../services/grid-split.js'
import { createAgent } from '../agents/index.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
// ★ Sprint 27 Task A follow-up (PM msg-20261027-127): 格子分配的唯一实现
//   (原来 routes/grid.ts 和 agents/tools/grid-prompt-tools.ts 各有一份, 改一处漏一处 → 同一响应里自相矛盾)
import { normalizeGridLayout, buildFirstLastCellPlan } from '../utils/grid-layout.js'

const app = new Hono()

const POSITIONS = [
  'top-left', 'top-right', 'top-center',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

function posLabel(i: number, rows: number, cols: number) {
  const r = Math.floor(i / cols), c = i % cols
  return `row ${r + 1} col ${c + 1}`
}

function cellLabel(i: number, rows: number, cols: number) {
  return `格${i + 1}（${posLabel(i, rows, cols)}）`
}

function safeParseJsonArray(value: any): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function getStoryboardCharacterIds(storyboardIds: number[]) {
  if (!storyboardIds.length) return new Map<number, number[]>()
  const links = db.select().from(schema.storyboardCharacters).all()
    .filter((link) => storyboardIds.includes(link.storyboardId))
  const map = new Map<number, number[]>()
  for (const link of links) {
    const arr = map.get(link.storyboardId) || []
    arr.push(link.characterId)
    map.set(link.storyboardId, arr)
  }
  return map
}

function collectGridReferenceAssets(storyboards: any[]) {
  const storyboardIds = storyboards.map((sb) => sb.id)
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboardIds)
  const sceneIds = [...new Set(storyboards.map((sb) => sb.sceneId).filter(Boolean))]
  const characterIds = [...new Set([...storyboardCharacterIds.values()].flat().filter(Boolean))]

  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).all().filter((scene) => sceneIds.includes(scene.id))
    : []
  const characters = characterIds.length
    ? db.select().from(schema.characters).all().filter((char) => characterIds.includes(char.id))
    : []

  const assets: Array<{
    path: string
    label: string
    kind: 'scene' | 'character' | 'storyboard'
    sceneId?: number
    characterId?: number
    storyboardId?: number
  }> = []
  const seen = new Set<string>()
  const pushAsset = (
    path: string | null | undefined,
    label: string,
    kind: 'scene' | 'character' | 'storyboard',
    extra: { sceneId?: number; characterId?: number; storyboardId?: number } = {},
  ) => {
    if (!path || seen.has(path) || assets.length >= 6) return
    seen.add(path)
    assets.push({ path, label, kind, ...extra })
  }

  for (const sb of storyboards) {
    pushAsset(sb.firstFrameImage, `镜头${sb.storyboardNumber}首帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.lastFrameImage, `镜头${sb.storyboardNumber}尾帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.composedImage, `镜头${sb.storyboardNumber}镜头图`, 'storyboard', { storyboardId: sb.id })
    for (const ref of safeParseJsonArray(sb.referenceImages)) {
      pushAsset(ref, `镜头${sb.storyboardNumber}参考图`, 'storyboard', { storyboardId: sb.id })
    }
  }
  for (const scene of scenes) {
    pushAsset(scene.imageUrl, `${scene.location}${scene.time ? `（${scene.time}）` : ''}场景`, 'scene', { sceneId: scene.id })
  }
  for (const char of characters) {
    pushAsset(char.imageUrl, `${char.name}角色`, 'character', { characterId: char.id })
  }

  return assets.map((asset, index) => ({
    ...asset,
    imageIndex: index + 1,
    imageLabel: `图片${index + 1}`,
  }))
}

function buildReferenceLegend(referenceAssets: Array<{ imageLabel: string; label: string }>) {
  if (!referenceAssets.length) return ''
  return referenceAssets.map((asset) => `${asset.imageLabel}=${asset.label}`).join('；')
}

function buildStoryboardReferenceHints(
  sb: any,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string; sceneId?: number; characterId?: number; storyboardId?: number }>,
  storyboardCharacterIds: Map<number, number[]>,
) {
  const hints: string[] = []
  const charIds = storyboardCharacterIds.get(sb.id) || []

  for (const asset of referenceAssets) {
    if (asset.kind === 'scene' && sb.sceneId && asset.sceneId === sb.sceneId) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
    if (asset.kind === 'character') {
      if (asset.characterId && charIds.includes(asset.characterId)) {
        hints.push(`${asset.imageLabel}（${asset.label}）`)
      }
    }
    if (asset.kind === 'storyboard' && asset.storyboardId === sb.id) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
  }

  return [...new Set(hints)].slice(0, 4)
}

// Build prompt based on mode
function buildGridPrompt(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  dramaStyle: string,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
): string {
  const style = dramaStyle || 'cinematic'
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))
  const legend = buildReferenceLegend(referenceAssets)

  if (mode === 'first_frame') {
    // Each cell = one shot's first frame
    const cells = storyboards.map((sb, i) => {
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${i + 1}`
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      return `${cellLabel(i, rows, cols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}`
    })
    return [
      `${rows}x${cols} grid layout, consistent art style, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      '当画面涉及角色或场景时，优先使用对应的图片编号来约束一致性。',
      ...cells,
      'high quality, cinematic lighting, no text, no watermark',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'first_last') {
    // ★ Sprint 27 Task A: 每行 = 一个镜头的 首帧(左) + 尾帧(右) —— 原来是把格子序号当镜头索引 + 奇偶交替
    //   → 每镜头只拿 1 格, 镜头1 永远拿不到尾帧 (详见 normalizeGridLayout 的注释)。
    const plan = buildFirstLastCellPlan(rows, storyboards.length)
    const useRows = Math.max(...plan.map(p => p.row)) + 1
    const pairCols = 2
    const cells = plan.map((p) => {
      const sb = storyboards[p.shotIndex]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || p.shotIndex + 1}`
      const action = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      const frameHint = p.frameType === 'first_frame'
        ? 'opening moment'
        : `${action ? `${action}, ` : ''}closing moment, subtle motion change`
      return `${cellLabel(p.cellIndex, useRows, pairCols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}, ${frameHint}`
    })
    return [
      `${useRows}x${pairCols} grid layout, consistent art style, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      // ★ 文案跟着实现改: 原来写 'alternating opening and closing beats across the grid'
      //   (那描述的正是 bug 本身 —— 全格交替, 不是同行成对)
      'first/last frame visual rhythm: every row shows the OPENING moment on the left and the CLOSING moment on the right of the SAME shot,',
      ...cells,
      'continuous motion implied between the left and right cell of each row, high quality, no text',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'multi_ref') {
    // All cells are different angles/compositions of the same shot
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      'wide establishing shot', 'medium shot character focus',
      'close-up detail', 'dramatic low angle', 'over-the-shoulder view',
      'bird eye view', 'side profile', 'atmospheric detail',
      'extreme close-up', 'dutch angle', 'silhouette shot',
      'depth of field focus', 'symmetrical composition', 'leading lines',
      'negative space', 'high angle looking down', 'ground level',
      'panoramic wide', 'intimate two-shot', 'reflection shot',
      'shadow play', 'backlit silhouette', 'macro detail',
      'split lighting', 'rim light portrait',
    ]
    const totalCells = rows * cols
    const cells = Array.from({ length: totalCells }, (_, i) => {
      return `${cellLabel(i, rows, cols)}: ${legend ? `参考${legend}，` : ''}${desc}, ${angles[i % angles.length]}`
    })
    return [
      `${rows}x${cols} grid layout, same scene different angles and compositions, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      `main scene: ${desc},`,
      ...cells,
      'consistent lighting and color palette, high quality, no text',
    ].filter(Boolean).join('\n')
  }

  return `${rows}x${cols} grid, ${style}, storyboard frames, high quality`
}

function buildGridCellPrompts(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
) {
  if (!storyboards.length) return []
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))

  if (mode === 'multi_ref') {
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      'wide establishing shot', 'medium shot character focus',
      'close-up detail', 'dramatic low angle', 'over-the-shoulder view',
      'bird eye view', 'side profile', 'atmospheric detail',
      'extreme close-up', 'dutch angle', 'silhouette shot',
      'depth of field focus', 'symmetrical composition', 'leading lines',
      'negative space', 'high angle looking down', 'ground level',
      'panoramic wide', 'intimate two-shot', 'reflection shot',
      'shadow play', 'backlit silhouette', 'macro detail',
      'split lighting', 'rim light portrait',
    ]
    return Array.from({ length: rows * cols }, (_, i) => ({
      shot_number: sb.storyboardNumber,
      frame_type: 'reference',
      prompt: `${cellLabel(i, rows, cols)}: ${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).join('、')}${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).length ? '，' : ''}${desc}, ${angles[i % angles.length]}`,
    }))
  }

  if (mode === 'first_last') {
    // ★ Sprint 27 Task A: 每行 = 一个镜头的 首帧(左) + 尾帧(右)
    //   第 i 格 → 镜头索引 = floor(i / 2), 首帧 = 偶数格。详见 normalizeGridLayout 的注释。
    const plan = buildFirstLastCellPlan(rows, storyboards.length)
    const useRows = Math.max(...plan.map(p => p.row)) + 1
    const pairCols = 2
    return plan.map((p) => {
      const sb = storyboards[p.shotIndex]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
      const motion = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      return {
        shot_number: sb.storyboardNumber,
        frame_type: p.frameType,
        prompt: p.frameType === 'first_frame'
          ? `${cellLabel(p.cellIndex, useRows, pairCols)}，首帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}`
          : `${cellLabel(p.cellIndex, useRows, pairCols)}，尾帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${motion ? `, ${motion}` : ''}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}`,
      }
    })
  }

  return storyboards.slice(0, rows * cols).map((sb, index) => {
    const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
    const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
    return {
      shot_number: sb.storyboardNumber,
      frame_type: 'first_frame',
      prompt: `${cellLabel(index, rows, cols)}：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}, opening scene`,
    }
  })
}

function extractJsonCandidate(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const plain = text.match(/\{[\s\S]*\}/)
  return plain?.[0]?.trim() || ''
}

function normalizeGridPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return null
  const gridPrompt = typeof payload.grid_prompt === 'string'
    ? payload.grid_prompt.trim()
    : typeof payload.gridPrompt === 'string'
      ? payload.gridPrompt.trim()
      : ''
  const rawCells = Array.isArray(payload.cell_prompts)
    ? payload.cell_prompts
    : Array.isArray(payload.cellPrompts)
      ? payload.cellPrompts
      : []
  const cellPrompts = rawCells.map((cell: any) => ({
    shot_number: Number(cell?.shot_number ?? cell?.shotNumber ?? 0) || 0,
    frame_type: String(cell?.frame_type ?? cell?.frameType ?? 'first_frame'),
    prompt: String(cell?.prompt ?? '').trim(),
  })).filter((cell: any) => cell.prompt)

  if (!gridPrompt) return null
  return { grid_prompt: gridPrompt, cell_prompts: cellPrompts }
}

function findGridPayload(value: any): { grid_prompt: string; cell_prompts: any[] } | null {
  if (!value) return null

  const normalized = normalizeGridPayload(value)
  if (normalized) return normalized

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'null') return null
    try {
      const parsed = JSON.parse(trimmed)
      return findGridPayload(parsed)
    } catch {
      const candidate = extractJsonCandidate(trimmed)
      if (!candidate) return null
      try {
        return findGridPayload(JSON.parse(candidate))
      } catch {
        return null
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGridPayload(item)
      if (found) return found
    }
    return null
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const found = findGridPayload(nested)
      if (found) return found
    }
  }

  return null
}

async function tryAgentGridPrompt(
  episodeId: number,
  dramaId: number,
  storyboardIds: number[],
  rows: number,
  cols: number,
  mode: string,
  referenceLegend: string,
) {
  const agent = createAgent('grid_prompt_generator', episodeId, dramaId)
  if (!agent) return null

  const result = await agent.generate(
    [{
      role: 'user',
      content: [
        '请为宫格图生成提示词，并优先调用工具完成。',
        `选中镜头ID：${JSON.stringify(storyboardIds)}`,
        `行数：${rows}`,
        `列数：${cols}`,
        `模式：${mode}`,
        referenceLegend ? `参考图映射：${referenceLegend}` : '',
        '当提示词涉及到某个角色或场景时，直接把对应的图片编号写进提示词，例如：图片1中的角色A站了起来，图片3中的房间场景。不要只写名字，不写图片编号。',
        `必须严格按 ${rows}x${cols} 生成，总共 exactly ${rows * cols} visible panels。不要合并格子，不要缺格。`,
        '必须返回 JSON，结构为：{"grid_prompt":"...","cell_prompts":[{"shot_number":1,"frame_type":"first_frame","prompt":"..."}]}',
      ].join('\n'),
    }],
    { maxSteps: 10 },
  )

  const fromTools = findGridPayload(result.toolResults)
  if (fromTools) return fromTools

  const fromText = findGridPayload(result.text)
  if (fromText) return fromText

  return null
}

// POST /grid/prompt
app.post('/prompt', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    episode_id,
    rows,
    cols,
    mode = 'first_frame',
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  // ★ Sprint 27 Task A: first_last 模式固定 2 列 (每行一个镜头的首+尾), 行数 clamp 到实际镜头数
  const layout = normalizeGridLayout(mode, rows, cols, storyboards.length)
  const actualCols = layout.cols
  const actualRows = layout.rows
  if (layout.truncated) {
    logTaskWarn('GridPrompt', 'layout-truncated', {
      episodeId: Number(episode_id || 0),
      mode,
      requestedRows: rows,
      actualRows,
      storyboardCount: storyboard_ids.length,
      hint: '选中的镜头数超过当前布局能放下的数量, 只生成前 N 个 (前端会 toast 提示)',
    })
  }
  const resolvedEpisodeId = Number(episode_id || storyboards[0]?.episodeId || 0)
  const referenceAssets = collectGridReferenceAssets(storyboards)
  const referenceLegend = buildReferenceLegend(referenceAssets)

  if (!resolvedEpisodeId) {
    return badRequest(c, 'episode_id required')
  }

  try {
    const agentPayload = await tryAgentGridPrompt(
      resolvedEpisodeId,
      Number(drama_id || 0),
      storyboard_ids,
      actualRows,
      actualCols,
      mode,
      referenceLegend,
    )

    if (agentPayload?.grid_prompt) {
      logTaskProgress('GridPrompt', 'agent-success', {
        episodeId: resolvedEpisodeId,
        dramaId: drama_id,
        mode,
        rows: actualRows,
        cols: actualCols,
        storyboardCount: storyboard_ids.length,
      })
      logTaskPayload('GridPrompt', 'agent-result', agentPayload)
      return success(c, {
        ...agentPayload,
        source: 'agent',
        grid: { rows: actualRows, cols: actualCols },
        storyboard_ids,
        mode,
      })
    }
  } catch (err: any) {
    logTaskError('GridPrompt', 'agent-failed', {
      episodeId: resolvedEpisodeId,
      dramaId: drama_id,
      error: err.message,
    })
  }

  const gridPrompt = buildGridPrompt(mode, storyboards, actualRows, actualCols, dramaStyle, referenceAssets)
  const cellPrompts = buildGridCellPrompts(mode, storyboards, actualRows, actualCols, referenceAssets)
  logTaskProgress('GridPrompt', 'fallback-used', {
    episodeId: resolvedEpisodeId,
    dramaId: drama_id,
    mode,
    rows: actualRows,
    cols: actualCols,
    storyboardCount: storyboard_ids.length,
  })

  return success(c, {
    grid_prompt: gridPrompt,
    cell_prompts: cellPrompts,
    source: 'fallback',
    grid: { rows: actualRows, cols: actualCols },
    storyboard_ids,
    mode,
  })
})

// POST /grid/generate
app.post('/generate', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    rows,
    cols,
    mode = 'first_frame', // first_frame | first_last | multi_ref
    custom_prompt,
    // ★ Sprint 25 fix_2 (PM msg-20261027-127): 用户在宫格工具里选的生图模型配置
    //   不给 = 用 active 的默认生图配置 (跟原来行为一致)
    image_config_id,
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  // Get drama style
  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  const referenceAssets = collectGridReferenceAssets(storyboards)
  const rawPrompt = custom_prompt || buildGridPrompt(mode, storyboards, rows, cols, dramaStyle, referenceAssets)
  // grid prompt 也走安全改写(grid_prompt 由 LLM 拼出来,可能含残留敏感词)
  // Sprint 21: 接上 kind 机制 (grid 暂不改行为 —— QA fix_3 要求先调查影响面)
  const prompt = await sanitizeImagePrompt(rawPrompt, { kind: 'grid' })
  const referenceImages = referenceAssets.map((asset) => asset.path)

  // Size: 保持 16:9 单格比例,总尺寸按比例缩放到 ≤ 1920x1080(agnes 最大支持),
  // 否则 3x3 grid = 2880x1620 容易被 queue full 或尺寸超限拒绝
  const cellW = 960, cellH = 540
  // ★ Sprint 27 Task A: 与 /grid/prompt 用同一套归一 → 提示词的格子数 = 图的格子数 = 切图的格子数
  const layout = normalizeGridLayout(mode, rows, cols, storyboards.length)
  const actualCols = layout.cols
  const actualRows = layout.rows
  if (layout.truncated) {
    logTaskWarn('GridGenerate', 'layout-truncated', {
      dramaId: drama_id,
      mode,
      requestedRows: rows,
      actualRows,
      storyboardCount: storyboard_ids.length,
      hint: '选中的镜头数超过当前布局能放下的数量, 只生成前 N 个',
    })
  }
  const rawW = cellW * actualCols
  const rawH = cellH * actualRows
  const MAX_W = 1920, MAX_H = 1080
  const ratio = Math.min(MAX_W / rawW, MAX_H / rawH, 1)
  const finalW = Math.round(rawW * ratio)
  const finalH = Math.round(rawH * ratio)
  const size = `${finalW}x${finalH}`

  try {
    const genId = await generateImage({
      dramaId: drama_id,
      prompt,
      size,
      frameType: `grid_${mode}_${actualRows}x${actualCols}`,
      referenceImages,
      // ★ Sprint 25 fix_2: 真正把用户选的生图配置传下去 (之前没传 → 宫格永远用默认配置)
      configId: image_config_id ? Number(image_config_id) : undefined,
    })

    logTaskProgress('GridGenerate', 'reference-images', {
      dramaId: drama_id,
      mode,
      rows: actualRows,
      cols: actualCols,
      referenceCount: referenceImages.length,
    })
    // ★ Sprint 27 Task B (PM msg-20261020-122): 宫格生成请求的完整留痕
    //   原来只有 reference-images 一条 (不知道选了哪些镜头 / 宫格 prompt 全文 / 每格的分配)
    //   → 排查『这个格子画的是哪个镜头』完全没线索。用 logTaskPayload (格子多, 别用 progress 刷爆日志)。
    logTaskPayload('GridGenerate', 'grid-request', {
      dramaId: drama_id,
      mode,
      rows: actualRows,
      cols: actualCols,
      storyboard_ids: storyboard_ids,
      size,
      frameType: `grid_${mode}_${actualRows}x${actualCols}`,
      imageConfigId: image_config_id ? Number(image_config_id) : null,
      referenceImages,
      prompt,
      cellPrompts: buildGridCellPrompts(mode, storyboards, actualRows, actualCols, referenceAssets),
    })

    return success(c, {
      image_generation_id: genId,
      grid: { rows: actualRows, cols: actualCols },
      mode,
      storyboard_ids,
      prompt,
      reference_images: referenceImages,
    })
  } catch (err: any) {
    // ★ Sprint 27 Task B: 失败路径也要留痕 (原来直接 return badRequest, 零日志)
    logTaskError('GridGenerate', 'generate-failed', {
      dramaId: drama_id,
      mode,
      rows: actualRows,
      cols: actualCols,
      storyboard_ids: storyboard_ids,
      error: err?.message || String(err),
    })
    return badRequest(c, err.message)
  }
})

// POST /grid/split
app.post('/split', async (c) => {
  const body = await c.req.json()
  const {
    image_generation_id,
    rows,
    cols,
    assignments, // [{storyboard_id, frame_type: 'first_frame'|'last_frame'|'reference'}]
  } = body

  if (!image_generation_id) return badRequest(c, 'image_generation_id required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')
  if (!assignments?.length) return badRequest(c, 'assignments required')

  const [imgRecord] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, image_generation_id)).all()

  if (!imgRecord) return badRequest(c, 'Image generation not found')
  if (imgRecord.status !== 'completed') return badRequest(c, `Image status: ${imgRecord.status}`)
  if (!imgRecord.localPath) return badRequest(c, 'No local image file')

  // ★ Sprint 27 Task B: 宫格图的几何形状以【实际生成的图】为准 ——
  //   generate 时把布局写进了 frameType (grid_<mode>_<rows>x<cols>), 请求里的 rows/cols 只是前端记的。
  //   两者不一致时按实际图切, 否则会切错格子 (格子错位 = 帧贴到错的镜头上)。
  const ftMatch = /^grid_([a-z_]+)_(\d+)x(\d+)$/.exec(imgRecord.frameType || '')
  const actualMode = ftMatch ? ftMatch[1] : ''
  const actualRows = ftMatch ? Number(ftMatch[2]) : rows
  const actualCols = ftMatch ? Number(ftMatch[3]) : cols
  if (ftMatch && (actualRows !== rows || actualCols !== cols)) {
    logTaskWarn('GridSplit', 'layout-mismatch', {
      image_generation_id,
      requested: { rows, cols },
      actual: { rows: actualRows, cols: actualCols },
      hint: '请求的行列数与实际生成的宫格图不一致, 已按实际图的布局切图',
    })
  }

  try {
    const cells = await splitGridImage(imgRecord.localPath, actualRows, actualCols)

    // 查一次分镜号, 让日志能直接看出"哪个格子给了哪个镜头的哪一帧"
    const sbIds = assignments.map((a: any) => a?.storyboard_id).filter(Boolean)
    const sbRows = sbIds.length
      ? db.select({ id: schema.storyboards.id, storyboardNumber: schema.storyboards.storyboardNumber })
        .from(schema.storyboards).all().filter((r: any) => sbIds.includes(r.id))
      : []
    const sbNumberById = new Map(sbRows.map((r: any) => [r.id, r.storyboardNumber]))

    const results: any[] = []
    for (let i = 0; i < assignments.length && i < cells.length; i++) {
      const { storyboard_id, frame_type } = assignments[i]
      const cell = cells[i]
      if (!storyboard_id) continue

      const update: Record<string, any> = { updatedAt: now() }
      if (frame_type === 'first_frame') update.firstFrameImage = cell.localPath
      else if (frame_type === 'last_frame') update.lastFrameImage = cell.localPath
      else if (frame_type === 'reference') {
        const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
        const existing = sb?.referenceImages ? JSON.parse(sb.referenceImages) : []
        existing.push(cell.localPath)
        update.referenceImages = JSON.stringify(existing)
      }

      db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, storyboard_id)).run()
      results.push({
        cell_index: i,
        pos: `${Math.floor(i / actualCols)},${i % actualCols}`,
        storyboard_id,
        storyboard_number: sbNumberById.get(storyboard_id) ?? null,
        frame_type,
        local_path: cell.localPath,
      })
    }

    // ★ Sprint 27 Task B: 宫格链路唯一缺失的追溯能力 ——
    //   『哪个格子 → 哪个镜头 → 首帧还是尾帧 → 落到哪个文件』。
    //   原来 /grid/split 零日志, 出了问题只能靠猜 (这正是 PM 派这单的原因)。
    //   用 logTaskPayload (十几条格子映射, 用 progress 会把日志刷爆)。
    logTaskPayload('GridSplit', 'cell-assignment', {
      image_generation_id,
      rows: actualRows,
      cols: actualCols,
      mode: actualMode,
      assignments: assignments.map((a: any, i: number) => ({
        cellIndex: i,
        pos: `${Math.floor(i / actualCols)},${i % actualCols}`,
        storyboardId: a?.storyboard_id ?? null,
        storyboardNumber: a?.storyboard_id ? (sbNumberById.get(a.storyboard_id) ?? null) : null,
        frameType: a?.frame_type ?? null,
      })),
      results,
    })
    // 汇总一条: 一眼看出切了几张首帧/尾帧/参考图
    const assigned = {
      count: results.length,
      firstFrames: results.filter((r: any) => r.frame_type === 'first_frame').length,
      lastFrames: results.filter((r: any) => r.frame_type === 'last_frame').length,
      references: results.filter((r: any) => r.frame_type === 'reference').length,
    }
    logTaskProgress('GridSplit', 'assigned', { image_generation_id, ...assigned })

    return success(c, { cells: results })
  } catch (err: any) {
    // ★ Sprint 27 Task B: 切图失败也要留痕 (原来直接 return badRequest, 零日志)
    logTaskError('GridSplit', 'split-failed', {
      image_generation_id,
      rows: actualRows,
      cols: actualCols,
      error: err?.message || String(err),
    })
    return badRequest(c, err.message)
  }
})

// GET /grid/status/:id
app.get('/status/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!row) return badRequest(c, 'Not found')
  return success(c, {
    id: row.id,
    status: row.status,
    local_path: row.localPath,
    image_url: row.imageUrl,
    error_msg: row.errorMsg,
  })
})

export default app

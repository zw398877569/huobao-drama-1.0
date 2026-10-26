#!/usr/bin/env node
/**
 * Sprint 23 Task E (PM msg-20261027-095): H3 模板 vs 通用模板 对照。
 *
 * 三种模式:
 *   --mode offline   离线对照 (默认): 用本地 golden 数据 (ep15 的真实 step2 输出) + 手工构造的
 *                     H3 step2 样本 → 跑两种 assemble/inject → 出对照表。零 API 成本, 立刻能跑。
 *                     ⚠️ 手工构造的 H3 样本【不是 LLM 产物】→ 这一层只证明组装/注入机制, 不证明 LLM 会这么写。
 *   --mode prompt    真机 prompt 层对照: 同一 episode 用两种模板各拆解一次 → 对照 video_prompt 结构。
 *                     ★ 破坏性: 拆解会重建分镜 (DELETE+INSERT) —— 需要用户部署后跑。
 *   --mode video     成片层对照: shot 16/17/18 三镜 × 2 模板 = 6 个视频 + 6 次合成。
 *                     需要用户部署后跑 (会消耗生图/视频额度)。
 *
 * 用法:
 *   node backend/scripts/h3-compare.mjs --mode offline
 *   node backend/scripts/h3-compare.mjs --mode prompt --base http://192.168.3.48:5679 --drama 15 --episode 15
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'node:module'

// .mjs 是 ESM, 但模板 bundle 是 CJS → 用 createRequire 加载
const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const MODE = arg('mode', 'offline')
const BASE = arg('base', 'http://192.168.3.48:5679')
const DRAMA = Number(arg('drama', '15'))
const EPISODE = Number(arg('episode', '15'))
const GOLDEN = arg('golden', '/tmp/golden')

// ── 载入模板 (走编译好的 bundle, 避免拉 db 依赖) ──
function loadTemplates() {
  const bundle = path.join('/tmp', 'h3-compare-templates.cjs')
  if (!fs.existsSync(bundle)) {
    console.error('缺少 /tmp/h3-compare-templates.cjs —— 先跑:')
    console.error('  cd backend && npx esbuild src/prompt-templates/minimax-h3.ts --bundle --format=cjs --platform=node --define:import.meta.url=\'"file:///tmp/bundle.cjs"\' --outfile=/tmp/h3-compare-templates.cjs')
    process.exit(1)
  }
  return require(bundle)
}

function line(s = '') { console.log(s) }

function table(rows) {
  const head = Object.keys(rows[0])
  const w = head.map(h => Math.max(h.length, ...rows.map(r => String(r[h]).length)))
  line('| ' + head.map((h, i) => h.padEnd(w[i])).join(' | ') + ' |')
  line('|' + w.map(x => '-'.repeat(x)).join('|') + '|')
  for (const r of rows) line('| ' + head.map((h, i) => String(r[h]).padEnd(w[i])).join(' | ') + ' |')
}

// ── 离线对照 ──────────────────────────────────────────────────────────────
function offline() {
  const { generalTemplate, minimaxH3Template } = loadTemplates()
  const details = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'step2_details.json'), 'utf8'))
  const chars = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'characters.json'), 'utf8'))
  const characters = chars
    .map(c => ({ id: c.id, name: c.name, appearancePermanent: c.appearance_permanent || '', personality: c.personality || '', role: c.role || '' }))
    .sort((a, b) => a.id - b.id)

  const real = details.find(d => d.shot_number === 17)
  // 手工构造的 H3 step2 样本 (⚠️ 不是 LLM 产物, 只是让 assemble/inject 有输入可跑)
  const h3Shot = {
    ...real,
    subject_definitions: '<Subject 1> is Lin Da, the young delivery rider, derived from <Picture 1>, preserving his square face and short black hair.',
    detailed_description: '[Shot 1] The cramped studio apartment opens on the old wooden table under a warm bulb, rain running down the window, Lin Da half-rises from the stool.',
    overall_soundscape: 'Continuous rain outside, the hum of an indoor incandescent bulb, a faint dripping pipe.',
    non_diegetic_music: 'A restrained solo cello at a very slow tempo, with no swell.',
  }
  const cleanedPermanent = { imagePromptPermanent: real.image_prompt_permanent, plotState: '' }

  const gOut = generalTemplate.assemble({ shot: real, prevShot: null, dialogue: '', characters, cleanedPermanent })
  const hOut = minimaxH3Template.assemble({ shot: h3Shot, prevShot: null, dialogue: '', characters, cleanedPermanent })

  const tts = [
    { speaker: '林达', text: '您……您姓什么？' },
    { speaker: '王秀兰', text: '王秀兰，八三年的。' },
  ]
  const gFin = generalTemplate.generation.inject({ prompt: gOut.videoPrompt, referenceImageMode: 'ref2v-picture-1', ttsSegments: tts, characters })
  const hFin = minimaxH3Template.generation.inject({
    prompt: hOut.videoPrompt, referenceImageMode: 'ref2v-picture-1',
    ttsSegments: tts, characters, previousResult: '林达的手停在筷子上，视线落在王秀兰脸上',
  })

  line('# Sprint 23 Task E — prompt 层对照 (离线模式)')
  line('')
  line('> ⚠️ H3 那一列的 step2 输出是【手工构造的样本】(不是 LLM 产物) → 这一层只验证')
  line('> assemble/inject 的机制, 不证明 LLM 真会这么写。真机对照要等部署后跑 `--mode prompt`。')
  line('')
  line('## 1. video_prompt 结构')
  line('')
  table([
    { 维度: '段数', 通用模板: '3 段 (permanent+description+plot_state)', H3模板: '4 段 (官方 Ref2VA 减 summary/retention_analysis)' },
    { 维度: '三段式 header', 通用模板: 'Integrated/Overall soundscape/Non-diegetic music', H3模板: 'subject_definitions/detailed_description/overall_soundscape/non_diegetic_music' },
    { 维度: '台词标记', 通用模板: "<n>0-3.9秒：开口:'…'</n> (Sprint15/16 注入)", H3模板: '<Subject N> (Sx) says, <d>[Chinese]…</d>' },
    { 维度: '台词时间轴开关', 通用模板: 'useDialogueTimeline=true', H3模板: 'useDialogueTimeline=false (官方 #6 要求保持原语言)' },
    { 维度: '角色外貌', 通用模板: '注入块「角色外观(跨镜头保持一致)」', H3模板: '写进 <Subject N> 定义 (官方落地方式)' },
    { 维度: '首帧锚点', 通用模板: 'opening frame matches [Picture 1]', H3模板: '同一句, 放进 detailed_description 内部' },
    { 维度: '承接上一镜', 通用模板: '注入块「承接前一镜」', H3模板: 'Continues from the closing state of the previous shot: "…"' },
    { 维度: '限制项', 通用模板: '无 (只有抽象词/拼接指令的清洗)', H3模板: '独立末段 (官方原版)' },
    { 维度: '长度', 通用模板: `${gFin.length} 字符`, H3模板: `${hFin.length} 字符` },
  ])
  line('')
  line('## 2. 通用模板最终 prompt (全文)')
  line('')
  line('```')
  line(gFin)
  line('```')
  line('')
  line('## 3. H3 模板最终 prompt (全文)')
  line('')
  line('```')
  line(hFin)
  line('```')
  line('')
  line('## 4. 编号一致性 / 台词逐字')
  line('')
  const sxy = (s) => [...s.matchAll(/\(S(\d+)\)/g)].map(m => m[1])
  const subj = (s) => [...s.matchAll(/<Subject (\d+)>/g)].map(m => m[1])
  table([
    { 检查: '出现的 (Sx)', 通用模板: sxy(gFin).join(',') || '—', H3模板: sxy(hFin).join(',') || '—' },
    { 检查: '出现的 <Subject N>', 通用模板: subj(gFin).join(',') || '—', H3模板: subj(hFin).join(',') || '—' },
    { 检查: '台词原文逐字保留', 通用模板: gFin.includes('您……您姓什么？') ? '是' : '否', H3模板: hFin.includes('您...您姓什么？') ? '是 (仅标点按官方归一)' : '否' },
    { 检查: '有中文引号残留', 通用模板: /[“”]/.test(gFin) ? '是' : '否', H3模板: /[“”]/.test(hFin) ? '是' : '否' },
  ])
  line('')
  line('> 编号说明: <Subject N> / (Sx) 都按【episode 内角色按 characters.id 升序】分配,')
  line('> 跨镜跨集都不换 (官方 #7 Speaker ID 规则 + 工单决策)。')
}

// ── 真机 prompt 层对照 (需要部署后) ───────────────────────────────────────
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, json: j }
}

async function runPrompt() {
  const results = {}
  for (const tpl of ['general', 'minimax-h3']) {
    line(`▶ 用模板 ${tpl} 拆解 ep${EPISODE} (会重建分镜!)`)
    const r1 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step1', { drama_id: DRAMA, episode_id: EPISODE, template_id: tpl })
    if (r1.status !== 200) { line(`  ✗ step1 失败: ${JSON.stringify(r1.json).slice(0, 200)}`); return }
    const plan = r1.json?.data?.shot_plan ?? []
    const r2 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step2', { drama_id: DRAMA, episode_id: EPISODE, shot_plan: plan, template_id: tpl })
    const details = r2.json?.data?.shot_details ?? []
    const r3 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step3', { drama_id: DRAMA, episode_id: EPISODE, shot_details: details, template_id: tpl })
    results[tpl] = { plan, details, created: r3.json?.data?.createdStoryboardIds ?? [] }
    line(`  ✓ ${tpl}: ${details.length} 镜, 落库 ${results[tpl].created.length} 条`)
  }
  fs.writeFileSync('/tmp/h3-compare-prompt.json', JSON.stringify(results, null, 1))
  line('\n已写 /tmp/h3-compare-prompt.json —— 两种模板的完整 step2/step3 产物')
  line('结构对照请看 /tmp/h3-compare-prompt.json, 或用 prompt-regression 脚本判结构断言')
}

if (MODE === 'offline') offline()
else if (MODE === 'prompt') await runPrompt()
else { line(`未知 --mode ${MODE} (offline | prompt | video)`); process.exit(1) }

#!/usr/bin/env node
/**
 * Sprint 22 Task B (PM msg-20261025-089): prompt 全链路回归脚本
 *
 * 固定 5 个样本, 每个样本做两件事:
 *   ① 触发生成 (拆解 / 生图 / 视频)
 *   ② 从 flow-log 里把这次调用的【原始证据】捞出来, 自动判定 prompt 层的 pass/fail
 *
 * 视觉层的判定 (画面里有没有人 / 背景是不是中性 / 长相一不一致) 脚本判不了,
 * 输出到报告里由人/QA 抽帧确认 —— 见 prompt-regression-checklist.md。
 *
 * 用法:
 *   node backend/scripts/prompt-regression.mjs --samples S2,S3
 *   node backend/scripts/prompt-regression.mjs --samples all --no-trigger   # 只查已有日志
 *
 * 参数:
 *   --base      后端地址            默认 http://192.168.3.48:5679
 *   --flowlog   flow-log 根目录     默认 /Volumes/aicg1.0/data/flow-logs
 *   --drama     drama id            默认 15
 *   --episode   episode id          默认 15
 *   --samples   逗号分隔 / all      默认 all
 *   --no-trigger 只读日志不触发     (用于复跑判定)
 *   --out       报告输出路径        默认 stdout
 */
import fs from 'fs'
import path from 'path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)

const BASE = arg('base', 'http://192.168.3.48:5679')
const FLOWLOG = arg('flowlog', '/Volumes/aicg1.0/data/flow-logs')
const DRAMA = Number(arg('drama', '15'))
const EPISODE = Number(arg('episode', '15'))
const SAMPLES = arg('samples', 'all')
const NO_TRIGGER = has('no-trigger')
const OUT = arg('out', '')

const results = []
function record(sample, item, pass, detail) {
  results.push({ sample, item, pass, detail })
  console.log(`${pass ? '✓' : '✗'} [${sample}] ${item}${detail ? ' — ' + detail : ''}`)
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const traceId = res.headers.get('x-trace-id') || ''
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, json, traceId }
}

/** 从 flow-log 里捞一条 trace 的全部记录 */
function readFlowLog(traceId) {
  if (!traceId) return []
  const dirs = fs.readdirSync(FLOWLOG).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  for (const d of dirs.slice(-3)) {
    const f = path.join(FLOWLOG, d, `flow-${traceId}.jsonl`)
    if (!fs.existsSync(f)) continue
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  }
  return []
}
const pick = (logs, scope, action) => logs.find((l) => l.scope === scope && l.action === action)
const meta = (logs, scope, action) => pick(logs, scope, action)?.meta || null

// ── 通用断言 ──────────────────────────────────────────────────────────────
const hasAll = (text, words) => words.every((w) => text.includes(w))
const hasAny = (text, words) => words.some((w) => text.includes(w))
/** 人物词 —— 场景图里出现这些就是"编出人物"的信号 */
const PERSON_WORDS = ['woman', ' man', 'man ', 'person', 'someone', 'girl', 'boy', 'eating', 'sitting', 'standing at', 'holding a']

/** rule F 生效的判据: 输出长度应接近输入, 不该被压到 240 */
function checkLengthRule(sample, inLen, outLen) {
  if (!inLen || !outLen) { record(sample, 'rule F 长度判定', false, '缺 inLen/outLen'); return }
  const ratio = outLen / inLen
  record(sample, 'rule F: 输出未被压到 240 字符', outLen > 240, `inLen=${inLen} outLen=${outLen} (压缩到 ${Math.round(ratio * 100)}%)`)
  record(sample, 'rule F: 输出长度接近输入 (0.6~1.6 倍)', ratio >= 0.6 && ratio <= 1.6, `${ratio.toFixed(2)}x`)
}

// ── S1 拆解 ───────────────────────────────────────────────────────────────
async function sampleS1() {
  const S = 'S1 拆解'
  if (NO_TRIGGER) { record(S, '跳过 (--no-trigger)', true); return }
  const r1 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step1', { drama_id: DRAMA, episode_id: EPISODE })
  if (r1.status !== 200) { record(S, 'step1 拆解', false, `HTTP ${r1.status}`); return }
  const plan = r1.json?.data?.shot_plan || []
  record(S, 'step1 返回 shot_plan', plan.length > 0, `${plan.length} 镜`)

  const r2 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step2', { drama_id: DRAMA, episode_id: EPISODE, shot_plan: plan })
  const details = r2.json?.data?.shot_details || []
  record(S, 'step2 返回 shot_details', details.length > 0, `${details.length} 镜`)
  if (!details.length) return

  // scene_id 单调不减
  const scenes = details.map((d) => d.scene_id)
  const monotonic = scenes.every((v, i) => i === 0 || v >= scenes[i - 1])
  record(S, 'scene_id 单调不减', monotonic, scenes.join(','))

  // duration 分布
  const durs = details.map((d) => d.duration || 0)
  record(S, 'duration 分布合理 (4~15s)', durs.every((d) => d >= 4 && d <= 15),
    `min=${Math.min(...durs)} max=${Math.max(...durs)} avg=${Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)}`)

  // 多角色 dialogue 被规范化成多行
  const multi = details.filter((d) => (d.dialogue || '').split(/：|:/).length - 1 >= 2)
  const multiOk = multi.filter((d) => (d.dialogue || '').includes('\n'))
  record(S, '多角色 dialogue 已规范化成多行', multi.length === 0 || multiOk.length === multi.length,
    `${multiOk.length}/${multi.length} 条多角色 dialogue 含换行`)

  // video_prompt 结构 (从 flow-log 的 planner 日志拿不到, 用 step3 后再查)
  const r3 = await api('POST', '/api/v1/agent/storyboard_breaker/planning/step3', { drama_id: DRAMA, episode_id: EPISODE, shot_details: details })
  const ids = r3.json?.data?.createdStoryboardIds || []
  record(S, 'step3 落库', ids.length > 0, `写入 ${ids.length} 个 storyboard`)
  const logs = readFlowLog(r3.traceId)
  const vp = meta(logs, 'StoryboardPlanner', 'step3-done')
  record(S, 'step3 有 duration-policy 日志', !!vp, vp ? `converged=${vp.convergedTotal}` : '未找到')
}

// ── 生图样本 (S2 角色 / S3 场景 / S4 道具) ─────────────────────────────────
async function sampleImage(sample, kind, id, label, extra) {
  const logs0 = []
  let traceId = ''
  if (!NO_TRIGGER) {
    const r = await api('POST', `/api/v1/${kind}/${id}/generate-image`, { episode_id: EPISODE })
    traceId = r.traceId
    record(sample, `${label} 生图请求已发出`, r.status >= 200 && r.status < 300, `HTTP ${r.status} trace=${traceId || 'n/a'}`)
    if (r.status !== 200) return
  }
  // 生成是异步的, 日志可能要等一会儿
  let logs = []
  for (let i = 0; i < 30; i++) {
    logs = readFlowLog(traceId)
    if (logs.length) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!logs.length) { record(sample, 'flow-log 找到本次调用', false, '30 次轮询都没找到 (生成可能还没跑)'); return }
  const rw = meta(logs, 'PromptSanitizer', 'llm-rewrite-success')
  if (rw) {
    checkLengthRule(sample, rw.inLen, rw.outLen)
    record(sample, 'LLM 改写成功 (没走 fallback)', true, `outLen=${rw.outLen}`)
    const text = rw.rewritten || ''
    if (extra?.mustKeep) record(sample, `改写保留关键元素 ${JSON.stringify(extra.mustKeep)}`, hasAll(text, extra.mustKeep),
      extra.mustKeep.filter((w) => !text.includes(w)).join(','))
    if (extra?.mustNotHave) record(sample, `改写不含 ${JSON.stringify(extra.mustNotHave)}`, !hasAny(text, extra.mustNotHave),
      extra.mustNotHave.filter((w) => text.includes(w)).join(','))
    if (extra?.forbidPeople) record(sample, '改写里没有人物词', !hasAny(text, PERSON_WORDS),
      PERSON_WORDS.filter((w) => text.includes(w)).join(','))
  } else {
    const empty = meta(logs, 'PromptSanitizer', 'llm-rewrite-empty')
    const allFail = meta(logs, 'PromptSanitizer', 'all-configs-failed')
    record(sample, 'LLM 改写成功 (没走 fallback)', false,
      empty ? `empty (finishReason=${empty.finishReason} reasoningLen=${empty.reasoningLen})` : (allFail ? 'all-configs-failed' : '没找到改写日志'))
  }
  // 最终发给平台的 prompt
  // 生图的 prompt 在 meta.payload 里 (不是 meta.prompt) —— 'ImageTask/enqueue params' 的 meta 只有 payload
  const enq = meta(logs, 'ImageTask', 'enqueue params') || meta(logs, 'ImageTask', 'enqueue')
    || meta(logs, 'ImageTask', 'request') || meta(logs, 'ImageTask', 'request payload')
  const finalPrompt = enq?.payload?.prompt || enq?.prompt || enq?.params?.prompt || ''
  if (finalPrompt) {
    record(sample, '最终 prompt 长度未超上限', finalPrompt.length < 10000, `${finalPrompt.length} 字符`)
    if (extra?.finalMustHave) record(sample, `最终 prompt 含 ${JSON.stringify(extra.finalMustHave)}`, hasAll(finalPrompt, extra.finalMustHave),
      extra.finalMustHave.filter((w) => !finalPrompt.includes(w)).join(','))
  } else {
    record(sample, '拿到最终 prompt', false, 'flow-log 里没找到 ImageTask 的 prompt (生图可能还没排队)')
  }
  return { logs, finalPrompt }
}

// ── S5 视频 ───────────────────────────────────────────────────────────────
async function sampleS5(shotNumbers) {
  const S = 'S5 视频三连镜'
  const sbs = (await api('GET', `/api/v1/episodes/${EPISODE}/storyboards`)).json?.data || []
  const list = Array.isArray(sbs) ? sbs : (sbs.items || sbs.storyboards || [])
  const targets = list.filter((sb) => shotNumbers.includes(sb.storyboard_number || sb.storyboardNumber))
  if (!targets.length) { record(S, '找到目标镜头', false, `shot ${shotNumbers.join('/')} 不在 ep${EPISODE}`); return }
  record(S, '找到目标镜头', true, targets.map((t) => t.id).join(','))

  for (const sb of targets) {
    const num = sb.storyboard_number || sb.storyboardNumber
    // ★ 注入块断言对【存储的中文 video_prompt】做 —— 翻译后的英文措辞每次不一样
    //   (实测见过 'Continuity from the previous shot' 和 'Continuation from the previous shot' 两种),
    //   对中文标记断言才稳定。
    const stored = sb.video_prompt || sb.videoPrompt || ''
    const prevSb = list.find((x) => (x.storyboard_number || x.storyboardNumber) === num - 1)
    const sameScene = prevSb && prevSb.scene_id === sb.scene_id
    const hasDialogue = (sb.dialogue || '').trim().length > 0
    const hasResult = (sb.result || '').trim().length > 0
    record(S, `镜头#${num} 存储prompt 有角色外观块`, stored.includes('角色外观'), '')
    record(S, `镜头#${num} 有戏型节奏块`, /节奏:/.test(stored), '')
    if (sameScene) record(S, `镜头#${num} 同场景 → 有承接前一镜块`, stored.includes('承接前一镜'), `上一镜 #${num-1} scene=${sb.scene_id}`)
    else record(S, `镜头#${num} 场景首镜 → 无承接前一镜块(预期)`, !stored.includes('承接前一镜'), `scene=${sb.scene_id}`)
    if (hasResult) record(S, `镜头#${num} 有本镜收尾块`, stored.includes('本镜收尾'), '')
    else record(S, `镜头#${num} 无 result → 无本镜收尾块(预期)`, !stored.includes('本镜收尾'), '')

    const r = await api('POST', '/api/v1/videos', {
      storyboard_id: sb.id, drama_id: DRAMA, prompt: stored,
      reference_mode: 'first_frame', aspect_ratio: '9:16',
    })
    record(S, `镜头#${num} 视频请求已发出`, r.status >= 200 && r.status < 300, `HTTP ${r.status}`)
    // 视频生成是异步的, flow-log 要等一会儿才有
    let logs = []
    for (let i = 0; i < 30; i++) {
      logs = readFlowLog(r.traceId)
      if (logs.length) break
      await new Promise((x) => setTimeout(x, 2000))
    }
    const req = meta(logs, 'VideoTask', 'request')
    if (!req) { record(S, `镜头#${num} 拿到 VideoTask/request`, false, '没找到 (可能还在排队)'); continue }
    const p = req.prompt || ''
    record(S, `镜头#${num} 三段式 header 齐全`, hasAll(p, ['Integrated multimodal description', 'Overall soundscape', 'Non-diegetic music']), '')
    if (hasDialogue) record(S, `镜头#${num} 台词时间轴在`, /开口:'/.test(p), '')
    else record(S, `镜头#${num} 无台词 → 无时间轴(预期)`, !/开口:'/.test(p), '')
    record(S, `镜头#${num} prompt 长度 < 10000`, p.length < 10000, `${p.length} 字符`)
    // 翻译器偶发加 markdown 前缀 (### Overall soundscape:) —— H3 的 header 规范不带 ##
    if (/^#{1,6}\s*(Integrated|Overall|Non-diegetic)/m.test(p)) {
      record(S, `镜头#${num} 三段式 header 没被翻译器加 markdown 前缀`, false, '出现了 "### header" —— 翻译器偶发加的, 建议加代码层归一化')
    }
}
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const want = (id) => SAMPLES === 'all' || SAMPLES.split(',').map((s) => s.trim()).includes(id)

;(async () => {
  console.log(`# prompt 全链路回归报告\n`)
  console.log(`- 时间: ${new Date().toISOString()}`)
  console.log(`- 后端: ${BASE} | drama=${DRAMA} episode=${EPISODE}`)
  console.log(`- 样本: ${SAMPLES} | 模式: ${NO_TRIGGER ? '只读日志' : '触发+判定'}\n`)

  if (want('S1')) await sampleS1()
  if (want('S2')) await sampleImage('S2 角色图', 'characters', 44, '林达', {
    mustKeep: ['raincoat'], finalMustHave: ['no outdoor scenery'],
  })
  if (want('S3')) await sampleImage('S3 场景图', 'scenes', 48, '五零一室内', {
    mustKeep: ['noodle'], forbidPeople: true, finalMustHave: ['no people'],
  })
  if (want('S4')) {
    // S4 用【角色网格图】(grid): episode 15 没有道具 (props 为空), 而 grid 正好覆盖
    // grid_prompt_generator 这个 agent —— 它的 max_tokens 原本是 4096 (thinking 常态 2400+ 时会 content 空),
    // 是体检报告里点名的两个配置级定时炸弹之一, 用户改完 8192 后这里才有意义。
    const sbs = (await api('GET', `/api/v1/episodes/${EPISODE}/storyboards`)).json?.data || []
    const list = Array.isArray(sbs) ? sbs : (sbs.items || sbs.storyboards || [])
    const ids3 = list.filter((sb) => [16, 17, 18].includes(sb.storyboard_number || sb.storyboardNumber)).map((sb) => sb.id)
    if (!ids3.length) { record('S4 网格图', '找到 3 个目标镜头', false, 'ep' + EPISODE + ' 没有 16/17/18') }
    else {
      const r = await api('POST', '/api/v1/grid/generate', {
        storyboard_ids: ids3, drama_id: DRAMA, rows: 1, cols: 3, mode: 'first_frame',
      })
      record('S4 网格图', '网格图请求已发出', r.status === 200, `HTTP ${r.status} trace=${r.traceId || 'n/a'}`)
      const logs = []
      for (let i = 0; i < 30; i++) {
        const l = readFlowLog(r.traceId)
        if (l.length) { logs.push(...l); break }
        await new Promise((x) => setTimeout(x, 2000))
      }
      const rw = meta(logs, 'PromptSanitizer', 'llm-rewrite-success')
      if (rw) {
        checkLengthRule('S4 网格图', rw.inLen, rw.outLen)
        record('S4 网格图', 'LLM 改写成功 (没走 fallback)', true, `outLen=${rw.outLen}`)
      } else {
        record('S4 网格图', 'LLM 改写成功 (没走 fallback)', false, '没找到改写日志 (可能走 fallback 或还没跑)')
      }
    }
  }
  if (want('S5')) await sampleS5([16, 17, 18])

  const pass = results.filter((r) => r.pass).length
  const fail = results.filter((r) => !r.pass).length
  const report = [
    '',
    '## 汇总',
    `- 通过 ${pass} / ${results.length}`,
    `- 失败 ${fail}`,
    '',
    '| 样本 | 项 | 判定 | 细节 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.sample} | ${r.item} | ${r.pass ? '✅' : '❌'} | ${String(r.detail || '').replace(/\|/g, '/')} |`),
    '',
    '## 视觉层判定 (需抽帧人工确认)',
    '- [ ] S2 角色图: 背景中性/纯色 (不是户外院子/街道) + 写实 (不是 FLAT VECTOR 线稿) + 脸型发型服装跟立绘一致',
    '- [ ] S3 场景图: **画面里没有任何人物** + "冒热气的面碗" 还在 (不是"有人在吃面")',
    '- [ ] S4 道具图: 静物, 没有多余的人物',
    '- [ ] S5 三连镜: 人物长相跨镜一致 + 画面位置接得上 + 台词时间轴在',
    '',
  ].join('\n')
  console.log(report)
  if (OUT) { fs.writeFileSync(OUT, report); console.log(`\n报告已写入 ${OUT}`) }
  process.exit(fail > 0 ? 1 : 0)
})()

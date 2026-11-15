#!/usr/bin/env node
/**
 * ★ Sprint 47 T8 (PM msg-20261115-188): 从【AutoDL 工作流档案】同步各工作流的时长上限
 *
 * 【为什么要有这个脚本】
 *   工单要求: "上限数据要有出处 (知识库里的 AutoDL 工作流档案是事实来源), 不要把数字散落在代码里硬写"
 *   + "上限清单要能从工作流档案同步过来 —— 平台上下架/改上限时不用改代码"。
 *
 *   事实来源: ~/Obsidian/ComfyUi/autodl-workflows-auto.md (cron 每日从 autodl.art 公开 API 同步)
 *   产物:     backend/src/constants/workflow-duration-limits.ts (★ 提交进仓库 → 容器里不用带知识库)
 *
 * 【用法】
 *   node scripts/sync-workflow-duration-limits.js                    # 默认档案路径
 *   node scripts/sync-workflow-duration-limits.js <档案.md>            # 指定档案
 *   node scripts/sync-workflow-duration-limits.js --check              # 只校验产物是否最新 (CI 用)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_ARCHIVE = path.join(os.homedir(), 'Obsidian/ComfyUi/autodl-workflows-auto.md')
const OUT_FILE = path.resolve(__dirname, '../backend/src/constants/workflow-duration-limits.ts')

function parseArchive(text) {
  const lines = text.split('\n')
  const out = {}
  let currentId = null
  let currentName = null
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) { currentName = h2[1]; currentId = null; continue }
    const idm = line.match(/\*\*工作流ID\*\*:\s*`([^`]+)`/)
    if (idm) { currentId = idm[1].trim(); continue }
    // 输入参数表里的 duration 行: | `duration` | 否 | integer | `5` | min=1; max=15 |
    const dm = line.match(/^\|\s*`duration`\s*\|.*?max\s*=\s*(\d+)/i)
    if (dm && currentId) {
      const max = Number(dm[1])
      if (Number.isFinite(max) && max > 0) out[currentId] = { max, name: currentName || currentId }
    }
  }
  return out
}

function render(entries, source) {
  const rows = Object.entries(entries)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, v]) => `  ${JSON.stringify(id)}: ${v.max},`)
    .join('\n')
  return `/**
 * ★ Sprint 47 T8 (PM msg-20261115-188): 各 AutoDL 工作流的【时长上限】(秒)
 *
 * ★ 本文件是【生成物】, 不要手改 —— 改法: 改知识库档案, 然后跑
 *   node scripts/sync-workflow-duration-limits.js
 *
 * 数据来源: ${source}
 *   (cron 每日从 autodl.art 公开 API 同步的 AutoDL 工作流档案)
 * ★ 事实来源 → 代码里不硬写数字 (工单硬要求: 上限要有出处, 平台改上限不用改代码)
 */
export const WORKFLOW_DURATION_LIMITS: Record<string, number> = {
${rows}
}

/** 某工作流的时长上限 (未知工作流 → 返回 fallback, 默认 15 = 平台通用上限) */
export function getWorkflowDurationLimit(workflowId: string, fallback = 15): number {
  const v = WORKFLOW_DURATION_LIMITS[workflowId]
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback
}

/** 该工作流是否支持这个时长 */
export function workflowSupportsDuration(workflowId: string, duration: number): boolean {
  return duration <= getWorkflowDurationLimit(workflowId)
}
`
}

function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const archive = args.find((a) => !a.startsWith('--')) || DEFAULT_ARCHIVE
  if (!fs.existsSync(archive)) {
    console.error(`✗ 找不到工作流档案: ${archive}`)
    process.exit(1)
  }
  const entries = parseArchive(fs.readFileSync(archive, 'utf-8'))
  const count = Object.keys(entries).length
  if (!count) {
    console.error(`✗ 档案里没解析出任何工作流的 duration 上限: ${archive}`)
    process.exit(1)
  }
  const content = render(entries, archive)
  if (checkOnly) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf-8') : ''
    if (current !== content) {
      console.error(`✗ ${path.relative(process.cwd(), OUT_FILE)} 与档案不同步 → 跑 node scripts/sync-workflow-duration-limits.js`)
      process.exit(1)
    }
    console.log(`✓ 时长上限清单与档案一致 (${count} 个工作流)`)
    return
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, content, 'utf-8')
  const under10 = Object.entries(entries).filter(([, v]) => v.max < 15)
  console.log(`✓ 已生成 ${path.relative(process.cwd(), OUT_FILE)} (${count} 个工作流)`)
  console.log(`  上限 < 15s 的: ${under10.map(([id, v]) => `${id}=${v.max}s`).join(', ') || '(无)'}`)
}

main()

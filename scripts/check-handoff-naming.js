#!/usr/bin/env node
/**
 * ★ Sprint 45 (PM msg-20261115-185): handoff 回执编号校验
 *
 * 【为什么有这个脚本】回执文件名编号跟内容对应的单号【错位】过一次又一次 ——
 *   根因是按「目录里现有最大编号 +1」起算回执号，而不是按【被回的那张单】编号。
 *   ★ handoff 目录【不是 git 仓库】→ 一旦被同名覆盖就永久丢失。
 *   → 这里把它变成【机器可校验】的：漏了/错位了，脚本直接点名。
 *
 * 【用法】
 *   node scripts/check-handoff-naming.js                           # 默认 ~/Documents/aicg-collab/handoff
 *   node scripts/check-handoff-naming.js <目录>                     # 指定目录
 *   node scripts/check-handoff-naming.js <目录> --from=2026-11-13   # 硬校验起始日期（默认同左）
 *   node scripts/check-handoff-naming.js <目录> --days=30           # 用『最近 N 天』代替起始日期
 *
 * 【硬校验（exit 1）】
 *   ① 起始日期之后的 PM 单，找不到对应的 DEV 回执（文件名 DEV_to_PM_<id>.json）→ 点名哪个单号缺回执
 *   ② 起始日期之后的 DEV 回执，缺 for_msg 字段 → 点名哪个文件
 *   ③ 某份回执的 for_msg 指向一个不存在的 PM 单 → 点名
 *
 * 【软告警（不阻塞，只列清单）】
 *   · 回执的文件名编号 != for_msg 里的单号 → 『文件名 X 实际是单 Y』
 *   ★ 软告警【不做硬失败】—— 否则修完之前脚本一直红，没人愿意跑。
 *
 * 【豁免】目录里的 .handoff-exemptions.json 登记两类例外：
 *   noSeparateReceipt: { "<单号>": { "reason": "...", "by": "..." } }  → 该单没有独立回执（合并回 / 口头）
 *   oralRequest:       { "<单号>": { "reason": "...", "by": "..." } }  → 该单是用户口头追加，没有 PM 单文件
 *   acknowledged:       { "<单号>": { "reason": "...", "by": "..." } }  → 文件名故意不等于 for_msg（追加回执等），只跳过软告警
 *
 * 【窗口口径】硬校验只覆盖【起始日期之后】的单与回执 —— for_msg 机制从 2026-11-13 起生效，
 *   更早的 167 份回执是老格式（没有 for_msg），【不追溯补】。
 *   ★ 更早的历史单还有一批编号错位（PM 单 185 的映射表只覆盖 11-13/11-14 那批）→ 同样不追溯。
 *
 * 【只读】本脚本【不会修改/移动/删除】任何文件。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'aicg-collab', 'handoff')
const EXEMPTIONS_FILE = '.handoff-exemptions.json'
/** 硬校验的起始日期: for_msg 机制从这一天起生效（之前的回执是老格式, 不追溯补） */
const DEFAULT_FROM = '2026-11-13'

function parseArgs(argv) {
  let dir = DEFAULT_DIR
  let from = DEFAULT_FROM
  let days = 0
  for (const a of argv) {
    if (a.startsWith('--days=')) days = Number(a.slice(7)) || days
    else if (a.startsWith('--from=')) from = a.slice(7)
    else if (!a.startsWith('--')) dir = a
  }
  if (days > 0) from = daysAgo(days)
  return { dir, from }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** 从 msg-YYYYMMDD-NNN 里取日期串 */
function idDate(id) {
  const m = /^msg-(\d{4})(\d{2})(\d{2})-/.exec(String(id || ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function main() {
  const { dir, from } = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(dir)) {
    console.error(`✗ 找不到 handoff 目录: ${dir}`)
    process.exit(2)
  }

  const files = fs.readdirSync(dir)
  const pmFiles = files.filter(f => /^PM_to_DEV.*\.json$/.test(f))
  const devFiles = files.filter(f => /^DEV_to_PM.*\.json$/.test(f))

  // PM 单: id → {file, date}
  const pmSingles = new Map()
  for (const f of pmFiles) {
    const j = readJson(path.join(dir, f))
    if (!j || !j.id) continue
    pmSingles.set(j.id, { file: f, date: idDate(j.id) })
  }

  // DEV 回执
  const receipts = []
  for (const f of devFiles) {
    const j = readJson(path.join(dir, f))
    if (!j) continue
    receipts.push({ file: f, id: j.id || '', for_msg: j.for_msg || '', date: idDate(j.id || '') })
  }

  // 豁免
  const exRaw = readJson(path.join(dir, EXEMPTIONS_FILE)) || {}
  const noSeparate = exRaw.noSeparateReceipt || {}
  const oral = exRaw.oralRequest || {}
  const acknowledged = exRaw.acknowledged || {}

  const cutoff = from
  const hardFails = []
  const warnings = []

  // ① 起始日期之后的 PM 单 → 必须有同号 DEV 回执
  for (const [id, info] of pmSingles) {
    if (!info.date || info.date < cutoff) continue
    if (noSeparate[id]) continue                        // 已登记: 这单没有独立回执
    const expect = `DEV_to_PM_${id}.json`
    // ★ 判定: 有【同号文件】或【某个回执的 for_msg 指向它】就算有回执
    //   (文件名错了只落软告警 → 硬校验留给"真的没人回")
    const pointedBy = receipts.some(r => r.for_msg === id)
    if (!fs.existsSync(path.join(dir, expect)) && !pointedBy) {
      hardFails.push(`PM 单 ${id} 找不到对应回执 (期望文件 ${expect}, 或某个回执的 for_msg 指向它) —— 收到哪张单就写哪一号, 不许按目录最大号+1 起算`)
    }
  }

  // ② 起始日期之后的 DEV 回执 → 必须有 for_msg
  //   ★ 只按【回执自己的 id 日期】判断新老 (不用 mtime —— 目录里文件的 mtime 会被别的工具刷新, 不可靠)
  const receiptsInWindow = receipts.filter(r => r.date && r.date >= cutoff)
  for (const r of receiptsInWindow) {
    if (!r.for_msg) {
      hardFails.push(`回执 ${r.file} 缺 for_msg 字段（要写它对应的那张 PM 单的 id）`)
    }
  }

  // ③ for_msg 指向的 PM 单必须存在（口头追加的除外）
  for (const r of receipts) {
    if (!r.for_msg) continue
    if (pmSingles.has(r.for_msg)) continue
    if (oral[r.for_msg]) continue                     // 已登记的【用户口头追加】→ 静默豁免
    hardFails.push(`回执 ${r.file} 的 for_msg=${r.for_msg} 指向的 PM 单在目录里不存在`)
  }

  // 软告警: 文件名编号 != for_msg 单号
  for (const r of receipts) {
    if (!r.for_msg) continue
    if (acknowledged[r.for_msg]) continue             // 已登记: 文件名故意不等于 for_msg（追加回执等）
    const m = /^msg-(\d{8}-\d+)$/.exec(r.for_msg)
    const want = m ? `DEV_to_PM_${m[0]}.json` : null
    if (want && want !== r.file) {
      warnings.push(`回执 ${r.file} 的文件名编号与 for_msg 不一致 → 文件名 ${r.file.replace('DEV_to_PM_', '')} 实际是单 ${r.for_msg.replace('msg-', '')}`)
    }
  }

  console.log(`handoff 目录: ${dir}  (PM 单 ${pmSingles.size} 张 / DEV 回执 ${receipts.length} 份, 硬校验起始 ${cutoff})`)
  if (hardFails.length) {
    console.error('\n✗ 硬校验没过：')
    hardFails.forEach(f => console.error('  ✗ ' + f))
  }
  if (warnings.length) {
    console.log('\n⚠️ 软告警（不阻塞）：')
    warnings.forEach(w => console.log('  · ' + w))
  }
  if (!hardFails.length) {
    console.log(`\n✓ 硬校验全过（${receiptsInWindow.length} 份窗口内回执都有 for_msg, for_msg 指向的 PM 单都存在）`)
  }
  process.exit(hardFails.length ? 1 : 0)
}

main()

#!/usr/bin/env node
/**
 * ★ Sprint 45 (PM msg-20261115-185): 生成 handoff 目录的索引 RECEIPT-INDEX.md
 *
 * 【为什么是脚本生成】索引一旦手工维护就会过期 —— 而它的价值全在"能查到最新那单的回执在哪"。
 *   → 自动生成 = 永远跟目录里的实际文件一致。
 *
 * 【用法】
 *   node scripts/gen-receipt-index.js                    # 默认 ~/Documents/aicg-collab/handoff
 *   node scripts/gen-receipt-index.js <目录>               # 指定目录
 *   node scripts/gen-receipt-index.js <目录> --since=2026-10-20   # 索引从哪天开始列 (默认最近 45 天)
 *
 * 【注意】本脚本【会写】<目录>/RECEIPT-INDEX.md (只写这一个文件, 不碰任何回执/派单)。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'aicg-collab', 'handoff')

function parseArgs(argv) {
  let dir = DEFAULT_DIR
  let since = ''
  for (const a of argv) {
    if (a.startsWith('--since=')) since = a.slice(8);
    else if (!a.startsWith('--')) dir = a;
  }
  if (!since) {
    const d = new Date();
    d.setDate(d.getDate() - 45);
    since = d.toISOString().slice(0, 10);
  }
  return { dir, since };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function idDate(id) {
  const m = /^msg-(\d{4})(\d{2})(\d{2})-/.exec(String(id || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function main() {
  const { dir, since } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dir)) {
    console.error(`✗ 找不到 handoff 目录: ${dir}`);
    process.exit(2);
  }
  const files = fs.readdirSync(dir);
  const pmFiles = files.filter(f => /^PM_to_DEV.*\.json$/.test(f)).sort();
  const devFiles = files.filter(f => /^DEV_to_PM.*\.json$/.test(f)).sort();

  const exRaw = readJson(path.join(dir, '.handoff-exemptions.json')) || {};
  const noSeparate = exRaw.noSeparateReceipt || {};
  const oral = exRaw.oralRequest || {};

  // PM 单
  const pms = [];
  for (const f of pmFiles) {
    const j = readJson(path.join(dir, f));
    if (!j || !j.id) continue;
    pms.push({ id: j.id, file: f, topic: j.topic || '', status: j.status || '', date: idDate(j.id) });
  }
  pms.sort((a, b) => (a.id < b.id ? 1 : -1));

  // DEV 回执: 文件名 → {for_msg}
  const receipts = new Map();
  for (const f of devFiles) {
    const j = readJson(path.join(dir, f));
    if (!j) continue;
    receipts.set(f, { for_msg: j.for_msg || '', topic: j.topic || '' });
  }
  const byForMsg = new Map();
  for (const [f, r] of receipts) {
    if (r.for_msg && !byForMsg.has(r.for_msg)) byForMsg.set(r.for_msg, f);
  }

  const lines = [];
  lines.push('# handoff 目录索引（单号 ↔ 回执）');
  lines.push('');
  lines.push('> ★ **本文件是脚本自动生成的** —— 内容以 `handoff/` 目录里的实际文件为准，**不要在这里手改**（会被下次生成覆盖）');
  lines.push('> - 生成脚本：`huobao-drama-1.0/scripts/gen-receipt-index.js`');
  lines.push('> - 重新生成：`node scripts/gen-receipt-index.js ~/Documents/aicg-collab/handoff`');
  lines.push('> - 编号校验：`node scripts/check-handoff-naming.js ~/Documents/aicg-collab/handoff`');
  lines.push('');
  lines.push('## 编号规则（派单号由 PM 唯一分配）');
  lines.push('');
  lines.push('- 收到 `msg-2026MMDD-NNN` → 回执必须写 `DEV_to_PM_msg-2026MMDD-NNN.json`');
  lines.push('- ★ **不许按「目录里现有最大编号 +1」起算** —— 那会让每份回执都占别人的号位，且错位会一路传下去');
  lines.push('- 每份回执顶层有 `for_msg` = 它对应的那张 PM 单的 id（追溯不用逐个开文件猜）');
  lines.push('- ★ `handoff/` **不是 git 仓库** → 同名覆盖不可恢复：改名要两阶段（先全部改临时名再改目标名），改之前先备份');
  lines.push('');
  lines.push(`## 单 ↔ 回执一览（${since} 起，共 ${pms.length} 张单 / ${receipts.size} 份回执）`);
  lines.push('');
  lines.push('| 单号 | 主题 | 派单文件 | DEV 回执文件 | 状态 |');
  lines.push('|---|---|---|---|---|');
  let noReceipt = 0;
  for (const p of pms) {
    if (p.date && p.date < since) continue;
    const sameName = `DEV_to_PM_${p.id}.json`;
    let receipt = receipts.has(sameName) ? sameName : (byForMsg.get(p.id) || '');
    let state;
    if (!receipt) {
      if (noSeparate[p.id]) { receipt = ''; state = '无独立回执（合并回/口头，见 .handoff-exemptions.json）'; noReceipt++; }
      else state = '**未回执**';
    } else {
      const r = receipts.get(receipt);
      state = (r.for_msg && r.for_msg !== p.id) ? `已回执（for_msg=${r.for_msg}）` : '已回执';
    }
    lines.push(`| ${p.id} | ${esc(p.topic)} | \`${p.file}\` | ${receipt ? `\`${receipt}\`` : '—'} | ${state} |`);
  }
  lines.push('');
  lines.push('## 更早的单');
  lines.push('');
  lines.push(`- 目录里共 ${pmFiles.length} 张 PM 单 / ${devFiles.length} 份回执；本索引只列 ' + since + ' 起的`);
  lines.push('- 更早的单（含**历史编号错位**的老回执）直接看目录里的实际文件 —— 按 `PM_to_DEV_<单号>.json` 找派单、按 `DEV_to_PM_<单号>.json` 找回执');
  lines.push('- ★ 编号错位只修过 11-13 / 11-14 那批（PM 单 185 的映射表），**更早的历史错位未追溯**（要动很多老回执的内容，风险大于收益）');

  const outPath = path.join(dir, 'RECEIPT-INDEX.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`✓ 已生成 ${outPath}  (${lines.length} 行, 其中 ${noReceipt} 张单无独立回执)`);
}

main();

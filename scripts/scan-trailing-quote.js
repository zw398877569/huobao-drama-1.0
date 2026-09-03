#!/usr/bin/env node
/**
 * Scan .ts / .vue files for stray trailing quotes after a .join(...) call.
 *
 * The specific bug: array.join(...) followed by a stray ' is an unterminated
 * string literal. Example typo:
 *   ].filter(Boolean).join(', ')'
 * Caught twice in backend/src/routes/characters.ts (commits 28352b5 + 40eef1a).
 *
 * Why narrow: the wider pattern `)\s*'` (any close-paren then quote) catches
 * legitimate `|| '...'` (OR fallback) and template-literal interpolation. The
 * .join-specific form has very few false positives in idiomatic code.
 */
const fs = require('fs');
const path = require('path');

const PATTERN = /\.(?:join|filter|map|reduce|concat|slice|toString|trim)\([^)]*\)\s*'(?=[\s,;)\]}|]|$)/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.nuxt' || entry.name === 'dist' || entry.name === 'scripts') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|vue|tsx|js)$/.test(entry.name)) out.push(p);
  }
}

const target = path.resolve(process.argv[2] || '.');
const files = [];
if (fs.existsSync(target) && fs.statSync(target).isFile()) {
  files.push(target);
} else if (fs.existsSync(target)) {
  walk(target, files);
}

let totalIssues = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf-8');
  const issues = [];
  let m;
  PATTERN.lastIndex = 0;
  while ((m = PATTERN.exec(src))) {
    const before = src.slice(0, m.index);
    const line = before.split('\n').length;
    const col = m.index - (before.lastIndexOf('\n') + 1) + 1;
    issues.push({ line, col, match: m[0] });
  }
  if (issues.length) {
    console.log(`FAIL ${path.relative(process.cwd(), f)} — ${issues.length} stray trailing quote(s):`);
    for (const i of issues) {
      console.log(`  line ${i.line}:${i.col}  ${JSON.stringify(i.match)}`);
    }
    totalIssues += issues.length;
  }
}

if (totalIssues === 0) {
  console.log('OK no stray trailing quotes after .join/.filter/.map/etc.');
  process.exit(0);
}
process.exit(1);

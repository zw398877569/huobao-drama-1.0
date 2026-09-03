#!/usr/bin/env node
/**
 * Dockerfile structure linter — catches orphan instructions that aren't
 * inside a build stage.
 *
 * Bug class: when a comment block is rewritten and line counts shift, a
 * FROM line between top-level ARG and the first stage can accidentally get
 * spliced out. The remaining WORKDIR/COPY/RUN then sit at global scope
 * and buildkit fails with the misleading "no build stage in current context".
 *
 * Rule: every WORKDIR / COPY / RUN / CMD / ENTRYPOINT / ENV (after first
 * FROM) / EXPOSE / VOLUME / LABEL / ARG-without-FROM must be preceded by
 * at least one FROM line in the file up to that point.
 *
 * Also: each non-comment, non-ARG, non-FROM line in the global scope
 * (before any FROM) must be FROM, ARG, or a continuation of one.
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(process.argv[2] || 'Dockerfile');
if (!fs.existsSync(target)) {
  console.error(`File not found: ${target}`);
  process.exit(1);
}

const src = fs.readFileSync(target, 'utf-8');
const lines = src.split('\n');

// We treat as global-scope-instruction any non-ARG/FROM line that appears
// before the first FROM. Also flag any "real instruction" that appears
// without a preceding FROM at all.
const REAL_INSTRUCTION = /^\s*(WORKDIR|COPY|RUN|CMD|ENTRYPOINT|EXPOSE|VOLUME|LABEL|ADD|ARG)\b/;
const FROM = /^\s*FROM\b/;
const ARG = /^\s*ARG\b/;

let firstFromLine = -1;
let issues = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  if (FROM.test(line)) {
    if (firstFromLine === -1) firstFromLine = i + 1;
    continue;
  }
  if (ARG.test(line)) continue; // ARG can live at global scope
  if (REAL_INSTRUCTION.test(line) && firstFromLine === -1) {
    issues.push({
      line: i + 1,
      type: 'ORPHAN_INSTRUCTION',
      msg: `Instruction '${trimmed.split(/\s+/)[0]}' is at global scope (no FROM before it). ` +
           `Either this instruction should be inside a build stage, or you're missing a FROM line above.`,
    })
  }
}

if (issues.length === 0) {
  console.log(`OK ${path.relative(process.cwd(), target)} — Dockerfile structure is valid.`);
  process.exit(0);
}

console.log(`FAIL ${issues.length} Dockerfile structure issue(s) in ${path.relative(process.cwd(), target)}:\n`);
for (const i of issues) {
  console.log(`  line ${i.line}: ${i.msg}`);
}
console.log('\nFix: ensure every WORKDIR/COPY/RUN/etc. is preceded by a FROM line. ' +
            'Add a missing FROM, or move the instruction inside an existing stage.');
process.exit(1);

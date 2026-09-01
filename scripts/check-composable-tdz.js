#!/usr/bin/env node
// Static TDZ detector for Vue composable call order.
// Detects: useFoo({ x: someRef }) where someRef is destructured from a LATER
// useBar() call (not yet initialized at the moment JS evaluates the arg object).
//
// Usage: node scripts/check-composable-tdz.js [path-to-vue-file]
// Exits 0 if clean, 1 if TDZ risk found.
//
// Lesson: feedback/vue-large-file-composable-extraction.md 坑 #6
const fs = require('fs');
const path = require('path');

const DEFAULT_TARGET = 'frontend/app/pages/drama/[id]/episode/[episodeNumber].vue';
const target = path.resolve(process.argv[2] || DEFAULT_TARGET);

const IGNORE = new Set([
  'if','else','for','while','do','switch','case','default','break','continue',
  'return','throw','try','catch','finally','new','delete','typeof','instanceof',
  'in','of','void','this','function','class','extends','super','import','export',
  'yield','async','await','static','let','const','var','with','debugger','enum',
  '_isRef','_ctx','_cache','_setup','_createBlock','_createElementBlock',
  '_createElementVNode','_createTextVNode','_createStaticVNode','_normalizeClass',
  '_normalizeStyle','_normalizeProps','_renderSlot','_toDisplayString',
  '_mergeProps','_openBlock','_withDirectives','_resolveComponent','_resolveDirective',
  '_withCtx','_Fragment','_Suspense','_Teleport','_Static','_Comment','_Text',
  '_createSlots','_toRaw','_shallowRef','_customRef','_toRef','_toRefs',
  'console','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent',
  'decodeURIComponent','encodeURI','decodeURI','escape','unescape',
  'Object','Array','String','Number','Boolean','Date','Math','JSON','Promise',
  'Symbol','Map','Set','WeakMap','WeakSet','Error','TypeError','RangeError',
  'RegExp','Function','setTimeout','clearTimeout','setInterval','clearInterval',
  'eval','globalThis','undefined','null','true','false','NaN','Infinity',
  'navigateTo','useRoute','useRouter','useFetch','useState','useHead',
  'useRuntimeConfig','useNuxtApp','defineNuxtPlugin','defineNuxtRouteMiddleware',
  'toast','confirm','alert','prompt',
  'ref','reactive','computed','watch','watchEffect','onMounted','onBeforeUnmount',
  'onUnmounted','onUpdated','onBeforeMount','shallowRef','triggerRef',
  'useAgent','toRefs','customRef'
]);

function extractIdentifiers(argsString) {
  let s = argsString
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  // Strip object property keys first: "key: value" -> ": value" (strings stripped)
  s = s.replace(/\b([A-Za-z_$][\w$]*)\s*:/g, ':');
  // Strip member access ENTIRELY: "a.value" / "a?.foo.bar" -> "a" (not "a.")
  // so the base identifier can match the trailing "identifier + boundary" regex
  s = s.replace(/\??\.[A-Za-z_$][\w$]*/g, '');
  // Now match remaining identifiers (these are the values)
  const re = /([A-Za-z_$][\w$]*)\s*[,}\]\)]/g;
  const found = new Set();
  let m;
  while ((m = re.exec(s))) {
    if (!IGNORE.has(m[1])) found.add(m[1]);
  }
  return found;
}

function main() {
  if (!fs.existsSync(target)) {
    console.error('File not found: ' + target);
    process.exit(1);
  }
  const src = fs.readFileSync(target, 'utf-8');
  const scriptMatch = src.match(/<script setup[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) { console.error('No <script setup>'); process.exit(1); }
  const script = scriptMatch[1];
  // Compute file-line offset where <script setup> starts
  const scriptSetupMatch = src.match(/<script setup[^>]*>/);
  const scriptStartLine = scriptSetupMatch
    ? src.slice(0, scriptSetupMatch.index).split('\n').length - 1
    : 0;

  const declared = new Set();
  const issues = [];
  const events = [];
  let m;

  // const { a, b } = useXxx(...) — full destructure
  const destructureFullRe = /const\s*\{([^}]+)\}\s*=\s*use([A-Z][\w$]*)\s*\(/g;
  while ((m = destructureFullRe.exec(script))) {
    const names = m[1].split(',').map(s => {
      const parts = s.trim().split(/[:\s]+/).filter(Boolean);
      return parts[parts.length - 1]; // take last ident (handles "name: alias")
    }).filter(Boolean);
    events.push({ type: 'decl', offset: m.index, names });
  }

  // const X = ref(...) / = reactive(...) / = computed(...)
  // Match any 'const X = ...' (single-name declaration). ref/reactive/computed
  // are auto-imported and don't add to TDZ surface anyway, but other expressions
  // (e.g. const dramaId = Number(route.params.id)) ALSO produce identifiers
  // available in the rest of the script. Over-collecting is safe for TDZ
  // detection — the only risk is missing a real TDZ, which is the bug class
  // we're trying to catch.
  const varDeclRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?!\{)/g;
  while ((m = varDeclRe.exec(script))) {
    events.push({ type: 'decl', offset: m.index, names: [m[1]] });
  }

  // function foo() {} or async function foo() {} — hoisted
  const fnDeclRe = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnDeclRe.exec(script))) {
    events.push({ type: 'hoist', offset: m.index, names: [m[1]] });
  }

  // composable call site: = useXxx({...})
  const callArgsRe = /=\s*use([A-Z][\w$]*)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = callArgsRe.exec(script))) {
    events.push({ type: 'call', offset: m.index, agent: m[1], args: m[2] });
  }

  // Process in source order
  // Hoist all function declarations into `declared` upfront (JS hoists them
  // to the top of the script setup scope regardless of physical position).
  // var-decls and call-sites stay in source order.
  for (const e of events) {
    if (e.type === 'hoist') for (const n of e.names) declared.add(n);
  }

  // Process remaining events in source order (var-decls + call-sites)
  events.sort((a, b) => a.offset - b.offset);

  for (const e of events) {
    if (e.type === 'hoist') continue; // already handled
    if (e.type === 'decl') {
      for (const n of e.names) declared.add(n);
    } else if (e.type === 'call') {
      const used = extractIdentifiers(e.args);
      const missing = [];
      for (const name of used) {
        if (!declared.has(name)) missing.push(name);
      }
      if (missing.length) {
        const lineNum = scriptStartLine + script.slice(0, e.offset).split('\n').length;
        const srcLine = src.split('\n')[lineNum - 1]?.trim() || '';
        issues.push({
          line: lineNum,
          agent: e.agent,
          missing,
          snippet: srcLine.length > 100 ? srcLine.slice(0, 100) + '...' : srcLine,
        });
      }
    }
  }

  const rel = path.relative(process.cwd(), target);
  if (issues.length === 0) {
    console.log('OK ' + rel + ' - all composable args are TDZ-safe.');
    process.exit(0);
  }

  console.log('FAIL ' + issues.length + ' TDZ risk(s) in ' + rel + ':\n');
  for (const i of issues) {
    console.log('  line ' + i.line + ': use' + i.agent + '({...})');
    console.log('    uses: ' + i.missing.join(', '));
    console.log('    ' + i.snippet);
    console.log('');
  }
  console.log('Fix: reorder so the useXxx() that produces the missing dep is called BEFORE the call that uses it.');
  console.log('See: feedback/vue-large-file-composable-extraction.md (坑 #6 TDZ + 循环依赖).');
  process.exit(1);
}

main();

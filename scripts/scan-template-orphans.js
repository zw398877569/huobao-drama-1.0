#!/usr/bin/env node
/**
 * Scan a Vue SFC for orphan template references: identifiers called as functions
 * in <template> (mustache + attribute expressions) that are NOT declared in
 * <script setup>, nor returned by any composable in app/composables/, nor in
 * the JS-keyword / Vue-runtime builtin filter list.
 *
 * Why: bulk composable extractions can accidentally leave template-bound helpers
 * orphaned (template still references them, but the script section no longer
 * defines them). build succeeds, runtime ReferenceError. This script catches
 * those pre-deploy.
 *
 * Usage:
 *   node scripts/scan-template-orphans.js [path-to-vue-file]
 *   # default: scans frontend/app/pages/drama/[id]/episode/[episodeNumber].vue
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_TARGET = 'frontend/app/pages/drama/[id]/episode/[episodeNumber].vue'
const COMPOSABLES_DIR = 'frontend/app/composables'

const target = path.resolve(process.argv[2] || DEFAULT_TARGET)

const KEYWORDS = new Set([
  // JS reserved
  'if','else','for','while','do','switch','case','default','break','continue',
  'return','throw','try','catch','finally','new','delete','typeof','instanceof',
  'in','of','void','this','function','class','extends','super','import','export',
  'yield','async','await','static','let','const','var','with','debugger','enum',
  // Vue runtime / compiler (auto-imported)
  '_isRef','_ctx','_cache','_setup','_createBlock','_createElementBlock',
  '_createElementVNode','_createTextVNode','_createStaticVNode','_normalizeClass',
  '_normalizeStyle','_normalizeProps','_renderSlot','_toDisplayString',
  '_mergeProps','_openBlock','_withDirectives','_resolveComponent','_resolveDirective',
  '_withCtx','_Fragment','_Suspense','_Teleport','_Static','_Comment','_Text',
  '_createSlots','_toRaw','_shallowRef','_customRef','_toRef','_toRefs',
  // Common globals
  'console','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent',
  'decodeURIComponent','encodeURI','decodeURI','escape','unescape',
  'Object','Array','String','Number','Boolean','Date','Math','JSON','Promise',
  'Symbol','Map','Set','WeakMap','WeakSet','Error','TypeError','RangeError',
  'RegExp','Function','setTimeout','clearTimeout','setInterval','clearInterval',
  'eval','globalThis','undefined','null','true','false','NaN','Infinity',
  // Nuxt auto-imports frequently used in templates
  'navigateTo', 'useRoute', 'useRouter', 'useFetch', 'useState', 'useHead',
  // vue-sonner auto-imported
  'toast',
])

function extractTemplateCallables(t) {
  const found = new Map()
  function scanBinding(s) {
    // Skip member access: dont match identifiers preceded by . (e.g. toast.success)
    const cleaned = s.replace(/\.[A-Za-z_$][\w$]*/g, '.')
    const re = /([A-Za-z_$][\w$]*)\s*\(/g
    let m
    while ((m = re.exec(cleaned))) {
      const name = m[1]
      found.set(name, (found.get(name) || 0) + 1)
    }
  }
  const mustacheRe = /\{\{([^}]+)\}\}/g
  let m
  while ((m = mustacheRe.exec(t))) scanBinding(m[1])
  const attrRe = /=\s*"([\s\S]*?)"/g
  while ((m = attrRe.exec(t))) scanBinding(m[1])
  return found
}

function extractScriptDeclarations(script) {
  const declared = new Set()

  // function foo(...) { ... }
  const fnRe = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm
  let m
  while ((m = fnRe.exec(script))) declared.add(m[1])

  // const foo = function / const arrow = (...) => / const arrow = x =>
  const constArrowRe = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*\(|\([^)]*\)\s*=>|\w+\s*=>)/gm
  while ((m = constArrowRe.exec(script))) declared.add(m[1])

  // const foo = reactive({...}) / ref(...) / computed(...)
  const varDeclRe = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:reactive|ref|computed)\b/gm
  while ((m = varDeclRe.exec(script))) declared.add(m[1])

  // const { a, b, c } = useFoo(...) — destructure names
  // Look for the start of a destructure block: a line ending with `const {`
  // then scan identifiers until `} = useXxx(`
  const destructureStart = /^const\s*\{([^}]+)\}\s*=\s*use([A-Z][\w$]*)\s*\(/gm
  while ((m = destructureStart.exec(script))) {
    const names = m[1].split(',').map(s => s.trim().split(/[:\s]/)[0]).filter(Boolean)
    for (const n of names) declared.add(n)
  }

  // Also accept Vue auto-imports (ref, reactive, onMounted, etc.)
  for (const a of ['ref','reactive','computed','watch','onMounted','onBeforeUnmount','useRoute','useAgent']) {
    declared.add(a)
  }
  return declared
}

function collectComposableReturns(composablesDir) {
  const ret = new Set()
  if (!fs.existsSync(composablesDir)) return ret
  for (const f of fs.readdirSync(composablesDir)) {
    if (!f.endsWith('.ts')) continue
    const c = fs.readFileSync(path.join(composablesDir, f), 'utf-8')
    const retMatches = c.match(/return\s*\{([\s\S]*?)\}/g)
    if (!retMatches) continue
    // Take the LAST return block — that's almost always the export.
    const last = retMatches[retMatches.length - 1]
    const idRe = /^\s*([A-Za-z_$][\w$]*)\s*[,}]/gm
    let m
    while ((m = idRe.exec(last))) {
      if (m[1] !== 'return') ret.add(m[1])
    }
  }
  return ret
}

function main() {
  if (!fs.existsSync(target)) {
    console.error(`✗ File not found: ${target}`)
    process.exit(1)
  }
  const src = fs.readFileSync(target, 'utf-8')
  const tmplMatch = src.match(/<template>([\s\S]*?)<\/template>/)
  const scriptMatch = src.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)
  if (!tmplMatch || !scriptMatch) {
    console.error('✗ Cannot find <template> or <script setup> blocks')
    process.exit(1)
  }
  const tmpl = tmplMatch[1]
  const script = scriptMatch[1]

  const templateCalls = extractTemplateCallables(tmpl)
  const scriptDeclared = extractScriptDeclarations(script)

  // Pull composables dir relative to project root (target file is in frontend/)
  const projectRoot = path.resolve(target).match(/^(.*frontend)/)?.[1] || path.dirname(target)
  const composablesDir = path.join(projectRoot, 'app/composables')
  const composableReturns = collectComposableReturns(composablesDir)
  for (const id of composableReturns) scriptDeclared.add(id)

  const orphans = []
  for (const [name, count] of templateCalls.entries()) {
    if (KEYWORDS.has(name)) continue
    if (scriptDeclared.has(name)) continue
    orphans.push({ name, count })
  }
  orphans.sort((a, b) => b.count - a.count)

  console.log(`Target: ${path.relative(process.cwd(), target)}`)
  console.log(`Template callable references: ${templateCalls.size} unique, ${Array.from(templateCalls.values()).reduce((a, b) => a + b, 0)} total`)
  console.log(`Script-declared names: ${scriptDeclared.size}`)
  console.log(`Composable-returned names: ${composableReturns.size}`)
  console.log('')
  if (orphans.length === 0) {
    console.log('OK no orphan template references detected.')
    process.exit(0)
  } else {
    console.log(`FAIL ${orphans.length} ORPHAN(S) - referenced in template but not declared:\n`)
    for (const o of orphans) {
      console.log(`  ${o.name}  (used ${o.count}x in template)`)
    }
    process.exit(1)
  }
}

main()

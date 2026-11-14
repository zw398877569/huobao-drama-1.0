#!/usr/bin/env node
// 检查后端 ComfyUI adapter 的 WORKFLOW_* 常量与前端 autodl-comfyui video models 数组
// 以及 AUTODL_COMFYUI_MODEL_LABELS 中文标签映射三者是否一致。
//
// 用法: node scripts/check-workflow-sync.js
//       pnpm exec node scripts/check-workflow-sync.js
//
// 退出码:
//   0 = 完全一致
//   1 = 有 diff（models 数组缺/顺序错，或 label map 缺/多）
//
// 维护四步走（详见 docs/comfyui-workflows.md 末尾）：
//   1. 改 backend/src/services/adapters/autodl-comfyui-workflow.ts 的 WORKFLOW_* + JSDoc
//   2. 改 frontend/app/composables/useSettingsAi.ts 的 models 数组（保持同顺序）
//   3. 改 frontend/app/composables/useSettingsAi.ts 的 AUTODL_COMFYUI_MODEL_LABELS 中文标签
//   4. 改 docs/comfyui-workflows.md 的「工作流清单」章节
//
// 步骤 3 没做会导致 dropdown 显示 raw id 而不是中文（已被本脚本检查）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.join(ROOT, 'backend/src/services/adapters/autodl-comfyui-workflow.ts');
const FRONTEND_PATH = path.join(ROOT, 'frontend/app/composables/useSettingsAi.ts');

function extractBackendWorkflowIds(src) {
  // 匹配 static readonly WORKFLOW_* = 'value' 的常量声明
  const re = /static\s+readonly\s+WORKFLOW_\w+\s*=\s*'([^']+)'/g;
  const ids = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function extractFrontendVideoModels(src) {
  // 锚定到 video 块的 autodl-comfyui provider（label 是 "AutoDL H3 推荐"，
  // 区别于 audio 块的 "AutoDL TTS 推荐"），从锚点往后找最近的 models: [ ... ]。
  const anchor = "label: 'AutoDL H3 推荐'";
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx < 0) {
    throw new Error("前端 useSettingsAi.ts 找不到 video 块锚点 'label: \\'AutoDL H3 推荐\\''，结构可能变了");
  }
  const modelsIdx = src.indexOf('models: [', anchorIdx);
  if (modelsIdx < 0) {
    throw new Error('video 块里找不到 models: [');
  }
  const arrayStart = modelsIdx + 'models: ['.length;
  const arrayEnd = src.indexOf(']', arrayStart);
  if (arrayEnd < 0) {
    throw new Error('video 块里找不到 models 数组结束 ]');
  }
  const body = src.slice(arrayStart, arrayEnd);
  const re = /'(minimax_h3_[^']+)'/g;
  const ids = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    ids.push(m[1]);
  }
  if (ids.length === 0) {
    throw new Error('video 块 models 数组里没找到 minimax_h3_* 工作流 id');
  }
  return ids;
}

/**
 * ★ Sprint 42/43 (PM msg-20261114-181 / msg-20261115-183): 解析 adapter 里的几个清单,
 *   用来做【新工作流完整性检查】—— 照着 devflow/add-autodl-workflow.md 做的时候,
 *   漏了某一项这里会直接报出来, 不依赖任何人记得读文档。
 */
/** WORKFLOW_* 常量名 → id (清单里通常写的是常量名, 不是 id 字面量) */
function buildConstNameToId(src) {
  const map = {};
  const re = /static\s+readonly\s+WORKFLOW_(\w+)\s*=\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = m[2];
  return map;
}

function extractAdapterList(src, varName, constNameToId) {
  // 取 "static readonly XXX = [ ... ]" 数组体里的工作流 (常量名或 id 字面量 → 统一转成 id)
  const start = src.indexOf(varName + ' = [');
  if (start < 0) return null;
  const bodyStart = src.indexOf('[', start);
  const bodyEnd = src.indexOf(']', bodyStart);
  if (bodyEnd < 0) return null;
  const body = src.slice(bodyStart, bodyEnd);
  const ids = [];
  const nameRe = /AutoDLComfyUIWorkflowAdapter\.WORKFLOW_(\w+)/g;
  let m;
  while ((m = nameRe.exec(body)) !== null) {
    const id = constNameToId[m[1]];
    if (id) ids.push(id);
  }
  const litRe = /'(minimax_h3_[^']+)'/g;
  while ((m = litRe.exec(body)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** RESOLUTION_PROFILES 的键 (工作流 → 分辨率档位配置) */
function extractResolutionProfileKeys(src) {
  const start = src.indexOf('RESOLUTION_PROFILES: Record<string, {');
  if (start < 0) return [];
  const eq = src.indexOf('= {', start);
  if (eq < 0) return [];
  const bodyStart = eq + 2;
  const bodyEnd = src.indexOf('\n  }', bodyStart);
  const body = src.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd);
  const re = /'([a-z0-9_]+)':\s*\{/g;
  const keys = [];
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

/** 前端的价格表 (AUTODL_COMFYUI_MODEL_PRICES) 的 key */
function extractFrontendPriceMap(src) {
  const startMarker = 'AUTODL_COMFYUI_MODEL_PRICES';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) return [];
  const braceOpen = src.indexOf('{', startIdx);
  if (braceOpen < 0) return [];
  let depth = 1;
  let i = braceOpen + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  const body = src.slice(braceOpen + 1, i - 1);
  const re = /([a-zA-Z0-9_]+):\s*'/g;
  const keys = [];
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

function extractFrontendLabelMap(src) {
  // 从 useSettingsAi.ts 抽出 AUTODL_COMFYUI_MODEL_LABELS 对象里的所有 key
  // 例子:   minimax_h3_lightx2v_no_pic: 'T2V 文生视频（无参考图）',
  // 整个对象可能跨多行
  const startMarker = 'AUTODL_COMFYUI_MODEL_LABELS';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error('useSettingsAi.ts 找不到 AUTODL_COMFYUI_MODEL_LABELS，结构可能变了');
  }
  const braceOpen = src.indexOf('{', startIdx);
  if (braceOpen < 0) {
    throw new Error('AUTODL_COMFYUI_MODEL_LABELS 后面找不到 {');
  }
  // 从 { 开始按深度匹配 }，避免被对象里的字符串 } 误导
  let depth = 1;
  let i = braceOpen + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error('AUTODL_COMFYUI_MODEL_LABELS 对象括号不匹配');
  }
  const body = src.slice(braceOpen + 1, i - 1);
  // 提取 key: 'value',
  // 注意: key 没加引号 — TS 对象字面量允许裸标识符作 key
  const re = /([a-zA-Z0-9_]+):\s*'/g;
  const keys = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    keys.push(m[1]);
  }
  if (keys.length === 0) {
    throw new Error('AUTODL_COMFYUI_MODEL_LABELS 里没解析出任何 key');
  }
  return keys;
}

function main() {
  if (!fs.existsSync(ADAPTER_PATH)) {
    console.error(`✗ 找不到后端文件: ${ADAPTER_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(FRONTEND_PATH)) {
    console.error(`✗ 找不到前端文件: ${FRONTEND_PATH}`);
    process.exit(1);
  }

  const backendSrc = fs.readFileSync(ADAPTER_PATH, 'utf-8');
  const frontendSrc = fs.readFileSync(FRONTEND_PATH, 'utf-8');

  let backendIds, frontendIds, labelKeys;
  try {
    backendIds = extractBackendWorkflowIds(backendSrc);
  } catch (err) {
    console.error(`✗ 解析后端 adapter 失败: ${err.message}`);
    process.exit(1);
  }
  try {
    frontendIds = extractFrontendVideoModels(frontendSrc);
  } catch (err) {
    console.error(`✗ 解析前端 useSettingsAi models 数组失败: ${err.message}`);
    process.exit(1);
  }
  try {
    labelKeys = extractFrontendLabelMap(frontendSrc);
  } catch (err) {
    console.error(`✗ 解析前端 AUTODL_COMFYUI_MODEL_LABELS 失败: ${err.message}`);
    process.exit(1);
  }

  const backendSet = new Set(backendIds);
  const frontendSet = new Set(frontendIds);
  const labelSet = new Set(labelKeys);

  // 三组对比：后端 vs 前端 models 数组 vs 前端 label map
  // 后端是事实来源，前端两处都要对齐到后端
  const modelsMissingInFrontend = backendIds.filter((id) => !frontendSet.has(id));
  const modelsExtra = frontendIds.filter((id) => !backendSet.has(id));
  const modelsHasOrderDiff = backendIds.length === frontendIds.length &&
    backendIds.some((id, i) => id !== frontendIds[i]);
  const labelMissing = backendIds.filter((id) => !labelSet.has(id));
  const labelExtra = labelKeys.filter((id) => !backendSet.has(id));

  const hasModelMissing = modelsMissingInFrontend.length > 0;
  const hasModelExtra = modelsExtra.length > 0;
  const hasModelOrderDiff = modelsHasOrderDiff && backendIds.length === frontendIds.length;
  const hasLabelMissing = labelMissing.length > 0;
  const hasLabelExtra = labelExtra.length > 0;

  // ── ★ Sprint 42/43: 【新工作流完整性检查】──
  //   照着 devflow/add-autodl-workflow.md 做的时候, 下面这几项漏了会在这里直接报出来,
  //   不依赖任何人记得读那份 SOP。
  const constNameToId = buildConstNameToId(backendSrc);
  const knownIds = extractAdapterList(backendSrc, 'KNOWN_WORKFLOW_IDS', constNameToId) || [];
  const ref2vVariants = extractAdapterList(backendSrc, 'REF2V_VARIANTS', constNameToId) || [];
  const audioVariants = extractAdapterList(backendSrc, 'REF2V_AUDIO_VARIANTS', constNameToId) || [];
  const resProfileKeys = extractResolutionProfileKeys(backendSrc);
  const priceKeys = extractFrontendPriceMap(frontendSrc);

  const hardFails = [];
  const warnings = [];

  // ① 每个工作流都要进 KNOWN_WORKFLOW_IDS (漏了 → 用户选了未接入的 id 时一条告警都不留)
  const knownIdSet = new Set(knownIds);
  for (const id of backendIds) {
    if (!knownIdSet.has(id)) hardFails.push(`工作流 ${id} 没进 KNOWN_WORKFLOW_IDS → 用户选了它时不会有"未接入"的兜底告警, 排查不到`);
  }
  // ② 每个工作流都要有 RESOLUTION_PROFILES 条目 (漏了 → 落到默认档, 可能发平台不认的字面量)
  for (const id of backendIds) {
    if (!resProfileKeys.includes(id)) hardFails.push(`工作流 ${id} 没有 RESOLUTION_PROFILES 条目 → 分辨率会落到默认档 (可能不是它支持的档位)`);
  }
  // ③ 每个工作流都要有价格标签 (漏了 → 用户选之前看不到花多少钱)
  const priceSet = new Set(priceKeys);
  for (const id of backendIds) {
    if (!priceSet.has(id)) hardFails.push(`工作流 ${id} 没有 AUTODL_COMFYUI_MODEL_PRICES 价格标签`);
  }
  // ④ 软提醒: Ref2V 变体但不在音驱动清单 → 确认它带不带 ref_audio_0~2
  const audioIdSet = new Set(audioVariants);
  for (const id of ref2vVariants) {
    if (!audioIdSet.has(id)) {
      warnings.push(`Ref2V 变体 ${id} 不在【音驱动清单】(REF2V_AUDIO_VARIANTS) → 确认它带不带 ref_audio_0~2: 带的话必须加, 否则合成阶段会用 TTS 替换源音轨 → 声音比嘴型早 (音画不同步)`);
    }
  }
  // ⑤ 软提醒: 新增 Ref2V 变体 → 确认 duration 上限 (1-10 还是 1-15)
  if (ref2vVariants.length) {
    warnings.push('每个 Ref2V 变体都要确认【duration 上限】(参数表 max=10 还是 15) → adapter 的 is15s 判断里要覆盖');
  }

  const allOk = !hasModelMissing && !hasModelExtra && !hasModelOrderDiff && !hasLabelMissing && !hasLabelExtra
    && hardFails.length === 0;

  if (allOk) {
    console.log(`✓ ${backendIds.length} 个 ComfyUI 工作流，前后端完全一致（含 dropdown 中文标签 + 价格 + KNOWN + 分辨率档位）：`);
    backendIds.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${id}`));
    if (warnings.length) {
      console.log('\n⚠️ 提醒（不阻塞，但要确认）：');
      warnings.forEach(w => console.log('  · ' + w));
    }
    console.log('\n  新增工作流的完整清单见: ~/Obsidian/devflow/add-autodl-workflow.md');
    process.exit(0);
  }

  console.error('✗ ComfyUI 工作流列表前后端不一致\n');
  if (hasModelMissing) {
    console.error('  [前端 models 数组] 缺以下 id（后端 adapter 里有）：');
    modelsMissingInFrontend.forEach((id) => console.error(`    + ${id}`));
  }
  if (hasModelExtra) {
    console.error('  [前端 models 数组] 多以下 id（后端已删）：');
    modelsExtra.forEach((id) => console.error(`    - ${id}`));
  }
  if (hasModelOrderDiff) {
    console.error('  [前端 models 数组] 顺序与后端不一致：');
    console.error(`    后端: ${backendIds.join(', ')}`);
    console.error(`    前端: ${frontendIds.join(', ')}`);
  }
  if (hasLabelMissing) {
    console.error('  [前端 AUTODL_COMFYUI_MODEL_LABELS] 缺以下 id（dropdown 会显示 raw id 而不是中文）：');
    labelMissing.forEach((id) => console.error(`    + ${id}`));
  }
  if (hasLabelExtra) {
    console.error('  [前端 AUTODL_COMFYUI_MODEL_LABELS] 多以下 id（后端已删）：');
    labelExtra.forEach((id) => console.error(`    - ${id}`));
  }
  if (hardFails.length) {
    console.error('\n[新工作流完整性检查] 以下几项没过（照着 SOP 补齐）：');
    hardFails.forEach(f => console.error('  ✗ ' + f));
    console.error('  SOP: ~/Obsidian/devflow/add-autodl-workflow.md');
  }
  if (warnings.length) {
    console.error('\n[提醒]');
    warnings.forEach(w => console.error('  · ' + w));
  }
  console.error('\n维护四步走（详见 docs/comfyui-workflows.md 末尾）：');
  console.error('  1. 改 backend/src/services/adapters/autodl-comfyui-workflow.ts 的 WORKFLOW_* + JSDoc');
  console.error('  2. 改 frontend/app/composables/useSettingsAi.ts 的 models 数组（保持同顺序）');
  console.error('  3. 改 frontend/app/composables/useSettingsAi.ts 的 AUTODL_COMFYUI_MODEL_LABELS（dropdown 中文）');
  console.error('  4. 改 docs/comfyui-workflows.md 的「工作流清单」章节');
  process.exit(1);
}

main();

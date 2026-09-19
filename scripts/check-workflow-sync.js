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

  const allOk = !hasModelMissing && !hasModelExtra && !hasModelOrderDiff && !hasLabelMissing && !hasLabelExtra;

  if (allOk) {
    console.log(`✓ ${backendIds.length} 个 ComfyUI 工作流，前后端完全一致（含 dropdown 中文标签）：`);
    backendIds.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${id}`));
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
  console.error('\n维护四步走（详见 docs/comfyui-workflows.md 末尾）：');
  console.error('  1. 改 backend/src/services/adapters/autodl-comfyui-workflow.ts 的 WORKFLOW_* + JSDoc');
  console.error('  2. 改 frontend/app/composables/useSettingsAi.ts 的 models 数组（保持同顺序）');
  console.error('  3. 改 frontend/app/composables/useSettingsAi.ts 的 AUTODL_COMFYUI_MODEL_LABELS（dropdown 中文）');
  console.error('  4. 改 docs/comfyui-workflows.md 的「工作流清单」章节');
  process.exit(1);
}

main();

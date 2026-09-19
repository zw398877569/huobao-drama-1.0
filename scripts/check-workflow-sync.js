#!/usr/bin/env node
// 检查后端 ComfyUI adapter 的 WORKFLOW_* 常量与前端 autodl-comfyui video models 数组是否一致。
//
// 用法: node scripts/check-workflow-sync.js
//       pnpm exec node scripts/check-workflow-sync.js
//
// 退出码:
//   0 = 完全一致
//   1 = 有 diff（缺/多/顺序不一致）
//
// 维护三步走（详见 docs/comfyui-workflows.md 末尾）：
//   1. 改 backend/src/services/adapters/autodl-comfyui-workflow.ts 的 WORKFLOW_* + JSDoc
//   2. 改 frontend/app/composables/useSettingsAi.ts 的 models 数组
//   3. 改 docs/comfyui-workflows.md 的「工作流清单」章节
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
    throw new Error('前端 useSettingsAi.ts 找不到 video 块锚点，结构可能变了');
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

  let backendIds, frontendIds;
  try {
    backendIds = extractBackendWorkflowIds(backendSrc);
  } catch (err) {
    console.error(`✗ 解析后端 adapter 失败: ${err.message}`);
    process.exit(1);
  }
  try {
    frontendIds = extractFrontendVideoModels(frontendSrc);
  } catch (err) {
    console.error(`✗ 解析前端 useSettingsAi 失败: ${err.message}`);
    process.exit(1);
  }

  const setA = new Set(backendIds);
  const setB = new Set(frontendIds);
  const onlyInA = backendIds.filter((x) => !setB.has(x));
  const onlyInB = frontendIds.filter((x) => !setA.has(x));
  const sameLength = backendIds.length === frontendIds.length;
  const sameOrder = sameLength && backendIds.every((x, i) => x === frontendIds[i]);

  if (onlyInA.length === 0 && onlyInB.length === 0 && sameOrder) {
    console.log(`✓ ${backendIds.length} 个 ComfyUI 工作流，后端 adapter 与前端 models 数组一致：`);
    backendIds.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${id}`));
    process.exit(0);
  }

  console.error('✗ ComfyUI 工作流列表前后端不一致\n');
  if (onlyInA.length > 0) {
    console.error('  只在后端 adapter（前端缺）：');
    onlyInA.forEach((id) => console.error(`    + ${id}`));
  }
  if (onlyInB.length > 0) {
    console.error('  只在前端 models（后端缺）：');
    onlyInB.forEach((id) => console.error(`    - ${id}`));
  }
  if (!sameOrder) {
    console.error('  顺序不一致：');
    console.error(`    后端: ${backendIds.join(', ')}`);
    console.error(`    前端: ${frontendIds.join(', ')}`);
  }
  console.error('\n维护三步走（详见 docs/comfyui-workflows.md 末尾）：');
  console.error('  1. 改 backend/src/services/adapters/autodl-comfyui-workflow.ts 的 WORKFLOW_* + JSDoc');
  console.error('  2. 改 frontend/app/composables/useSettingsAi.ts 的 models 数组（保持同顺序）');
  console.error('  3. 改 docs/comfyui-workflows.md 的「工作流清单」章节');
  process.exit(1);
}

main();

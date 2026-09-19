# ComfyUI 工作流目录 (AutoDL H3 三件套)

> 本文档是项目里 ComfyUI 工作流的中文速查表。代码侧以 [`backend/src/services/adapters/autodl-comfyui-workflow.ts`](../backend/src/services/adapters/autodl-comfyui-workflow.ts) 的 `WORKFLOW_*` 常量为单一权威来源；新增/删除工作流时**两边都要改**。

## 平台信息

- **平台**: AutoDL ComfyUI 托管工作流
- **调用方式**: `POST {baseUrl}/comfyui/comfyui_workflow/{workflowId}`
- **鉴权**: 裸 token，不带 Bearer（`Authorization: {apiKey}`）
- **适配器**: `AutoDLComfyUIWorkflowAdapter`（`backend/src/services/adapters/autodl-comfyui-workflow.ts`）

## 术语

| 缩写 | 全称 | 含义 |
|------|------|------|
| T2V | Text-to-Video | 文生视频，只有 prompt 没有图 |
| FL2V | First-Last-to-Video | 首尾帧生视频，给首帧+尾帧 |
| Ref2V | Reference-to-Video | 多图参考生视频，给 1-9 张参考图 |

## 工作流清单

### 1. `minimax_h3_lightx2v_no_pic` — T2V 文生视频

- **用途**: 纯文字生成视频，没有参考图
- **时长**: 1-10s
- **分辨率**: 480p竖 / 480p横 / 768p竖 / 768p横（**不支持 1080p**）
- **输入**: 仅 `prompt` + 可选 `duration`、`resolution`
- **触发条件**: storyboard 里 `referenceMode = none` 且没有 first/last frame 时
- **场景**: 完全没有角色/场景参考图，只能靠 prompt 描述画面的分镜

### 2. `minimax_h3_lightx2v` — FL2V 首尾帧生视频

- **用途**: 给两张图（首帧、尾帧）让模型补出中间的视频
- **时长**: 1-10s
- **分辨率**: 480p竖 / 480p横 / 768p竖 / 768p横（**不支持 1080p**）
- **输入**: `prompt` + `first_frame` URL + `last_frame` URL
- **触发条件**: `referenceMode = first_last` 或同时提供了 firstFrameUrl + lastFrameUrl
- **场景**: 镜头有明确起止画面，需要平滑过渡的转场

### 3. `minimax_h3_lightx2v_v5` — Ref2V 多图参考 (1-10s)

- **用途**: 多张参考图生成视频
- **时长**: 1-10s（11s 以上自动切到 v5_15s）
- **分辨率**: 480p / 768p / **1080p 横竖都支持**（autodl 文档支持 1080p）
- **输入**: `prompt` + 最多 9 张 `ref_image_0..8` URL
- **触发条件**: `referenceMode = multiple`（多张参考图）或 `single`（1 张参考图）且 duration ≤ 10
- **场景**: 短镜头（≤10s）需要角色/场景一致性的画面

### 4. `minimax_h3_lightx2v_v5_15s` — Ref2V 多图参考 (1-15s)

- **用途**: v5 的 15 秒长版
- **时长**: 1-15s
- **分辨率**: 480p / 768p / **1080p 横竖都支持**
- **输入**: `prompt` + 最多 9 张参考图
- **触发条件**: `referenceMode = multiple/single` 且 11 ≤ duration ≤ 15
- **场景**: 长镜头（11-15s）需要多图参考

### 5. `minimax_h3_zm_u24` — Ref2V 升级画质版 (zm_u24)

- **用途**: v5 的画质升级变体，质量优先
- **时长**: 1-15s
- **分辨率**: 480p / 768p（**不支持 1080p**）
- **输入**: `prompt` + 最多 9 张参考图（**支持音频输入**）
- **触发条件**: 用户在前端 model 弹窗显式选了 `minimax_h3_zm_u24`
- **场景**: 强调成片质量、可接受稍长生成时间的镜头
- **注意**: 只在 mode = multiple/single 时生效；选了但 storyboard 是 first_last/none 会被 adapter 静默 fallback 到 FL2V/T2V 并写一条 `model-mode-mismatch` 日志

### 6. `minimax_h3_zm_u08` — Ref2V 高速版 (zm_u08)

- **用途**: v5 的高速变体，速度优先
- **时长**: 1-15s
- **分辨率**: 480p / 768p（**不支持 1080p**）
- **输入**: `prompt` + 最多 9 张参考图（**支持音频输入**）
- **触发条件**: 用户显式选了 `minimax_h3_zm_u08`
- **场景**: 迭代阶段、需要快速出图验证构图/节奏的镜头
- **注意**: 同上，选了但模式不匹配会被 fallback

### 7. `minimax_h3_image_audio_to_video_v2` — Ref2V 多图+多音频 (1-10s)

- **用途**: 多张参考图 + 多段音频驱动生成视频（口型/配乐同步）
- **时长**: 1-10s
- **分辨率**: 480p / 768p / **1080p 横竖都支持**
- **输入**: `prompt` + 最多 9 张参考图 + 多段音频（**autodl 文档支持音频驱动**）
- **触发条件**: 用户显式选了 `minimax_h3_image_audio_to_video_v2`
- **场景**: 角色台词/旁白需要对口型，或需要配乐驱动画面节奏
- **注意**: 当前前端没接 `audioUrls` schema，audio 字段还是空的（Phase 3b 再加）

### 8. `minimax_h3_image_audio_to_video_v2_15s` — Ref2V 多图+多音频 15s 版

- **用途**: v2 音频版的 15 秒长版
- **时长**: 1-15s
- **分辨率**: 仅 480p / 768p（**不支持 1080p**）
- **输入**: `prompt` + 最多 9 张参考图 + 多段音频
- **触发条件**: 用户显式选了 `minimax_h3_image_audio_to_video_v2_15s`
- **场景**: 长镜头（11-15s）需要音频驱动
- **注意**: 同 audio v2 的限制

## 路由速查

adapter 按以下优先级自动选工作流（无显式选择时）：

```
referenceMode = first_last (或同时有 first+last frame)
  └→ FL2V: minimax_h3_lightx2v (1-10s)

referenceMode = multiple (≥1 张参考图) 或 single (1 张参考图)
  └→ Ref2V: pickRef2VWorkflowId(duration)
       ├ duration ≤ 10: minimax_h3_lightx2v_v5
       └ duration 11-15: minimax_h3_lightx2v_v5_15s

referenceMode = none 且没有 first/last frame
  └→ T2V: minimax_h3_lightx2v_no_pic (1-10s)
```

用户显式选了 `zm_u24 / zm_u08 / image_audio_to_video_v2 / image_audio_to_video_v2_15s` 时：
- mode 必须是 `multiple` 或 `single`，否则静默 fallback
- fallback 时写 `task-logger` 的 `model-mode-mismatch` 日志，按 videoGenId 可查

## 时长上限对照

| 工作流 | 时长上限 |
|--------|---------|
| T2V / FL2V / Ref2V v5 / image_audio v2 | 1-10s |
| Ref2V v5_15s / zm_u24 / zm_u08 / image_audio v2_15s | 1-15s |

超过上限的 duration 会被 adapter 截断到上限，不报错。

## 分辨率对照

| 工作流 | 支持的分辨率 |
|--------|------------|
| T2V / FL2V | 480p竖/横、768p竖/横 |
| Ref2V v5 / v5_15s / image_audio v2 | 480p竖/横、768p竖/横、**1080p竖/横** |
| zm_u24 / zm_u08 / image_audio v2_15s | 480p竖/横、768p竖/横 |

adapter 通过 `aspectRatio` 自动映射（9:16/3:2→竖，16:9/4:3→横），不支持的纵横比 fallback 到 768p竖。

## 维护规则

1. **新增工作流**: 按四步走：① 后端 adapter 加 `WORKFLOW_*` 常量 + JSDoc；② 前端 `useSettingsAi.ts` 的 `models` 数组加条目 + 行内注释；③ 同一文件顶部 `AUTODL_COMFYUI_MODEL_LABELS` 加中文标签（**否则 dropdown 显示 raw id**）；④ 本文件加一节。
2. **删除工作流**: 反向操作四步；`REF2V_VARIANTS` 数组也要同步。
3. **修改工作流名**: autodl 平台改工作流 id 时，全局搜 `minimax_h3_` 确认无遗漏。

## 一键 drift 检查

`scripts/check-workflow-sync.js` 用正则扫后端 adapter 的 `WORKFLOW_*` 常量与前端 `useSettingsAi.ts` 的 autodl-comfyui video models 数组，对比是否一致（数量 + 顺序），不一致 exit 1 并列出差异。

```bash
node scripts/check-workflow-sync.js   # 或 ./scripts/check-workflow-sync.js
```

每次改完三处后跑一下，提交前确认 exit 0。漏掉任一步会立刻报哪边缺哪个 id。

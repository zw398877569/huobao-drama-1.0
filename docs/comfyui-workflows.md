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
- **分辨率**: 480p / 768p（**不支持 1080p**）
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

### 9. `minimax_h3_803` — Ref2V 九图三音 15s 画质增强版

- **用途**: 九图参考 + 三段音频 + 15 秒 + 高分辨率档（性价比最优）
- **时长**: 1-15s
- **分辨率**: 480p / 768p / **1088p** / 1440p（横竖都支持）
  ★ ★ 与其它工作流不同: 803 的分辨率字面量【带分辨率数字】——
  `768p竖(768*1376)` / `1088p竖(1088*1920)` / `1088p横(1920*1088)` / `1440p竖(1440*2560)` / `1440p横(2560*1440)`
  （其它工作流是裸名 `768p竖` / `1080p横`）→ 字面量发错平台直接报参数错
- **默认档**: 1088p（¥0.060/秒，5s 一镜 ¥0.30 —— 比 v5 的 1080p ¥0.100/秒 = ¥0.50 便宜 40% 且更清晰）
- **输入**: `prompt` + 最多 9 张参考图 + 多段音频（ref_audio_0~2）
- **触发条件**: 用户显式选了 `minimax_h3_803`
- **注意**: 它是【音频工作流】—— 本镜没有配音时按既有 `no_audio_fallback` 规则退普通 Ref2V (v5)，也就用不到 1088p 档
- **mode 字段**: 本期不传（平台默认即高质模式）

### 10. `minimax_h3_zm_nono` — Ref2V 影视画质版 (zm_nono)

- **用途**: 多图参考 + 多段音频 + 影视画质（AutoDL 近 7 天调用量第二的主力档位）
- **时长**: 1-15s
- **分辨率**: 480p / 768p / **960p**（横竖都支持）★ **没有 1:1 方图档**（平台枚举就这六个）
- **默认档**: 768p（¥0.050/秒，与 zm_u24/zm_u08 同价 → 不涨价）；960p 是可选档（¥0.100/秒，贵 100%）
- **输入**: `prompt` + 最多 9 张参考图 + 多段音频（ref_audio_0~2）
- **触发条件**: 用户显式选了 `minimax_h3_zm_nono`
- **注意（★ 别按名字臆测差异，以参数表为准）**:
  - 参数表里【没有 seed】（同族其它工作流都有）→ 平台会报参数错。adapter 一律不传 seed → 天然安全
  - `ref_audio` 只接受 `audio/mpeg` 与 `audio/wav`（【**不接受 flac**】）→ adapter 送 nono 前会过滤 flac 并记 flow-log
  - 它是【音频工作流】→ 合成阶段按既有规则【保留源音轨】（Sprint 38 T3-D 的音驱动清单已含它）

### 11. `minimax_h3_zm_u30` — Ref2V 超清画质版 (zm_u30)

- **用途**: 多图参考 + 多段音频 + 超清画质（AutoDL 近 7 天调用量第一的主力档位）
- **时长**: 1-15s
- **分辨率**: 480p / 768p / **960p**（横竖都支持）★ **没有 1:1 方图档**
- **默认档**: 768p（¥0.050/秒，与 u24/u08 同价）；960p 可选（¥0.090/秒，贵 80%）
- **输入**: `prompt` + 最多 9 张参考图 + 多段音频（ref_audio_0~2）
- **触发条件**: 用户显式选了 `minimax_h3_zm_u30`
- **注意**: 参数表里【有 seed】（nono 没有）；`ref_audio` 接受 `audio/flac` / `audio/mpeg` / `audio/wav`
- ★ 平台这几个 zm 变体的「详情」文案完全一样 → 名字不同不代表功能不同，**以参数表为准**

## 分辨率档位下拉（Sprint 43 / PM msg-20261115-183）

【视频生成】页的**模型选择器后面**多了一个**分辨率下拉**：

- 选项随**所选工作流**变（选完工作流就把该工作流支持的档位加载进下拉）
- 存的是**档位**（`960p`）而不是**字面量**（`960p竖`）→ 竖/横由每个分镜的 `aspectRatio` 决定
  （用户选 960p → 竖屏镜发 `960p竖`、横屏镜发 `960p横`、1:1 的镜落 `960p竖`）
- 档位表的**事实来源是后端** `RESOLUTION_PROFILES` → `GET /api/v1/videos/autodl-comfyui/resolutions`
  → 前端不会跟后端漂移
- 换工作流 → 档位自动回到新工作流的**默认档**；选了它不支持的档位 → 后端落回默认档并记
  `VideoTask/resolution-tier-invalid`（不报错，不让整次生成失败）
- 走的是 `video_generations.resolution` 列（该列本来就存在、一直没用过 → **不需要改表结构**）

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

用户显式选了 `zm_u24 / zm_u08 / image_audio_to_video_v2 / image_audio_to_video_v2_15s / minimax_h3_803 / zm_nono / zm_u30` 时：
- mode 必须是 `multiple` 或 `single`，否则静默 fallback
- fallback 时写 `task-logger` 的 `model-mode-mismatch` 日志，按 videoGenId 可查

## 时长上限对照

| 工作流 | 时长上限 |
|--------|---------|
| T2V / FL2V / Ref2V v5 / image_audio v2 | 1-10s |
| Ref2V v5_15s / zm_u24 / zm_u08 / image_audio v2_15s / 803 / zm_nono / zm_u30 | 1-15s |

超过上限的 duration 会被 adapter 截断到上限，不报错。

## 分辨率对照

| 工作流 | 支持的分辨率 |
|--------|------------|
| T2V / FL2V | 480p竖/横、768p竖/横 |
| Ref2V v5 / image_audio v2 | 480p竖/横、768p竖/横、**1080p竖/横** |
| Ref2V v5_15s | 480p竖/横、768p竖/横（**不支持 1080p** —— 官方枚举只有这两档 + 1:1） |
| zm_u24 / zm_u08 / image_audio v2_15s | 480p竖/横、768p竖/横 |
| zm_nono / zm_u30（Sprint 42） | 480p竖/横、768p竖/横、**960p竖/横** —— ★ **没有 1:1 方图档**（枚举就这六个）<br>★ 960p 的【实际输出宽高】平台枚举里没写 → **待实跑一次确认**（见下方 TODO） |
| 803 (九图三音 15s) | 480p / 768p / **1088p** / 1440p —— ★ 字面量【带分辨率数字】(`1088p竖(1088*1920)` / `1088p横(1920*1088)`) |

adapter 通过 `aspectRatio` 自动映射（9:16/3:2→竖，16:9/4:3→横），不支持的纵横比 fallback 到 768p竖。

★ **裸名字面量的实际输出宽高**（2026-11-14 实跑确认）：`768p横` = **1344×768**（不是 1920×1080 那一类）。
其余档位待实跑补齐：768p竖 / 480p横 / 480p竖 / **960p横 / 960p竖**（平台枚举只给名字，真实宽高以产物 ffprobe 为准）。
★ Sprint 42: zm_nono / zm_u30 的 fallback 也是 `768p竖`（合法字面量）→ 1:1 的 storyboard 不会被发出 1:1 字面量。
  默认档 = **768p**（与 u24/u08 同价 ¥0.050/秒，不涨价）；960p 是可选档位（nono ¥0.100/秒 / u30 ¥0.090/秒）。

> **TODO（Sprint 42 / PM msg-20261114-181）**：960p 档的**实际输出宽高**平台枚举里没写（`960p竖` / `960p横` 只是名字），
> 需要实跑一次（选 zm_nono 或 zm_u30 + 960p + 竖/横各一次）从返回的视频里读出真实宽高，再补进本表。
> 参考同族 803 的字面量：`768p竖(768*1376)` / `1088p竖(1088*1920)` / `1440p竖(1440*2560)` —— 裸名档位的实际宽高以平台为准。
★ Sprint 34 起: 分辨率【按工作流】取（adapter 的 `RESOLUTION_PROFILES`），不再全局只有 4 个字面量。
  每个工作流一份合法档位 + 默认档；803 的默认档 = 1088p, 其它工作流的默认档与之前逐字一致。

## 视频参考图分层：道具图 vs 首尾帧（Sprint 36 追加，PM msg-20261107-159）

| 路线 | 判据 | 视频层带不带道具图 | 为什么 |
|---|---|---|---|
| 有首尾帧 | `referenceMode=first_last` 或有 `firstFrameUrl/lastFrameUrl` | **不带** | 首/尾帧本来就是带着道具图生成的 → 道具在帧里已定型；再喂一张独立道具产品照 = 模型多画一个实物 = 穿模（实测 drama19 镜#3：视频里两个保温箱，一个还跟身体相交） |
| 无首尾帧 | `referenceMode=multiple / single` | **带**（追加在末尾） | 这条路线没有帧，道具图是唯一的权威参考，删了道具在视频里会失控/变形 |

- 判据是【帧在不在】，**不是**『镜头文本有没有提到这个道具』—— 文本只是代理指标，帧才是真相。
- 实现在共享层 `services/adapters/prop-refs.ts`（`hasFrameRefs(record)` + `mergePropRefsIntoSlots`）→ 6 个 provider 一起生效，不用分 provider 改。
- **帧层（首帧/尾帧生成）的道具参考图收集不动** —— 那是道具在画面里定型的机制。
- **D1 分支**（用户显式选了 Ref2V 变体 + `mode=first_last` → 首/尾帧以 `ref_image_0/1` 传）时，视频 prompt 末尾会追加一句：
  `Image 1 is the START frame of this shot; Image 2 is the END frame of this shot; the motion between them must be one continuous take inside this shot; do not introduce any object that is not already visible in these frames.`
  —— 平台不知道图1/图2 是起止帧，不点明模型就自由发挥（这就是「镜与镜衔接生硬」的技术根因之一）。
  真正的 FL2V 工作流（`minimax_h3_lightx2v`，走 `first_frame/last_frame` 专用字段）**不加**这句。
- flow-log：`video-ref-slots` 的 `propCount` 能看出这次带没带道具图（带 >0 / 不带 =0）；被跳过时另记一条 `prop-refs-skipped-for-frames`。
- ★ 136 单（sprint-31）验收第 1 条「镜3 视频请求里能查到 ≥3 张参考图且含道具图」**已作废**（与本规则直接冲突）→ 见 `~/Documents/aicg-collab/handoff/PM_to_DEV_sprint-31-video-prop-reference-20261102-136.json` 里的标注。

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

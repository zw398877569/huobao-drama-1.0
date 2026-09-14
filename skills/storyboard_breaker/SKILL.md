---
name: storyboard-breaker
description: 分镜拆解专业规范
---

# 分镜拆解指南

## 拆解原则

每个镜头聚焦**单一动作**，描述要详尽具体。每个镜头时长推荐 **5-10 秒**（节奏紧凑、镜头信息密度合适）。

## 硬约束（数据层 + API 都会拒）

- `duration` 单位是**秒**（integer）
- **合法范围: 4-15 秒**（MiniMax-H3 官方 API 限制，超出会 400）
  - 落库前会强制 clamp 到这个范围：`< 4` → 4，`> 15` → 15
  - 所以你 `save_storyboards` / `update_storyboard` 时即便给 2 或 20，DB 落库是 4 或 15
- 推荐区间 **5-10 秒** 是节奏建议，不是硬约束
- 即使要短镜头也别低于 4 秒（MiniMax-H3 不支持）；要长镜头拆成两个 15 秒以内的镜头
- 同集总时长 = Σ duration 秒；不要塞超过 60s 的内容到一集

## 镜头要素

1. **镜头标题**：3-5字概括核心内容（如"噩梦惊醒"）
2. **时间**：具体时分 + 光线描述
3. **地点**：场景完整描述 + 空间布局 + 环境细节
4. **景别**：远景/全景/中景/近景/特写
5. **角度**：平视/仰视/俯视/侧面/背面
6. **运镜**：固定/推镜/拉镜/摇镜/跟镜/移镜
7. **动作**：谁 + 具体怎么做 + 肢体细节 + 表情
8. **对话**：该镜头的完整对话
9. **画面结果**：动作的即时后果 + 视觉细节
10. **氛围**：光线 + 色调 + 声音 + 整体氛围
11. **时长**：每个镜头 10-15 秒
12. **静态画面提示词**：`image_prompt`，用于首帧/尾帧/镜头图片生成
13. **视频提示词**：`video_prompt`，按 3 秒分段的视频生成描述（必填）
14. **配乐提示词**：`bgm_prompt`，描述该镜头适合的配乐风格
15. **音效提示词**：`sound_effect`，描述该镜头关键环境音/动作音
16. **场景关联**：若能匹配已有场景，必须填写 `scene_id`
17. **角色关联**：填写 `character_ids`，绑定当前镜头涉及的 0 到多个角色

## 视频提示词格式

每个镜头必须包含 `video_prompt` 字段，用于驱动 AI 视频生成：

```
0-3秒：<location>咖啡厅</location>，近景，<role>小明</role>低头看手机，表情焦虑。
<n>3-6秒：<location>咖啡厅</location>，全景，门铃响，<role>小红</role>推门走入。
<n>6-9秒：<location>咖啡厅</location>，中景，<role>小红</role>微笑走向小明，坐下。
```

标签说明：
- `<location>地点</location>` — 场景标记
- `<role>角色名</role>` — 角色标记
- `<voice>角色名</voice>` — 画外音/旁白标记
- `<n>` — 时间段分隔符

## 使用步骤

1. 调用 `read_storyboard_context` 读取剧本、角色、场景、已有分镜摘要
2. 先基于剧本完成镜头拆解，确保总时长和叙事连续性合理
3. 为每个镜头补全完整字段：`title / shot_type / angle / movement / location / time / character_ids / action / dialogue / description / result / atmosphere / image_prompt / video_prompt / bgm_prompt / sound_effect / duration / scene_id`
4. 调用 `save_storyboards` 一次性保存完整分镜
5. 如需调整，调用 `update_storyboard` 修改具体镜头

## 场景关联规则

- 优先使用 `read_storyboard_context` 返回的 `scenes`
- `location + time` 可明确匹配时，必须回填正确 `scene_id`
- 不要凭空生成不存在的场景 ID
- 如果剧本内容明显落在已有场景中，不要重复创造新场景描述

## 角色绑定规则

- `character_ids` 必须从 `read_storyboard_context` 返回的角色列表中选择
- 一个镜头可以没有角色，也可以绑定多个角色
- 只要镜头里有明确出场、被看见、发生动作或说话的角色，都应绑定进去
- 纯环境镜头、空镜头、物件镜头可以传空数组

## 质量要求

- `description` 要适合人读，`video_prompt` 要适合模型生成，二者不要互相替代
- `image_prompt` 要突出单帧构图、角色外观、环境和光线
- `video_prompt` 要突出时间推进、动作变化、镜头语言
- `bgm_prompt` 和 `sound_effect` 用简洁短语即可，但不能空泛到只有“紧张”“悲伤”

## 全 provider 时长/分辨率/比例速查表

下面是从 `backend/src/services/adapters/*-video.ts` 源码 + API 文档汇总的硬约束。**这是各 provider 实际能接受的取值范围,不是建议**。落库前 storyboard-tools 会做兜底 clamp。

| Provider | Adapter 文件 | duration 范围 | resolution 选项 | ratio 必填性 | 备注 |
|---|---|---|---|---|---|
| **MiniMax-H3 (官方 V2)** | `minimax-official-video.ts` | **4-15s** | `480P` / `768P` / `2K` (默认 `768P`) | t2va 必填且非 adaptive; i2va/r2va 可填 adaptive | 当前主用 |
| **autodl-comfyui H3 v5** | `autodl-comfyui-workflow.ts` | **1-10s** | `480p竖/横` / `768p竖/横` / `1080p横` | 不接 ratio, 接 resolution | 多图参考 ≤ 9 |
| **autodl-comfyui H3 v5_15s** | 同上 | **1-15s** | `480p竖/横` / `768p竖/横` (无 1080) | 同上 | |
| **autodl-comfyui H3 zm_u24** | 同上 | **1-15s** | `480p竖/横` / `768p竖/横` / `480p(1:1)` / `768p(1:1)` | 不接 ratio, 接 resolution | 升级画质 |
| **autodl-comfyui H3 zm_u08** | 同上 | **1-15s** | 同上 | 同上 | 高速版 |
| **autodl-comfyui H3 image_audio_v2** | 同上 | **1-10s** | `480p竖/横` / `768p竖/横` / `1080p竖/横` | 不接 | 多图+多音频 |
| **autodl-comfyui H3 image_audio_v2_15s** | 同上 | **1-15s** | `480p竖/横` / `768p竖/横` | 不接 | 多图+多音频 15s 版 |
| **阿里 wan2.6-i2v-flash** | `ali-video.ts` | **5-15s** | `720P` / `1080P` (按 ratio 自动) | 9:16 → 720P; 其它 → 1080P | 当前推荐 preset |
| **volcengine (doubao-seedance)** | `volcengine-video.ts` | **4-12s** | unknown | ratio 必填 | 已有内部 clamp |
| **minimax-video (chatfire 代理)** | `minimax-video.ts` | **4-10s** (估算) | unknown | ratio 写进 prompt | 走 chatfire 代理到 MiniMax V1, 实际范围依赖 chatfire 实现 |
| **Agnes** | `agnes-video.ts` | 帧数 `duration*24` ≤ 441 (≈18s) | 720P | ratio 9:16 / 16:9 二选一 | 走帧数, 24fps 换算 |
| **Vidu** | `vidu-video.ts` | unknown | unknown | unknown | 待补 |
| **MiniMax-H3-Max (极速版)** | 同 official | **5-15s** | `480P` / `768P` (无 2K) | 同 official | 不支持 2K, 不支持多模态参考 |
| **T2V / 文本生视频** | 全部 | 走上面 provider 对应行 | 同上 | ratio 必填且非 adaptive | 没有 first_frame / last_frame 时 mode 走 none |

**怎么用**:
1. 拆镜时 `duration` 写到 4-15 之间即可, 落到 5-10 是最稳的
2. storyboard-tools 自动 clamp 超界值, adapter 也再保一道
3. 切换 provider 不会破坏数据 (因为 storyboard.duration 在表里, 切换只影响请求字段)
4. ratio / resolution 字段由用户在生成时按当前选中的 model 决定, 不影响 storyboard 数据

## duration 字段历史 (避免再踩坑)

- 2026-09-14 之前: skill 只说「10-15 秒」, agent prompt 说「5-15s」, 但没硬约束, LLM 经常输出 2/3/20
- 2026-09-14 commit `c5b1f1e`:
  - adapter `minimax-official-video.ts` 加 `clamp(4, 15)` (请求时)
  - `storyboard-tools.ts` 的 `save_storyboards` / `update_storyboard` 入参 mutate clamp (落库前)
  - 即便 LLM 越界输出, DB 落库和 API 请求都是合规的
  - skill 文档同步更新, 把硬约束写明, 避免 agent 不参考本 skill 又再越界

- 若存在旁白，统一写入 `dialogue`，格式为 `旁白：内容`

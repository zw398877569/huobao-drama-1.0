---
name: h3-official-prompt
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio.
agent: storyboard_breaker
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. fl2va.md / ref2va.md are plain Markdown reference docs and work in Codex, Claude Code, Cursor, or any other agent harness.
---


# MiniMax H3 官方 Prompt 模板

本 skill 包含 MiniMax 官方发布的视频 prompt 写作规范，是写 `video_prompt` 时的权威参考。

## 文件清单

- `fl2va.md` — T2VA / I2VA / FL2VA / L2VA 四类 prompt 的完整结构（首尾帧/参考帧怎么嵌、3 段核心字段怎么写）
- `ref2va.md` — R2V 多图参考模式专属规范（detailed_description / analysis / 6 段输出格式）

## 调用规则

- 写 T2VA / I2VA / FL2VA / L2VA 任一类型的 `video_prompt` 时 → 先读 `fl2va.md`
- 写 R2V（reference / 多图参考）的 `video_prompt` 时 → 先读 `ref2va.md`
- 如果同时是多图参考 + 首尾帧 → 两个文件都要参考
- 自检：`video_prompt` 的输出必须能套进这两个文件的"最终结构"模板里

## 优先级

- 本 skill 是 MiniMax 官方权威规范，与主 prompt 里的 vault-aligned 规则不冲突时**优先遵守本 skill**
- 冲突时（如"对白必须按时间戳嵌入" vault 规则 vs H3 官方 `<d>` 标签），以能更好对齐 H3 实际 API 期望为准（参考但不冲突的部分全部遵守）

---



---

## TL;DR — 写 `video_prompt` 时

1. **第一行必是 reference 指令**(I2VA / FL2VA / L2VA 各自固定句式,见 fl2va.md §2.1)
2. **空一行**
3. **3 个 core 字段**:`integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:`
4. **multimodal_description 内部用 `[Shot 1] ... [Shot N]` 串联**
5. **时间戳用秒.SS 格式**(例 `0.00`, `5.50`)
6. **冲突时本 skill > 主 prompt 的 vault 规则**(H3 官方优先)

## 何时读同目录的 .md(按需 load,不要全塞 prompt)

| 任务 | 读哪个 |
|---|---|
| T2VA / I2VA / FL2VA / L2VA prompt 写作 | `fl2va.md` |
| R2V 多图参考模式 | `ref2va.md` |
| 同时多参考 + 首尾帧 | 两个都读 |

## 自检

你的 `video_prompt` 输出**必须**能套进 `fl2va.md` 的"Final Prompt Structure"模板(§2)。
如果套不进去,说明漏了 reference 指令行 / 缺了 3 个 core 字段 / 时间戳格式错。

## 关键事实(H3 必知)

- H3 默认时长 **5s 或 10s**(不要写超长)
- **首帧图像决定视觉风格** — image prompt 要明确风格/构图/光影(下游首帧用)
- I2VA / FL2VA 的 `<Picture 1>` / `<Picture 2>` 引用必须保留在 prompt 里
- `overall_soundscape` 涵盖**整段视频**的环境音,不要拆到每个 shot
- `non_diegetic_music` 角色听不见的音乐(纯旁白/情绪用)

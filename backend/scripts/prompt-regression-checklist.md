# prompt 全链路回归清单 (Sprint 22 Task B)

> PM msg-20261025-089 Task B。**固定 5 个样本** —— 固定后这组样本可长期复用做 A/B 对比,
> 也是 Sprint 23 (MiniMax H3 模板) 的对照基线。
>
> 自动化脚本: `backend/scripts/prompt-regression.mjs` (触发 + 抓 flow-log 原始证据 + 判 prompt 层)
> 视觉层 (抽帧) 由人/QA 确认, 在本文件的"视觉判定"段打勾。

## 怎么跑

```bash
# 前置: 用户已在 win host 改完两个 agent 的 max_tokens (voice_assigner / grid_prompt_generator → 8192)
#       并已部署含 sprint-22 rule F 改动的镜像 (CI rebuild + docker compose pull && restart backend)

cd /Users/mac/Documents/aicg-dev/huobao-drama-1.0
node backend/scripts/prompt-regression.mjs --samples all --out /tmp/regression-report.md

# 只重跑判定 (不触发生成, 用已有 flow-log):
node backend/scripts/prompt-regression.mjs --samples all --no-trigger
```

⚠️ **S1 会清掉 episode 15 的全部分镜及其图片/配音/视频** (Step3 是 DELETE+INSERT 重建 storyboard)。
想保留现有资产就改跑别的一集, 或先备份。

---

## S1 拆解链路 — episode 15 (drama 15, 雨夜最后一单)

覆盖: 2 角色 (林达/王秀兰) + 1 旁白 + 4 场景 + 18 镜 (多角色对白 / 旁白 / 无对白 / 多场景切换)

| 检查项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| step1 返回 shot_plan | 18 镜左右 | | ☐ |
| step2 返回 shot_details | 18 镜左右 | | ☐ |
| scene_id 单调不减 | ✓ | | ☐ |
| duration 分布 | 全部 4~15s, 报告 min/max/avg | | ☐ |
| 多角色 dialogue 规范化 | 单行多角色 → 拆成多行 | | ☐ |
| video_prompt 三段式 + Sprint17 四注入块 | 齐全 | | ☐ |
| 时长体系 (Σ 收敛 / 场景密度区间) | 每 scene 的 Σ 落在密度档区间 | | ☐ |

## S2 生图-角色 — 林达 (characterId=44)

28 岁男性 / 长方脸 / 短发 / 黑色雨衣 —— 验证中性背景约束 + 外貌保留

| 检查项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| LLM 改写成功 (没走 fallback) | ✓ | | ☐ |
| **输出长度接近输入** (不被压到 240) | outLen/inLen ∈ 0.6~1.6 | | ☐ |
| 改写保留外貌关键词 | raincoat | | ☐ |
| 最终 prompt 含中性背景硬约束 | no outdoor scenery | | ☐ |

## S3 生图-场景 — scene 48 (五零一室内, 含"冒热气的面碗")

★ rule F 改动的直接效果观测点, 也是用户 2026-10-09 老 bug ("场景图里有个不存在的人物") 的闭环验证

| 检查项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| LLM 改写成功 (没走 fallback) | ✓ | | ☐ |
| **输出长度接近输入** (不被硬撑到 240) | outLen/inLen ∈ 0.6~1.6 | | ☐ |
| 改写保留"面碗" | noodle | | ☐ |
| **改写里没有人物词** | 无 woman/man/person/eating/sitting | | ☐ |
| 最终 prompt 含 no-people 硬约束 | no people | | ☐ |

## S4 生图-角色网格图 (grid) — episode 15 的 shot 16/17/18 拼 1×3

> episode 15 **没有道具** (props 表为空), 所以 S4 改用角色网格图。
> 顺带覆盖 `grid_prompt_generator` —— 它的 max_tokens 原本 4096 (体检报告点名的定时炸弹之一),
> 用户改完 8192 后这里才有意义。

| 检查项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| 网格图请求已发出 | HTTP 200 | | ☐ |
| LLM 改写成功 (没走 fallback) | ✓ | | ☐ |
| 输出长度接近输入 (不被压到 240) | outLen/inLen ∈ 0.6~1.6 | | ☐ |

## S5 视频 — shot 16/17/18 三连镜 (drama 15)

验证 Sprint 17 注入块 (角色外貌/承接上一镜/戏型节奏/首帧锚点) + Sprint 15 台词时间轴

| 检查项 (每个镜头) | 期望 | 实际 | 判定 |
|---|---|---|---|
| 三段式 header 齐全 | Integrated/Overall soundscape/Non-diegetic music | | ☐ |
| Sprint17 四注入块齐全 | Character appearance / Continuity from the previous shot / End of this shot / Pacing: | | ☐ |
| 台词时间轴在 | 开口:' | | ☐ |
| prompt 长度 < 10000 | ✓ | | ☐ |

---

## 视觉判定 (抽帧人工确认)

- [ ] **S2 角色图**: 背景中性/纯色 (不是户外院子/街道) + 写实 (不是 FLAT VECTOR 动漫线稿) + 脸型发型服装跟立绘一致
- [ ] **S3 场景图**: **画面里没有任何人物** + "冒热气的面碗" 还在 (不是"有人在吃面")
- [ ] **S4 网格图**: 3 格画面都在, 没有多余的人物/元素
- [ ] **S5 三连镜**: 人物长相跨镜一致 + 画面位置接得上 + 台词时间轴在

## 已知遗留 (本单不修, 记档)

- `agent_configs.voice_assigner.max_tokens` 2048 / `grid_prompt_generator` 4096 —— 用户手动改 8192 (配置数据, 不用重新部署)
- 角色网格图 (grid) 的 grid_prompt_generator 之前长期没跑, 其 prompt 长度是否超上限**没有实测样本** —— 跑 S4 时顺便看一眼
- 其余: 见 DEV_to_PM_msg-20261025-088.json 的体检报告

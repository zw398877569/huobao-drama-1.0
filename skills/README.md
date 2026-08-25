# Agent Skills 目录约定

每个 Agent 的 prompt 由两部分组成:
- **主 prompt** (`backend/src/agents/index.ts` 的 `DEFAULT_PROMPTS`) — 行为骨架(决策框架/硬约束)
- **Skills** (本目录) — 参考细节(具体格式/例子/场景补充)

改主 prompt 动架构(决策维度/工作流),改 skill 动细节(具体规范/例子)。**优化 Agent 行为优先走 skill 这条路**。

## 文件命名约定

```
skills/
├── README.md                                  ← 本文件
├── <agent_type>/                              ← 按 agent 分类(必需)
│   ├── SKILL.md                              ← 该 agent 默认 skill(每个 agent 一个)
│   └── <skill_name>/                          ←  (可选) 该 agent 的额外 skill
│       └── SKILL.md
├── _shared/                                   ← (可选) 所有 agent 共享的 skill
│   └── <skill_name>/SKILL.md
└── ...                                        ← 嵌套深度不限
```

`<agent_type>` 与 `backend/src/agents/index.ts` 的 `validAgentTypes` 一致:
- `script_rewriter`
- `extractor`
- `storyboard_breaker`
- `voice_assigner`
- `grid_prompt_generator`
- `scene_intention`

## SKILL.md 格式

```markdown
---
name: human-readable-name           ← UI 显示名
description: 一句话功能描述         ← Settings → Skills tab 列表显示
agent: <agent_type>                 ← (可选) 覆盖路径归属, 可写单个或数组
---

# 标题

正文内容(任意 markdown)。
```

## 加载规则(优先级从高到低)

1. **frontmatter `agent:` 字段** — 强制归到指定 agent,可写 `agent: foo` 或 `agent: [foo, bar]`
2. **路径前缀** — `skills/<agent_type>/...` 默认归到 `<agent_type>` agent
3. **`_shared/`` 目录** — 加载到所有 agent

辅助文件(如 `reference/*.md`、`examples/*.json`)不会被加载,只是开发者参考。

## 加载机制

`backend/src/agents/skills.ts` 在 agent 启动时扫描整个 `skills/` 目录,根据上述规则决定每个 agent 应该加载哪些 skill。**新增 skill 不需要改任何代码,只要重启服务即可生效**。

## 添加新 skill 的工作流

1. 在 `skills/<agent_type>/<new_skill>/SKILL.md` 创建文件
2. 写 YAML frontmatter(name + description) + 正文
3. 重启服务(`docker compose restart huobao-drama`)
4. 验证:在 Settings → Skills 管理 tab 应能看到新 skill 出现在对应 agent 下

## 调试

```ts
import { listAgentSkills, loadAgentSkills } from './src/agents/skills'

listAgentSkills('storyboard_breaker')
// → ['storyboard_breaker', 'storyboard_breaker/wuxia']

loadAgentSkills('storyboard_breaker')
// → 返回拼好的 markdown 字符串,直接注入到 agent 的 system prompt
```

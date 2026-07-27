## Workflow 集成完成

### 核心实现

**1. scene-intention.ts** — 完整的 Mastra Agent 工具工厂

- `analyzeSceneIntentionInternal()`：核心意图分析函数，注入 8 种戏剧功能模板到 prompt，支持 AI API 调用 + fallback 机制
- `createSceneIntentionTools(episodeId, dramaId)`：暴露两个工具给工作流：
  - `analyze_episode_scene_intention`：分析单个分镜的戏剧意图，接收 storyboard_id，自动读取场景上下文（location/time/characters/action/description），返回 {intention, function, visualStrategy, template}
  - `analyze_all_episode_scene_intentions`：批量分析整集所有分镜，跳过已有意图的记录

- `createSceneIntentionAgent()`：Mastra Agent 实例，instructions 中包含工作流程说明，tools 绑定到上述工具

**2. index.ts** — 注册与集成

- 添加所有工具函数的导入
- scene_intention case：`tools = createSceneIntentionTools(episodeId, dramaId)`（不再是空的 `{}`）
- storyboard_breaker instructions 更新：添加"【导演思维】"步骤，明确说明需要先通过工具分析戏剧意图再推导镜头参数，包含具体工具名称和戏剧功能枚举

**3. director-intent-templates.ts** — 导出 IntentionResult 类型

### 调用关系图

```
storyboard_breaker agent
    ├── read_storyboard_context (获取剧本/场景信息)
    ├── analyze_episode_scene_intention (scene_intention agent 的工具) ← WORKFLOW INTEGRATION
    │   └── 返回: {intention, function, visualStrategy, template}
    └── save_storyboards (生成分镜保存)
        └── shot_type/movement/atmosphere 应服务于 scene_intention.function 和 visualStrategy
```

### 关键特性

- **松耦合**：scene_intention 是完全独立的 agent，通过标准工具接口被其他 agent 调用，符合"导演与分镜师分离"的原则
- **实际 LLM 调用**：analyzeSceneIntentionInternal 使用 existing ai service 的 text provider 调用 LLM
- **fallback 机制**：当 AI API 不可用时退化为基于关键词的启发式分析
- **模板指导**：分析结果附带 INTENTION_TEMPLATES，让 storyboard_breaker 有完整的视觉策略参考
- **可回滚**：sceneIntention 字段为 nullable，不破坏现有分镜数据
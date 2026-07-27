## Workflow 集成——自动触发实现方案

### 核心思路

在 `read_storyboard_context` 工具中**内联**场景意图分析，将分析结果返回给 storyboard_breaker agent，使其在生成分镜时可直接参考意图数据。这是最轻量、最高效的集成方式。

### 修改点

**1. backend/src/agents/scene-intention.ts**  
- 导出纯分析函数 `analyzeSceneIntentionForContext`（可重用版本）
- 保留现有的 `analyzeSceneIntentionInternal` 用于工具层

**2. backend/src/agents/tools/storyboard-tools.ts**  
- 导入意图分析函数
- 扩展 `read_storyboard_context`：在构建 payload 后，对每个 scene 并行计算意图
- 将意图附加到返回的 `scenes` 数组中：`{ ..., intention: { function, visualStrategy, template } }`

**3. backend/src/agents/index.ts**  
- storyboard_breaker instructions 微调：说明 `scenes` 中已包含 intention 信息，可直接参考

这样 workflow 链条变为：
```
storyboard_breaker:
  1. read_storyboard_context → 返回带 intention 的 scenes
  2. LLM 依据 intention 指导生成每个镜头的参数（shot_type, movement, angle, atmosphere）
  3. save_storyboards → 保存结果
```

对用户完全透明：只需发起一次请求，意图分析和生成分镜自动完成。
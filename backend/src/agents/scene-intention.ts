import { db, schema } from '../db/index'
import { eq, and, or } from 'drizzle-orm'
import { logTaskProgress, logTaskSuccess } from '../utils/task-logger'
import { getTextConfig, getTextChatCompletionsUrl } from '../services/ai'
import { INTENTION_TEMPLATES, type DramaticFunctionKey, type IntentionResult } from './director-intent-templates'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'

// Common dramatic functions for short dramas — seedance-inspired
const DRAMATIC_FUNCTIONS = [
  '揭露',      // Reveal
  '对峙',      // Confrontation
  '反转',      // Twist
  '铺垫',      // Setup
  '高潮',      // Climax
  '余韵',      // Aftermath/Emotional resonance
  '悬念',      // Suspense
  '情感爆发',   // Emotional explosion
] as const;

type DramaticFunction = typeof DRAMATIC_FUNCTIONS[number];

/**
 * Schema validation for LLM-returned intention JSON.
 * Required fields: function (must be DRAMATIC_FUNCTIONS), intention (non-empty short string),
 * visualStrategy (non-empty). Optional fields: cameraSpeed, shortDramaTips.
 *
 * Plan C (2026-09-22): reject truncated/malformed responses, force retry.
 */
type IntentionParseResult =
  | { ok: true; value: { function: DramaticFunction; intention: string; visualStrategy: string; cameraSpeed: string; shortDramaTips: string } }
  | { ok: false; reason: string }

function validateIntentionShape(parsed: unknown): IntentionParseResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'not an object' }
  }
  const obj = parsed as Record<string, any>
  // function: must be one of DRAMATIC_FUNCTIONS
  if (!obj.function || !DRAMATIC_FUNCTIONS.includes(obj.function)) {
    return { ok: false, reason: `invalid or missing function: "${obj.function}"` }
  }
  // intention: must be non-empty Chinese-string-ish (>= 5 chars), reject "推导失败" placeholder
  if (!obj.intention || typeof obj.intention !== 'string' || obj.intention.trim().length < 5) {
    return { ok: false, reason: 'intention too short or missing' }
  }
  if (/推导失败|未获得有效回复|placeholder/i.test(obj.intention)) {
    return { ok: false, reason: 'intention is a placeholder/empty filler' }
  }
  // visualStrategy: must be non-empty (LLM outputs as visual_strategy in our prompt; accept both keys)
  const visualStrategy = obj.visualStrategy || obj.visual_strategy
  if (!visualStrategy || typeof visualStrategy !== 'string' || visualStrategy.trim().length < 5) {
    return { ok: false, reason: 'visualStrategy too short or missing' }
  }
  return {
    ok: true,
    value: {
      function: obj.function as DramaticFunction,
      intention: obj.intention.trim(),
      visualStrategy: visualStrategy.trim(),
      cameraSpeed: typeof obj.cameraSpeed === 'string' ? obj.cameraSpeed.trim() : '',
      shortDramaTips: typeof obj.shortDramaTips === 'string' ? obj.shortDramaTips.trim() : '',
    },
  }
}

/**
 * 核心意图分析函数 — 供外部工具和 agent 调用
 * @param location 场景地点
 * @param time 时间段
 * @param characters 角色名称列表
 * @param action 动作描述
 * @param dialogue 对白
 * @param description 场景氛围
 */
export async function analyzeSceneIntentionInternal(
  location: string,
  time: string,
  characters: string[],
  action: string,
  dialogue: string,
  description: string
): Promise<IntentionResult> {
  try {
    const config = await getTextConfig();
    const baseUrl = getTextChatCompletionsUrl(config);

    // Enhanced prompt with template reference and structured output requirements
    const scenePrompt = `=== 场景信息 ===
地点：${location}
时间：${time}
角色：${characters.join('、')}
动作：${action}
对白：${dialogue}
场景氛围：${description}

=== 戏剧功能模板参考 ===
以下是短剧中常见的戏剧功能及其视觉策略（请从中选择一个最符合的）：

揭露：关键信息突然呈现——特写、侧光缓慢推镜、揭示表情变化
对峙：人物对抗——过肩镜头、冷色调分割光线、交替特写反转
反转：颠覆预期——前后对比画面、固定转快速摇晃、照明突变
铺垫：建立基础——全景扫视、缓慢平移、自然光
高潮：激烈时刻——低机位倾斜角度、频闪强光、快速剪辑
余韵：情感回响——空镜背影、固定机位柔和微光
悬念：未解之谜——局部特写主观视角、黑暗中微弱光
情感爆发：情绪释放——面部微距特写、手持轻微晃动

=== 任务 ===
你是一位专业导演。请分析这一镜在叙事上的戏剧功能，并输出统一的导演意图和视觉策略。

参考上述模板，选择最贴合的场景功能类型，然后回答。如果场景对应的模板中包含运镜速度（cameraSpeed）或竖屏特别提示（shortDramaTips），请一并输出。

输出格式（严格 JSON，无额外文本）：{
  "intention": "一句话概括本镜的戏剧目的",
  "function": "从以下精确选择一个：揭露、对峙、反转、铺垫、高潮、余韵、悬念、情感爆发",
  "visual_strategy": "具体的镜头/灯光/调度如何服务于这个意图，包含景别、运镜方式、光线设计等具体建议",
  "cameraSpeed": "运镜速度描述，如'快速(<1秒)'、'缓慢(5-10秒)'或'固定'，可选",
  "shortDramaTips": "针对竖屏短视频的拍摄建议，如'居中构图'、'避开状态栏'等，可选
}"`;

    // Plan C (2026-09-22): response_format: json_object 强制 JSON-only + max_tokens 131072
    //   解决 max_tokens: 500 截断 (LLM 先写 thinking 再写 JSON, thinking 越长 JSON 越残)
    //   response_format 在 API 层禁止 thinking preamble, 模型只能在 {...} 内输出
    //   max_tokens 131072 给 JSON 留够余量 (MiniMax-M3 上限 512K)
    const rawContent = await callIntentionLLMWithRetry(baseUrl, config, scenePrompt);

    const validation = validateIntentionShape(parseLooseJson(rawContent));
    if (!validation.ok) {
      // 已 retry 过 2 次还失败 → 抛错让外层 try/catch 走 fallback
      throw new Error(`intention validation failed: ${validation.reason}`);
    }
    const parsed = validation.value;
    const tmpl = INTENTION_TEMPLATES[parsed.function];
    return {
      intention: parsed.intention,
      function: parsed.function,
      visualStrategy: parsed.visualStrategy,
      cameraSpeed: parsed.cameraSpeed,
      shortDramaTips: parsed.shortDramaTips,
      shotDensity: tmpl?.shotDensity,
      recommendedDuration: tmpl?.recommendedDuration,
    };
  } catch (error: any) {
    console.warn('SceneIntention AI call failed, using fallback:', error.message);
    return fallbackAnalyzeIntention(location, time, characters, action, dialogue, description);
  }
}

/**
 * Loose JSON parser: handles responses where LLM adds prose around JSON
 * (e.g. trailing "Here is the JSON: ..." or wrapping in markdown ```json).
 * Tries strict JSON.parse first; falls back to extracting the first {...} block.
 */
function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  // 1. Direct parse
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // 2. Strip markdown code fence ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  // 3. Extract first { ... } block (greedy up to last })
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch { /* fall through */ }
  }
  throw new Error('no JSON object found in response');
}

/**
 * LLM call with retry + structured output.
 * - Attempt 1: response_format: json_object, prompt unchanged
 * - Attempt 2 (if attempt 1 returns invalid): same call, prompt appended with strict reminder
 * - If both attempts return invalid: throw; outer try/catch falls back to heuristic
 */
async function callIntentionLLMWithRetry(
  baseUrl: string,
  config: any,
  scenePrompt: string,
): Promise<string> {
  const MAX_ATTEMPTS = 2;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const userPrompt = isRetry
      ? scenePrompt + '\n\n[严格模式] 这次只输出 JSON 对象 {...}, 禁止任何前后文本/解释/思考块, 否则视为失败。'
      : scenePrompt;

    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        // Plan C: API 层强制 JSON-only output (MiniMax-M3 OpenAI 兼容 API 支持)
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a professional film director analyzing scenes for dramatic intention. Output ONLY a single JSON object with no preamble, no explanation, no markdown code fences.' },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        // Plan C: 500 → 131072 (MiniMax-M3 推荐 128K, 给 JSON 留余量 + 防 thinking 抢占)
        max_tokens: 131072,
      }),
      signal: AbortSignal.timeout(60_000),  // Plan C: 30s → 60s (大 max_tokens 可能慢)
    });

    if (!resp.ok) throw new Error(`AI API error: ${resp.status}`);

    const data = await resp.json();
    const rawContent = data?.choices?.[0]?.message?.content?.trim();

    if (!rawContent) {
      lastErr = new Error('No response content from AI');
      continue;
    }

    // Validate right here — if valid, return; if not, retry
    const validation = validateIntentionShape(parseLooseJson(rawContent));
    if (validation.ok) {
      return rawContent;
    }
    lastErr = new Error(`attempt ${attempt}: ${validation.reason}`);
    console.warn(`[SceneIntention] attempt ${attempt} validation failed: ${validation.reason}; raw_len=${rawContent.length}`);
  }

  throw lastErr ?? new Error('max attempts reached without valid response');
}

function fallbackAnalyzeIntention(location: string, time: string, characters: string[], action: string, dialogue: string, description: string): IntentionResult {
  const actionLower = action.toLowerCase();

  if (actionLower.includes('爆炸') || actionLower.includes('冲突') || actionLower.includes('打斗')) {
    return {
      intention: '展现激烈冲突或危险时刻',
      function: '高潮' as DramaticFunction,
      shotDensity: 'high',
      recommendedDuration: { min: 3, max: 5 },
      visualStrategy: '快速剪辑，手持摄影，紧张的光线变化，强调动作力度',
    };
  }

  if (actionLower.includes('发现') || actionLower.includes('揭示') || actionLower.includes('真相')) {
    return {
      intention: '关键信息的揭示时刻',
      function: '揭露' as DramaticFunction,
      shotDensity: 'medium',
      recommendedDuration: { min: 5, max: 8 },
      visualStrategy: '特写镜头，聚焦面部表情变化，逐渐拉近以增强紧张感',
    };
  }

  if (actionLower.includes('面对') || actionLower.includes('对峙') || actionLower.includes('争吵')) {
    return {
      intention: '人物之间的直接对抗',
      function: '对峙' as DramaticFunction,
      shotDensity: 'medium',
      recommendedDuration: { min: 5, max: 8 },
      visualStrategy: '过肩镜头，交替特写，表现权力关系和情绪张力',
    };
  }

  return {
    intention: '普通叙事场景',
    function: '铺垫' as DramaticFunction,
    shotDensity: 'low',
    recommendedDuration: { min: 10, max: 15 },
    visualStrategy: '标准景别，平光照明，中性运镜',
  };
}

/**
 * 导出供其他模块调用的分析函数（简化版）
 * @param sceneContext 场景上下文信息
 */
export async function analyzeSceneIntentionForScene(
  sceneContext: {
    location: string;
    time: string;
    characters: string[];
    action: string;
    description: string;
    dialogue?: string; // optional
  }
): Promise<IntentionResult> {
  return analyzeSceneIntentionInternal(
    sceneContext.location,
    sceneContext.time,
    sceneContext.characters,
    sceneContext.action,
    sceneContext.dialogue || '',
    sceneContext.description
  );
}

/**
 * 从数据库获取已有分镜的意图（已保存的分析结果）
 */
export async function getStoryboardStoryIntent(storyboardId: number): Promise<IntentionResult | null> {
  const row = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).first();
  if (!row || !row.sceneIntention) return null;

  try {
    return JSON.parse(row.sceneIntention) as IntentionResult;
  } catch (e) {
    console.error('Failed to parse sceneIntention from DB:', e);
    return null;
  }
}

/**
 * 将意图分析结果保存到数据库
 */
export async function saveStoryboardIntent(storyboardId: number, intention: IntentionResult): Promise<void> {
  await db.update(schema.storyboards)
    .set({
      sceneIntention: JSON.stringify(intention),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.storyboards.id, storyboardId))
    .run();
}

/**
 * 场景意图分析工具工厂
 * 注入 episodeId 和 dramaId，用于工作流上下文
 */
export function createSceneIntentionTools(episodeId: number, dramaId: number) {
  /**
   * 分析指定分镜的戏剧意图 — 这是 workflow 集成的关键工具
   * storyboard_breaker 可以通过调用此工具，在生成分镜前获取每场戏的意图
   */
  const analyzeEpisodeSceneIntention = createTool({
    id: 'analyze_episode_scene_intention',
    description: 'Analyze the dramatic intention of a specific shot in the current episode based on its context.',
    inputSchema: z.object({
      storyboard_id: z.number().int().min(1).describe('The ID of the storyboard shot to analyze'),
    }),
    execute: async ({ storyboard_id }) => {
      // 先读取该分镜的完整上下文
      const sb = await db.select().from(schema.storyboards)
        .where(and(eq(schema.storyboards.id, storyboard_id), eq(schema.storyboards.episodeId, episodeId)))
        .first();

      if (!sb) {
        throw new Error(`Storyboard ${storyboard_id} not found or not in episode ${episodeId}`);
      }

      // 获取对应的角色信息（如果有）
      const charLinks = await db.select()
        .from(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id))
        .all();
      const characterIds = charLinks.map((c: { characterId: number }) => c.characterId);
      const characters = await db.select({ name: schema.characters.name })
        .from(schema.characters)
        .where(eq(schema.characters.id, characterIds[0] || 0)) // Simplified: fetch by individual IDs in loop or use inArray separately
        .all();
      const characterNames = characters.map((c: { name: string }) => c.name);

      // 执行意图分析
      const result = await analyzeSceneIntentionInternal(
        sb.location || '',
        sb.time || '',
        characterNames.length > 0 ? characterNames : ['未知角色'],
        sb.action || '',
        sb.dialogue || '',
        sb.description || ''
      );

      // 保存结果到数据库（可选：只在明确请求时保存）
      await saveStoryboardIntent(storyboard_id, result);

      logTaskSuccess('SceneIntentionTool', 'analyze-intention', {
        episodeId,
        storyboardId: storyboard_id,
        function: result.function,
        intentionLength: result.intention.length,
      });

      return {
        storyboard_id: storyboard_id,
        intention: result.intention,
        function: result.function,
        visualStrategy: result.visualStrategy,
        template: INTENTION_TEMPLATES[result.function],
      };
    },
  });

  /**
   * 批量分析一集的所有分镜（用于一次性为整集生成意图）
   */
  const analyzeAllEpisodesSceneIntentions = createTool({
    id: 'analyze_all_episode_scene_intentions',
    description: 'Analyze dramatic intentions for all storyboards in the current episode.',
    inputSchema: z.object({}),
    execute: async () => {
      logTaskProgress('SceneIntentionTool', 'analyze-all-begin', { episodeId });

      // 获取该集所有分镜
      const storyboards = await db.select()
        .from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(schema.storyboards.storyboardNumber)
        .all();

      const results = [];
      for (const sb of storyboards) {
        // 如果已有意图则跳过（除非用户强制重新分析）
        if (sb.sceneIntention) {
          continue;
        }

        const charLinks = await db.select()
          .from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
          .all();
        const characterIds = charLinks.map((c: { characterId: number }) => c.characterId);

        // 获取角色名称（如果有的话）
        let characterNames: string[] = [];
        if (characterIds.length > 0) {
          // 简单方法：对每个 storyboard 单独查询角色
          const chars = await db.select({ name: schema.characters.name })
            .from(schema.characters)
            .where(characterIds.map((id: number) => eq(schema.characters.id, id)).reduce((acc: any, cond: any) => or(acc, cond), eq(schema.characters.id, characterIds[0])))
            .all();
          characterNames = chars.map((c: { name: string }) => c.name);
        }

        if (characterNames.length === 0) {
          characterNames = ['未知角色'];
        }

        const result = await analyzeSceneIntentionInternal(
          sb.location || '',
          sb.time || '',
          characterNames,
          sb.action || '',
          sb.dialogue || '',
          sb.description || ''
        );

        await saveStoryboardIntent(sb.id, result);
        results.push({ storyboard_id: sb.id, ...result });
      }

      logTaskSuccess('SceneIntentionTool', 'analyze-all-complete', {
        episodeId,
        analyzedCount: results.length,
      });

      return { episodeId, count: results.length, results };
    },
  });

  return { analyzeEpisodeSceneIntention, analyzeAllEpisodesSceneIntentions };
}

/**
 * Mastra Scene Intention Agent 创建器
 * @param episodeId - 当前剧集ID
 * @param dramaId - 当前剧集所属剧集ID
 */
export function createSceneIntentionAgent(episodeId: number, dramaId: number) {
  const tools = createSceneIntentionTools(episodeId, dramaId);

  const instructions = `你是一位专业导演，擅长分析剧本并提炼每场戏的戏剧意图。使用 available tools 完成以下工作流程：

工作流程：
1. 使用 analyzeEpisodeSceneIntention 分析单个分镜的戏剧意图；或使用 analyzeAllEpisodesSceneIntentions 分析整集所有分镜
2. 返回分析结果：戏剧意图（intention）、戏剧功能类型（function）、视觉策略（visual_strategy）以及完整的模板指导

重要原则：Direct the scene, don't decorate it. — 每个镜头都应该有明确的戏剧目的。

可使用的工具：
- analyzeEpisodeSceneIntention: 分析单个分镜的意图，需要 storyboard_id
- analyzeAllEpisodesSceneIntentions: 分析整集所有分镜的意图

如果你收到的是分镜拆解请求，请先使用 tools 分析意图，然后将意图作为 storyboard_breaker 生成镜头参数的依据。
`;

  return new Agent({
    id: 'scene_intention',
    name: '导演意图推导',
    instructions,
    model: undefined, // 实际模型会在 createAgent 函数中注入
    tools,
  });
}

-- Migration: 2026-09-25 — 加 sanitizer 专用 AI config
-- Purpose: PM msg-20260924-006 Q5 task_B — 让 PromptSanitizer LLM 优先用 deepseek-chat
--   (不输出 thinking block), 没配才回退 'text' (MiniMax-M3 推理模型 — thinking 占 token)
--
-- Forward only. 幂等: 已存在同 name + serviceType 行不重复插.
--
-- 手动执行:
--   docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /app/backend/migrations/manual-2026-09-25-add-sanitizer-config.sql"
--
-- 验证 (执行后):
--   SELECT id, service_type, name, provider, model, is_active FROM ai_service_configs WHERE service_type='sanitizer';
--   -- 应看到 1 行 active=1 的 sanitizer 配置
--
-- 说明:
--   - 用户应把 <deepseek-api-key> 替换成自己的 deepseek API key
--   - provider='openai' 因为 deepseek 用 OpenAI 兼容端点
--   - model='deepseek-chat' (非推理模型, 不输出 thinking block)
--   - base_url='https://api.deepseek.com/v1'
--   - priority=0 (跟其他 text/audio/video config 一致)

INSERT INTO ai_service_configs (
  service_type, name, provider, model, api_key, base_url, priority, is_active, created_at, updated_at
) SELECT
  'sanitizer', 'sanitizer-dedicated', 'openai', '["deepseek-chat"]',
  '<deepseek-api-key>', 'https://api.deepseek.com/v1', 0, 1,
  datetime('now'), datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM ai_service_configs WHERE service_type = 'sanitizer' AND name = 'sanitizer-dedicated'
);

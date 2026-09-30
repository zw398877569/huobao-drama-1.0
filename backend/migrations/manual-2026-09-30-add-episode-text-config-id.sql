-- Migration: 2026-09-30 — episodes.text_config_id (分镜拆解模型持久化)
-- Purpose: PM msg-20260930-001 Task A — 用户测 DeepSeek 分镜拆解能力, 持久化选中的 text config
-- 跟 image/video/audio config_id 风格一致 (episodes 表加列, ensureColumn 自动 ALTER)
--
-- Forward only. 幂等 (ADD COLUMN IF NOT EXISTS 在 SQLite 3.35+ 支持, 旧版 sqlite3 直接 ignore).
-- backend/src/db/index.ts 启动时会自动跑 ensureColumn('episodes', 'text_config_id', 'INTEGER'),
-- 但这个 SQL 给手动跑 / DB Browser 看.
--
-- 手动执行 (Windows host):
--   docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db 'ALTER TABLE episodes ADD COLUMN text_config_id INTEGER'"
-- 或 (DB Browser for SQLite):
--   打开 D:\aicg1.0\data\huobao_drama.db → 执行 → ALTER TABLE episodes ADD COLUMN text_config_id INTEGER
--
-- 验证:
--   PRAGMA table_info(episodes);  -- 应该看到 text_config_id INTEGER 列
--   SELECT text_config_id FROM episodes LIMIT 5;  -- 默认 NULL (没选 model 走 getActiveConfig('text') fallback)

ALTER TABLE episodes ADD COLUMN text_config_id INTEGER;

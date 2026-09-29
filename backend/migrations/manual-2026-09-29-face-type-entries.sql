-- Migration: 2026-09-29 — face_type_entries 表 (face-archive 同步)
-- Purpose: PM msg-20260929-002 Task A — face-archive 集成 P0
-- 数据源: ~/Obsidian/cronTask/aicg-demo/data/face-types.json (Mac cron push)
-- 应用位置: characters.ts imagePrompt 拼接 + grid-prompt-tools.ts generateCharacterPrompt
-- Schema 对应: backend/src/db/schema.ts (faceTypeEntries)
--
-- Forward only. 幂等 (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
-- 已经手动跑的 cleanup 旧条目用 DELETE FROM face_type_entries (按需, 不在本 SQL).
--
-- 手动执行 (Windows host):
--   docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /path/to/manual-2026-09-29-face-type-entries.sql"
-- 或 (Mac 直接, 走 SMB 共享的 DB 副本慎用):
--   sqlite3 /Volumes/aicg1.0/data/huobao_drama.db < backend/migrations/manual-2026-09-29-face-type-entries.sql
--
-- 验证:
--   SELECT name FROM sqlite_master WHERE type='table' AND name='face_type_entries';
--   SELECT COUNT(*) FROM face_type_entries;  -- 0 (空表, 等 Mac push)
--   SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='face_type_entries';  -- 4

-- ----------------------------------------------------------------------------
-- 1. face_type_entries 表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS face_type_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  factor        TEXT NOT NULL,              -- Face / Hair / Costume / 晚宴露背裙装 / 比基尼 / 肤色
  external_id   TEXT NOT NULL,              -- face-archive 原始 ID (entry.grossid)
  name          TEXT NOT NULL,              -- 中文名 (e.g. "鹅蛋脸")
  name_en       TEXT,                       -- 英文名 (e.g. "Oval Face")
  data          TEXT NOT NULL,              -- 整条 JSON 序列化 (prompt_tokens + 其它字段)
  prompt_tokens TEXT,                       -- 冗余字段 — 常用 query 走索引不扫 text(data)
  gender        TEXT,                       -- 女/男/null
  source        TEXT NOT NULL DEFAULT 'face-archive',
  archived_at   TEXT NOT NULL,              -- face-archive last_updated (sync 边界判定)
  synced_at     TEXT NOT NULL,              -- 本次同步时间 (排查同步延迟)
  created_at    TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- 2. 4 索引
-- ----------------------------------------------------------------------------
-- (a) 唯一索引: factor + external_id (sync 防重复插入)
CREATE UNIQUE INDEX IF NOT EXISTS idx_face_type_factor_external
  ON face_type_entries (factor, external_id);

-- (b) 查询索引: factor + gender (few-shot 高频 query: 按 factor 过滤 + 跨 gender)
CREATE INDEX IF NOT EXISTS idx_face_type_factor_gender
  ON face_type_entries (factor, gender);

-- (c) 查询索引: archived_at DESC (code-side 精选: 按 archived_at DESC LIMIT N 取最新采集)
CREATE INDEX IF NOT EXISTS idx_face_type_archived_at
  ON face_type_entries (archived_at DESC);

-- (d) 查询索引: synced_at DESC (排查同步延迟 / 看最近一次 sync 时间)
CREATE INDEX IF NOT EXISTS idx_face_type_synced_at
  ON face_type_entries (synced_at DESC);

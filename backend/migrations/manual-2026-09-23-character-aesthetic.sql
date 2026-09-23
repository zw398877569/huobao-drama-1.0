-- Migration: 2026-09-23 16:00 UTC — add character_aesthetic column to dramas
-- Purpose: PM msg-20260923-002 fix #2 — 让 drama.style (整体风格) 与 candidate-aesthetic (角色美学) 分离
--   drama.style      = 剧集整体美术风格 (写实/动漫/电影感等) — 不变
--   character_aesthetic = 角色美学 (east-asian / western / neutral) — 新增
--
-- 兼容性:
--   - 列 nullable, 无 default, 现有 dramas 行此列 NULL → 代码侧 fallback 'neutral' (不注入 token)
--   - 这等价于现状 (没有东亚/欧美强制, 模型自由发挥), 不影响现有 drama 视觉效果
--
-- 回退:
--   ALTER TABLE dramas DROP COLUMN character_aesthetic;
--
-- 手动执行 (用 sqlite3 cli / DB Browser for SQLite / better-sqlite3 REPL):
--   sqlite3 backend/data/huobao_drama.db < migrations/manual-2026-09-23-character-aesthetic.sql
--
-- 验证 (执行后):
--   sqlite3 backend/data/huobao_drama.db ".schema dramas"  | 应看到 character_aesthetic TEXT
--   sqlite3 backend/data/huobao_drama.db "SELECT COUNT(*) FROM dramas WHERE character_aesthetic IS NULL;"  | 应等于现有 dramas 总数

ALTER TABLE dramas ADD COLUMN character_aesthetic TEXT;

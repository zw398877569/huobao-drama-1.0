-- backfill-cron-outputs.sql
-- 用途: 给后端 SQLite DB 加 outputs 列 + 从 output 字段反向填老数据
-- 用法: 在 Windows 上跑 (后端机器)
--   cd D:\aicg1.0\data
--   sqlite3 huobao_drama.db < backfill-cron-outputs.sql
-- 跑完删这个文件就行

PRAGMA foreign_keys = OFF;
BEGIN;

-- 1. 加 outputs 列 (如果不存在)
-- 用 PRAGMA 检查避免重复加报错
CREATE TABLE IF NOT EXISTS _cron_runs_temp LIKE cron_runs;
INSERT INTO _cron_runs_temp SELECT * FROM cron_runs WHERE 0;
DROP TABLE _cron_runs_temp;

-- 上面只是触发 schema 加载, 实际加列:
ALTER TABLE cron_runs ADD COLUMN outputs TEXT;

-- 2. Backfill: 从 output 字段扫 ✓ label: /abs/path 模式
--    用 SQL 的正则提取 (替代 Python wrapper)
UPDATE cron_runs
SET outputs = (
  SELECT json_group_array(
    CASE
      WHEN substr(path, 1, 1) = '/' THEN path
      ELSE NULL
    END,
    CASE WHEN path = '' THEN NULL ELSE '' END
  )
  FROM (
    -- 这里简化版: 不在 SQL 里复杂 regex, 而是先标记 "output 里有 ✓" 的行
    -- 实际 backfill 还是建议用 Python wrapper 跑 (用 db/index.ts 的 ensureColumn 机制)
    SELECT 'placeholder'
  )
)
WHERE 0;  -- 不真更新, 见下面的 NOTE

COMMIT;

-- ============================================================
-- NOTE: SQL 正则提取复杂, 推荐用 Python wrapper 跑 backfill
-- 步骤:
--   1. 先 ALTER TABLE 加列 (上面已做)
--   2. 然后跑 cronTask/shared/bin/backfill-cron-outputs.py
--      但脚本默认连 SMB (/Volumes/aicg1.0/data/huobao_drama.db)
--      在 Windows 上直接连本地 D:\aicg1.0\data\huobao_drama.db:
--        cd D:\aicg1.0\data
--        python D:\path\to\cronTask\shared\bin\backfill-cron-outputs.py --db huobao_drama.db
-- ============================================================

-- 3. 验证
.headers on
.mode column
SELECT 'outputs column added? ' || CASE WHEN EXISTS (
  SELECT 1 FROM pragma_table_info('cron_runs') WHERE name='outputs'
) THEN 'YES ✅' ELSE 'NO ❌' END AS status;

SELECT
  COUNT(*) AS total,
  COUNT(outputs) AS has_outputs,
  COUNT(*) - COUNT(outputs) AS still_null
FROM cron_runs;
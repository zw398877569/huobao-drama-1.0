-- Migration: 2026-09-24 — split characters.appearance → appearance_permanent + appearance_plot_state
-- Purpose: PM msg-20260924-002 — 解决角色立绘 plot 态污染 (dramaId=7 characterId=21 案例)
--
-- Forward only. 幂等 (重跑无副作用: WHERE appearance_permanent IS NULL 守卫).
--
-- 逻辑 (两阶段):
--   1. Phase 1 (本 SQL): 简单行 — 不含 plot 阶段关键词 (早期/中期/后期/高潮/衰) → 整段进 appearance_permanent
--   2. Phase 2 (Node.js 脚本): 复杂行 — 含 plot 阶段关键词 → 按关键词位置切段
--      脚本: backend/migrations/run-2026-09-24-split-character-appearance.ts
--      映射: 早期→铺垫, 中期→skip, 后期→高潮, 高潮→高潮, 衰亡→余韵
--
-- 手动执行:
--   Phase 1: sqlite3 /app/data/huobao_drama.db < backend/migrations/manual-2026-09-24-split-character-appearance.sql
--   Phase 2: cd backend && npx tsx migrations/run-2026-09-24-split-character-appearance.ts
--
-- 验证:
--   SELECT COUNT(*) FROM characters WHERE appearance_permanent IS NULL AND appearance IS NOT NULL AND appearance != '';
--   -- Phase 1 + Phase 2 都跑过应为 0

-- ----------------------------------------------------------------------------
-- Phase 1: simple rows (no plot 阶段 keywords) → permanent = appearance
-- ----------------------------------------------------------------------------
UPDATE characters
SET appearance_permanent = appearance
WHERE appearance_permanent IS NULL
  AND appearance IS NOT NULL
  AND appearance != ''
  AND appearance NOT LIKE '%早期%'
  AND appearance NOT LIKE '%中期%'
  AND appearance NOT LIKE '%后期%'
  AND appearance NOT LIKE '%高潮%'
  AND appearance NOT LIKE '%衰%';

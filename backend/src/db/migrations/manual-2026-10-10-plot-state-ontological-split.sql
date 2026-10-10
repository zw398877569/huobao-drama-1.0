-- ============================================================
-- V2 治本迁移 (PM msg-20261010-001)
-- 主题: plot_state 归属从 character 移到 storyboard
-- 原因: 角色立绘 (PERMANENT) 字段被 LLM 污染塞入剧情态 (PLOT_STATE) 关键词,
--       导致跨镜别的剧情像「按钮/狂笑/反转/奄奄奄奄奄」被意外注入不相关镜别。
--       V2 治本: schema 字段强制分离, 不靠关键词黑名单。
--
-- 执行时机: 用户第一次部署这次改动时, 手工执行一次。
-- 执行环境: docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /path/to/this.sql"
-- 备注: image_prompt_plot_state / video_prompt_plot_state 两列会被 ensureColumn 自动加,
--       这里列出来仅作为文档说明。
-- ============================================================

-- 1) characters 表 DROP plot_state 列 (错位置, 治本后不需要)
--    安全: 这一列本不应该填数据 (供 raw 缓存), DROP 不会丢真实数据
ALTER TABLE characters DROP COLUMN appearance_plot_state;

-- 2) characters 表 RENAME appearance → appearance_permanent
--    目的: Sprint 1 实际是 ADD COLUMN, 没真 RENAME; 现在补上治本对齐
--    安全: 跨环境列名需要一致, Sprint 1 已迁完数据 (用户拍板 2026-09-24)
--    跳转保证: 跑这条前先验证老列是否有数据
--      SELECT COUNT(*) FROM characters WHERE appearance IS NOT NULL AND appearance_permanent IS NULL;
--      应当返回 0 行 (Sprint 1 已迁)
ALTER TABLE characters RENAME COLUMN appearance TO appearance_permanent;

-- 3) storyboards 表 ADD image_prompt_plot_state 列
--    会被 ensureColumn 自动跑 (image_prompt_plot_state = TEXT), 这里列出仅作文档
--    ALTER TABLE storyboards ADD COLUMN image_prompt_plot_state TEXT;

-- 4) storyboards 表 ADD video_prompt_plot_state 列
--    会被 ensureColumn 自动跑 (video_prompt_plot_state = TEXT), 这里列出仅作文档
--    ALTER TABLE storyboards ADD COLUMN video_prompt_plot_state TEXT;

-- ============================================================
-- ROLLBACK (PM D7: rollback 简化, ALTER TABLE DROP COLUMN 是常规 SQL)
-- ============================================================
-- DROP plot_state 列 → 重新 EXTRACT:
--   ALTER TABLE storyboards DROP COLUMN image_prompt_plot_state;
--   ALTER TABLE storyboards DROP COLUMN video_prompt_plot_state;
-- 恢复 characters 原表结构:
--   ALTER TABLE characters ADD COLUMN appearance_plot_state TEXT;
--   ALTER TABLE characters RENAME COLUMN appearance_permanent TO appearance;
--   (注意: RENAME 会丢 appearance_plot_state 列定义, 要先 ADD plot_state 再 RENAME)

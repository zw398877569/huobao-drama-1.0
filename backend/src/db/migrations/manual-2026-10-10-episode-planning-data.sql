-- ============================================================
-- V4 架构迁移 (PM msg-20261010-003)
-- 主题: episodes 加 planning_data 列存 3 步 endpoint 中间态
-- 原因: V3 治完内容 (5 维 enum), 但分镜拆解仍是 1 步 endpoint 一次跑完 738s 黑盒,
--       失败重试浪费大量 LLM token, 用户没机会调参数。
--       V4 拆 3 步 (planning → details → persist), 中间态 JSON 存 episodes.planning_data,
--       失败可从中间态恢复, 不需要重跑 LLM。
--
-- 执行时机: 用户第一次部署这次改动时, 手工执行一次。
-- 执行环境: docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /path/to/this.sql"
-- ============================================================

-- 1) episodes 表 ADD planning_data 列
-- 存 3 步中间态 JSON: { step1_done_at, step1_plan, step2_done_at, step2_details, step3_done_at, step3_storyboard_ids }
-- 老 episode NULL 兼容 (老 endpoint 走 V2/V3 拼接逻辑, 0 兼容成本)
ALTER TABLE episodes ADD COLUMN planning_data TEXT;

-- 2) 老 episode 不 UPDATE (跟 V3 拍板一致, 老数据不动, 新链路只对新建 drama 10+ 生效)

-- ============================================================
-- ROLLBACK (简化: ADD COLUMN 是常规 SQL, 出问题可 DROP)
-- ============================================================
-- DROP COLUMN:
--   ALTER TABLE episodes DROP COLUMN planning_data;

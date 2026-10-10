-- ============================================================
-- V3 character 治本扩面 (QA msg-20261010-006 ISSUE-023)
-- 主题: characters 加 permanent_traits + permanent_outfit 列存结构化 JSON
-- 原因: Sprint 8 V3 治本只对 storyboard.image_prompt_permanent 5 维 enum 生效,
--       character 输入 schema 仍是 z.array(z.string()) free-text (extract-tools.ts:176),
--       LLM 仍把 plot_state 关键词塞进 characters.appearancePermanent.
--       V3 扩面: permanent_traits 强制 5 维 enum 结构化对象, permanent_outfit 自由 string 数组.
--
-- 执行时机: 用户第一次部署这次改动时, 手工执行一次。
-- 执行环境: docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /path/to/this.sql"
-- ============================================================

-- 1) characters 表 ADD permanent_traits 列
--   存结构化 JSON: [{category: 'age'|'face'|'hair'|'body'|'outfit', value: string}]
--   5 维 enum 强约束, 跨剧情通用不需关键词白名单.
ALTER TABLE characters ADD COLUMN permanent_traits TEXT;

-- 2) characters 表 ADD permanent_outfit 列
--   存 JSON: [string, ...] (服装/装饰自由描述, max 50 字/项, max 10 项)
ALTER TABLE characters ADD COLUMN permanent_outfit TEXT;

-- 3) 老 character 不 UPDATE (NULL 兼容, code 读时 fallback)
--    老 data 拼装在 appearancePermanent text 列, 新链路只对新建 drama 11+ 生效

-- ============================================================
-- ROLLBACK (简化: ADD COLUMN 是常规 SQL, 出问题可 DROP)
-- ============================================================
-- DROP COLUMN:
--   ALTER TABLE characters DROP COLUMN permanent_outfit;
--   ALTER TABLE characters DROP COLUMN permanent_traits;

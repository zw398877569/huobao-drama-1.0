-- ============================================================
-- V3 治本迁移 (PM msg-20261010-002)
-- 主题: storyboards 加 image_prompt_permanent 列存结构化 5 维 enum JSON
-- 原因: Sprint 7 V2 治本失败 — V2 让 LLM 输出 array of strings,
--       string 可含任何内容, LLM 仍塞 plot 描述进去 (例如 drama 9
-- 主人 '深爱豆豆胜过自己'), zod 不报错, 软约束 (JSDoc) LLM 忽略。
-- V3 治本: 让 LLM 输出 array of {category: enum, value: string} 结构化对象,
--       5 维 enum 强约束 (age/face/hair/body/outfit), LLM 想写 '深爱豆豆胜过自己'
--       会因没有匹配的 category 被 zod reject, 不需关键词白名单。
--
-- 执行时机: 用户第一次部署这次改动时, 手工执行一次。
-- 执行环境: docker exec huobao-drama-1.0 sh -c "sqlite3 /app/data/huobao_drama.db < /path/to/this.sql"
-- ============================================================

-- 1) storyboards 表 ADD image_prompt_permanent 列
--    存结构化 JSON: { character_traits: [{category, value}], scene_aesthetic: [],
--                     shot_type_ref, angle, movement }
--    5 维 enum 强约束, 跨剧情通用, 不需关键词白名单。
ALTER TABLE storyboards ADD COLUMN image_prompt_permanent TEXT;

-- 2) 老 shot 默认 NULL (不 UPDATE, code 端 read 时 fallback '{}' 或 default)
--    决策: V3 拍板"不做 UPDATE", 老 drama 8 数据不动, 新 drama 10+ 走新链路。
--    老 shot NULL 兼容, V3 起的 shot 由 code 端 INSERT 时写 JSON.stringify 结构。

-- ============================================================
-- ROLLBACK (简化: ADD COLUMN 是常规 SQL, 出问题可 DROP)
-- ============================================================
-- DROP COLUMN:
--   ALTER TABLE storyboards DROP COLUMN image_prompt_permanent;

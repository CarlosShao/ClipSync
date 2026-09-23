-- =============================================
-- 076: user_sessions.updated_at 列（S1 止血）
-- 背景：src/routes/sessions.js（79/111 行）与 src/routes/aiTools.js（terminate_session）
--       的 UPDATE 都写 updated_at = NOW()，但 user_sessions 建表语句
--       （migrate.js 内嵌 + 012_schema_completion.sql）均无此列，
--       导致「踢出某个设备」「退出所有设备」恒 500 —— 会话从未真正被吊销，
--       丢失的设备即使被用户踢出仍持有有效会话。
--       新库由 migrate.js 内嵌建表语句补列，存量库由本文件补列，两条路都要对。
-- 幂等：ADD COLUMN IF NOT EXISTS；可重复执行。
-- 版本登记：不在此文件内写 schema_migrations，由 migrate.js 以完整文件名为幂等键自动登记。
-- =============================================

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

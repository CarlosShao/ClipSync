-- =============================================
-- 075: clipboard_items.content_diff 增量同步列（S0 迁移撞车修复的附带项）
-- 背景：src/routes/sync.js（125/265/281/310 行）读写 clipboard_items.content_diff，
--       但该列此前只在死代码 src/db/migrate-manager.js 里定义过，从未被任何生效迁移创建，
--       因此增量同步相关 SQL 必然报 column does not exist。
--       本文件只负责把列建出来；sync.js 的增量同步逻辑本身归属 P1-A（同步链路）批次，未在此修复。
-- 幂等：ADD COLUMN IF NOT EXISTS；可重复执行。
-- 版本登记：不在此文件内写 schema_migrations，由 migrate.js 以完整文件名为幂等键自动登记。
-- =============================================

ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS content_diff TEXT DEFAULT NULL;

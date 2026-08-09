-- =====================================================
-- 000_search_vector_init.sql
-- 给 clipboard_items 加 search_vector tsvector 列（全文检索用）。
--
-- 为什么单独存在：
--   migrate.js 的 postMigrations 也建这列，但 post 阶段在所有 .sql 文件之后。
--   029_ocr_text.sql 已经依赖这列，必须在所有 .sql 之前就建好。
--   抽取到这里（数字 000 最小），保证全链路幂等。
--
-- 幂等：ADD COLUMN IF NOT EXISTS
-- =====================================================

ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 记录迁移完成（幂等）
INSERT INTO schema_migrations (version, applied_at)
VALUES ('000', NOW())
ON CONFLICT (version) DO NOTHING;

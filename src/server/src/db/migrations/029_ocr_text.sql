-- 029: OCR 预处理（#224）
-- 为图片剪贴板增加可搜索的文字层 ocr_text，并把其纳入全文检索 search_vector（权重 C）。
-- 与 SCHEMA_VERSIONS version 8 一致；此文件用于人工/文档参考，正式迁移由 migrate-manager 执行。
-- 2026-08-09: 增加 search_vector 兜底（CI 跑迁移时 post-migrations 顺序在所有 .sql 之后，
--              导致 029 单独执行时列未建）。同时全部 IF NOT EXISTS 化。

-- 0) search_vector 列兜底（migration 顺序兼容 CI 单独跑此文件）
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS ocr_text TEXT DEFAULT NULL;
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 1) OCR 字段更新触发器
CREATE OR REPLACE FUNCTION clipsync_update_search_vector() RETURNS trigger AS $$
BEGIN
  -- 兜底：某些早期 schema 没有 search_vector（不应该发生了，但保险）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clipboard_items' AND column_name = 'search_vector'
  ) THEN
    -- 动态计算返回 NEW（不走 NEW.search_vector := ...）
    RETURN NEW;
  END IF;

  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.content_type, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.ocr_text, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clipsync_search_vector_update ON clipboard_items;
CREATE TRIGGER clipsync_search_vector_update
  BEFORE INSERT OR UPDATE OF content_preview, content_type, ocr_text
  ON clipboard_items FOR EACH ROW EXECUTE FUNCTION clipsync_update_search_vector();

-- 2) 回填历史数据（仅当列存在时执行）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clipboard_items' AND column_name = 'search_vector'
  ) THEN
    UPDATE clipboard_items
    SET search_vector = setweight(to_tsvector('simple', coalesce(content_type, '')), 'A') ||
                        setweight(to_tsvector('simple', coalesce(content_preview, '')), 'B') ||
                        setweight(to_tsvector('simple', coalesce(ocr_text, '')), 'C')
    WHERE ocr_text IS NOT NULL;
  END IF;
END $$;

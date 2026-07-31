-- 029: OCR 预处理（#224）
-- 为图片剪贴板增加可搜索的文字层 ocr_text，并把其纳入全文检索 search_vector（权重 C）。
-- 与 SCHEMA_VERSIONS version 8 一致；此文件用于人工/文档参考，正式迁移由 migrate-manager 执行。

ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS ocr_text TEXT DEFAULT NULL;

CREATE OR REPLACE FUNCTION clipsync_update_search_vector() RETURNS trigger AS $$
BEGIN
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

UPDATE clipboard_items
SET search_vector = setweight(to_tsvector('simple', coalesce(content_type, '')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(content_preview, '')), 'B') ||
                    setweight(to_tsvector('simple', coalesce(ocr_text, '')), 'C')
WHERE ocr_text IS NOT NULL;

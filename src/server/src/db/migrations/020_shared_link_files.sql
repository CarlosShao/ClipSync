-- Migration 020: shared link file support
-- 允许分享链接附带文件，供接收方下载。

ALTER TABLE shared_links
  ADD COLUMN IF NOT EXISTS file_path TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('020', NOW())
ON CONFLICT (version) DO NOTHING;

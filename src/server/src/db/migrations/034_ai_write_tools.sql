-- =============================================
-- 034: AI 写工具面（write_clip）支持
-- 原因：write_clip 由 AI 写入剪贴板，无真实发起设备，source_device_id 置 NULL。
--       需将 clipboard_items.source_device_id 从 NOT NULL 放宽为可空。
-- 幂等：迁移版本由 schema_migrations 跟踪，仅执行一次。
-- =============================================
ALTER TABLE clipboard_items ALTER COLUMN source_device_id DROP NOT NULL;

-- 记录迁移
INSERT INTO schema_migrations (version, applied_at)
VALUES ('034', NOW())
ON CONFLICT (version) DO NOTHING;
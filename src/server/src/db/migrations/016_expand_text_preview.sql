-- =============================================
-- 扩展文本预览长度并补全 content_size
-- 原因：旧逻辑把 content_preview 截断为 200 字符，列表/弹窗只显示预览，
--       导致长文本在详情里被截断。本次修复后 preview 上限提升到 5000 字符，
--       并补全旧条目的 content_size 以便前端判断是否需要拉取完整内容。
-- =============================================

-- 1. 补全旧条目的 content_size（基于实际密文长度）
UPDATE clipboard_items
SET content_size = LENGTH(content_encrypted)
WHERE content_size IS NULL OR content_size = 0;

-- 2. 扩展旧条目的 content_preview 到 5000 字符（仅当实际密文更长时才更新）
UPDATE clipboard_items
SET content_preview = LEFT(content_encrypted, 5000)
WHERE LENGTH(content_encrypted) > LENGTH(content_preview);

-- 记录迁移
INSERT INTO schema_migrations (version, applied_at)
VALUES ('016', NOW())
ON CONFLICT (version) DO NOTHING;

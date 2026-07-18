-- =============================================
-- 模板功能：clipboard_templates 表
-- 原因：模板库需要按用户持久化文本模板（可含 {{变量}} 占位符）。
--       变量解析完全在前端完成，后端只负责存储与按用户隔离，
--       因此表结构非常精简：name + content(TEXT) + 时间戳。
-- 注意：用户隔离由每个 CRUD 语句的 WHERE user_id = $1 强制保证，
--       主键用 UUID 避免顺序 id 泄漏总量。
-- =============================================

CREATE TABLE IF NOT EXISTS clipboard_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clipboard_templates_user
  ON clipboard_templates(user_id, created_at DESC);

-- 记录迁移
INSERT INTO schema_migrations (version, applied_at)
VALUES ('017', NOW())
ON CONFLICT (version) DO NOTHING;

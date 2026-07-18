-- =============================================
-- 模板变量全局存储：template_variables 表
-- 原因：模板占位符（如 {{name}}）此前每次插入都要手填，体验差。
--       新增「全局变量」机制——用户可预设变量名与默认值，
--       插入模板时自动预填，并可选择「记住上次输入」回写默认值。
--       后端只负责按用户隔离地持久化 name→value，解析仍在前端完成。
-- 注意：用户隔离由每个 CRUD 语句的 WHERE user_id = $1 强制保证；
--       业务键是 (user_id, name)，name 即用户在 {{name}} 中写的标识符，
--       与前端 VAR_PATTERN 的标识符规则一致（字母/下划线开头，含数字）。
--       主键仍用 UUID 仅仅是为了避免顺序 id 泄漏总量，不做外键关联。
-- =============================================

CREATE TABLE IF NOT EXISTS template_variables (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_template_variables_user_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_template_variables_user
  ON template_variables(user_id, name);

-- 记录迁移
INSERT INTO schema_migrations (version, applied_at)
VALUES ('018', NOW())
ON CONFLICT (version) DO NOTHING;

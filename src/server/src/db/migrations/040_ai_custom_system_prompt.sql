-- =============================================
-- 040: AI 全局自定义系统提示词
-- 范围：ai_settings 新增 custom_system_prompt 列，允许用户在设置中配置
--       全局系统提示词（追加到角色/产品知识之后、thinking 增强之前）。
--       用户级别配置，空/NULL 表示不注入。
-- 幂等：列用 IF NOT EXISTS；迁移版本登记用 ON CONFLICT DO NOTHING。
-- =============================================

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS custom_system_prompt TEXT DEFAULT NULL;

INSERT INTO schema_migrations (version, applied_at) VALUES ('040', NOW())
  ON CONFLICT (version) DO NOTHING;
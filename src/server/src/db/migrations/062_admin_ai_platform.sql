-- =============================================
-- 062: AI 平台设置（AN-03）
-- 编号说明：原拟 061，因多个工单并发占用 061 前缀（同前缀迁移会被
-- migrate.js 按 version 互相 skip），改号 062。
-- 范围：
--   1) ai_providers 增加 enabled 列（管理台可禁用某供应商；
--      禁用后用户端 GET /api/ai/providers 不再返回该行 → 桌面端不可选，
--      聊天/OCR/兜底解析路径同样过滤，见 utils/aiRuntimeConfig.js）
--   2) permissions 新增 admin.ai.manage（AI 平台管理），仅授予 super_admin
--      （与 059 admin.email_channels.manage 同策略：仅超管运维能力，
--      不进 roles.js PERM_CATALOG / 权限树，前端 super_admin 通配放行）
-- 幂等：IF NOT EXISTS / ON CONFLICT DO NOTHING。
-- 依赖：024(ai_providers)、028(roles/permissions)。
-- =============================================

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.ai.manage', 'admin', 'AI 平台管理（供应商启停/编辑 + AI 全局参数）')
ON CONFLICT (perm_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'admin.ai.manage'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('062', NOW())
ON CONFLICT (version) DO NOTHING;

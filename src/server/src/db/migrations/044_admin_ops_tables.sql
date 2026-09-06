-- =============================================
-- 044: 后台管理运营表补齐（Admin Console · T-A5）
-- 范围：
--   1) system_configs 补种前端设置页要求但 038 缺失的两键：
--        maintenance_mode (false) / audit_log_retention_days (365)
--   2) feature_flags 补种 'signup_waitlist'（前端设置页 5 开关契约中 038 缺的第 5 个）
--   3) permissions 目录补 'admin.keys.view'（043 共 12 项，前端权限页契约要求 13 项），
--      并授予 super_admin
--   4) 新建 admin_announcements（公告下发历史），供 POST/GET /api/admin/announcements 落库
-- 幂等：建表 IF NOT EXISTS；种子全部 ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：008(audit_logs) / 028(roles/permissions) / 038(system_configs/feature_flags) / 043(权限目录)。
-- =============================================

-- ---- 1. system_configs 补种（只补 038 缺的键）----
-- maintenance_mode 取值对齐前端设置页词汇表（settings/index.tsx：value === 'on' 判定开关），
-- 故种 '"off"' 而非布尔 false（SystemConfig.value 契约为字符串 on/off）。
INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('maintenance_mode',          '"off"'::jsonb, '开启后客户端暂停同步并显示维护公告', 'security'),
  ('audit_log_retention_days',  '365'::jsonb,   '审计日志的保留时长，超期归档后删除',                  'security')
ON CONFLICT (config_key) DO NOTHING;

-- ---- 2. feature_flags 补种（前端设置页第 5 个开关：注册审核，默认关闭）----
INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('signup_waitlist', FALSE, '新注册进入等待名单（运营灰度）')
ON CONFLICT (flag_key) DO NOTHING;

-- ---- 3. 权限目录补齐第 13 项：设备密钥细节（仅超管）----
INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.keys.view', 'admin', '设备密钥细节（仅超管）')
ON CONFLICT (perm_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'admin.keys.view'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- ---- 4. 公告下发历史表 ----
-- audience 取值与前端契约（admin-console/src/api/types.ts Announcement['audience']）对齐：
--   'all' | 'pro_plus' | 'free'
-- display_mode 取值：'once' | 'persistent'
CREATE TABLE IF NOT EXISTS admin_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  audience VARCHAR(20) NOT NULL DEFAULT 'all',
  display_mode VARCHAR(20) NOT NULL DEFAULT 'once',
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_announcements_created_at
  ON admin_announcements(created_at DESC);

-- ---- 迁移登记（与 028/038/043 写法一致；migrate.js 亦会登记，ON CONFLICT 幂等兜底）----
INSERT INTO schema_migrations (version, applied_at) VALUES ('044', NOW())
ON CONFLICT (version) DO NOTHING;

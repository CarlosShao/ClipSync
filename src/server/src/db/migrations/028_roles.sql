-- =============================================
-- 028: 可配置角色（临时超管方案）
-- 范围：仅建表 + 种子默认三角色 + 种子权限目录
--      + 把 13505110772 设为 super_admin，其余用户默认 user。
-- 注意：后台管理 UI、AI 权限强制（按角色过滤工具/系统提示词）等"口子"
--      本迁移不实现，后续接入。is_admin 仅作兼容保留。
-- =============================================

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  level INTEGER NOT NULL DEFAULT 10,
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  is_assignable BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perm_key VARCHAR(100) UNIQUE NOT NULL,
  category VARCHAR(50) NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

-- 种子默认角色
INSERT INTO roles (role_key, name, level, is_system, is_assignable, description) VALUES
  ('super_admin', '超级管理员', 100, TRUE, TRUE, '产品所有者/开发者，可见一切内部数据'),
  ('admin',       '管理员',      50,  TRUE, TRUE, '受信任协作者，可见管理能力但不含敏感内部数据'),
  ('user',        '普通用户',    10,  TRUE, TRUE, '默认用户，仅可见平台公开能力')
ON CONFLICT (role_key) DO NOTHING;

-- 种子权限目录（AI 数据范围敏感权限 + 基础平台权限）
INSERT INTO permissions (perm_key, category, description) VALUES
  ('ai.view_database_schema',  'ai', 'AI 可暴露数据库表结构'),
  ('ai.view_deployment',       'ai', 'AI 可暴露部署/架构信息'),
  ('ai.view_security_data',    'ai', 'AI 可暴露安全相关数据'),
  ('ai.view_source_code',      'ai', 'AI 可暴露源码/实现细节'),
  ('ai.access_other_user_data', 'ai', 'AI 可访问其他用户数据'),
  ('ai.explain_internal',      'ai', 'AI 可解释内部实现'),
  ('platform.use_ai',          'platform', '可使用 AI 助手'),
  ('platform.manage_own_data', 'platform', '管理自己的剪贴板/设备/订阅')
ON CONFLICT (perm_key) DO NOTHING;

-- 角色-权限分配：super_admin 拥有全部；admin/user 仅基础平台权限（无敏感 AI 权限）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.role_key IN ('admin', 'user') AND p.category = 'platform'
ON CONFLICT DO NOTHING;

-- 回填：13505110772 -> super_admin；其余未分配者 -> user
UPDATE users
SET role_id = (SELECT id FROM roles WHERE role_key = 'super_admin')
WHERE phone = '13505110772'
  AND role_id IS DISTINCT FROM (SELECT id FROM roles WHERE role_key = 'super_admin');

UPDATE users
SET role_id = (SELECT id FROM roles WHERE role_key = 'user')
WHERE role_id IS NULL;

-- 兼容旧 is_admin 布尔：super_admin/admin => true，user => false
UPDATE users SET is_admin = TRUE
WHERE role_id IN (SELECT id FROM roles WHERE role_key IN ('super_admin', 'admin'));
UPDATE users SET is_admin = FALSE
WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'user');

-- 新用户默认角色 = user（避免改动注册代码）
DO $$
DECLARE
  v_user_role UUID;
BEGIN
  SELECT id INTO v_user_role FROM roles WHERE role_key = 'user';
  IF v_user_role IS NOT NULL THEN
    EXECUTE 'ALTER TABLE users ALTER COLUMN role_id SET DEFAULT ' || quote_literal(v_user_role);
  END IF;
END
$$;

INSERT INTO schema_migrations (version, applied_at) VALUES ('028', NOW())
ON CONFLICT (version) DO NOTHING;

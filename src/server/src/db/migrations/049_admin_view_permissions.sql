-- =============================================
-- 049: 管理台读侧 view 权限键补齐（方案二 RB-06）
-- 范围：
--   1) permissions 目录新增 7 个 view 键（category='admin'），消除
--      「9 个读端点仅 requireRole(50) 无细粒度 view 校验」的缺口
--   2) 授予 super_admin（全部）与 admin（全部）——内置角色行为不变：
--      升级前内置 admin 可读全部列表，升级后仍可读
-- 幂等：种子全部 ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：028(roles/permissions) / 043(权限目录)。
-- =============================================

INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.devices.view',       'admin', '查看设备列表与统计'),
  ('admin.orders.view',        'admin', '查看订单与退款流水'),
  ('admin.subscriptions.view', 'admin', '查看订阅列表与统计'),
  ('admin.plans.view',         'admin', '查看套餐与价格'),
  ('admin.roles.view',         'admin', '查看角色与权限目录'),
  ('admin.configs.view',       'admin', '查看系统参数与功能开关'),
  ('admin.announce.view',      'admin', '查看公告下发历史')
ON CONFLICT (perm_key) DO NOTHING;

-- super_admin 拥有全部 view 键
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.category = 'admin' AND p.perm_key LIKE 'admin.%.view'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- admin 内置角色保持升级前可读行为
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.category = 'admin' AND p.perm_key LIKE 'admin.%.view'
WHERE r.role_key = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('049', NOW())
ON CONFLICT (version) DO NOTHING;

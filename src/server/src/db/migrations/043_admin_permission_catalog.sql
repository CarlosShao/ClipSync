-- =============================================
-- 043: 后台管理系统权限目录（Admin Console · T-A1）
-- 范围：向 permissions 表插入 category='admin' 的后台管理权限目录（12 项），
--       并按角色分配（role_permissions）：
--         - super_admin：全部 admin.* 权限
--         - admin：users.view / users.manage / devices.manage /
--                  subscriptions.grant / orders.reconcile / audit.view /
--                  announce.send（不给 delete/refund/roles/configs/plans）
--         - user：不授予任何 admin.* 权限（无需 INSERT，缺省即无）
-- 幂等：全部 INSERT ... ON CONFLICT DO NOTHING，可重复执行。
-- 依赖：028_roles.sql 建立的 roles / permissions / role_permissions 表。
-- =============================================

-- ---- 权限目录（category = 'admin'）----
INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.users.view',         'admin', '查看用户列表与详情'),
  ('admin.users.manage',       'admin', '停用/启用/强制下线/重置2FA'),
  ('admin.users.delete',       'admin', '删除账户（高危）'),
  ('admin.devices.manage',     'admin', '设备远程下线/解绑'),
  ('admin.subscriptions.grant','admin', '人工赠期/调整套餐'),
  ('admin.orders.refund',      'admin', '执行退款（高危）'),
  ('admin.orders.reconcile',   'admin', '查看对账报告'),
  ('admin.plans.manage',       'admin', '套餐与价格管理'),
  ('admin.audit.view',         'admin', '查看审计日志'),
  ('admin.roles.manage',       'admin', '角色与权限分配（高危）'),
  ('admin.configs.manage',     'admin', '系统参数与功能开关'),
  ('admin.announce.send',      'admin', '公告与通知下发')
ON CONFLICT (perm_key) DO NOTHING;

-- ---- 角色-权限分配 ----

-- super_admin：全部 admin.* 权限
-- （028 已授予 super_admin 全量权限，此处按目录显式补齐，保持幂等与自描述）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.category = 'admin'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- admin：日常运营权限（不含 delete/refund/roles/configs/plans 五项高危/敏感权限）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.category = 'admin'
WHERE r.role_key = 'admin'
  AND p.perm_key IN (
    'admin.users.view',
    'admin.users.manage',
    'admin.devices.manage',
    'admin.subscriptions.grant',
    'admin.orders.reconcile',
    'admin.audit.view',
    'admin.announce.send'
  )
ON CONFLICT DO NOTHING;

-- user：不授予任何 admin.* 权限（无 INSERT；如历史误授可由管理员手动回收）

-- ---- 迁移登记（与 028/037/038 写法一致；migrate.js 亦会登记，ON CONFLICT 幂等兜底）----
INSERT INTO schema_migrations (version, applied_at) VALUES ('043', NOW())
ON CONFLICT (version) DO NOTHING;

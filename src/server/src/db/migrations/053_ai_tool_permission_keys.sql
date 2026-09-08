-- =============================================
-- 053: AI 工具权限键（方案二 RB-11，028 预留接缝的落地）
-- 语义：AI 工具执行校验升级为「等级达标 && （工具未声明键 || 角色拥有该键）」。
--   L2/L3 工具全部声明权限键后，等级只决定"可见性上限"，
--   键决定"实际可用"——自定义角色可被精确授予部分 AI 管理能力。
-- 授予策略（保持内置角色升级前行为）：
--   super_admin → 全部（028 已授予全表，此处幂等兜底新增键）
--   admin       → ai.manage_devices（当前 L2 整级发放的等价集）
--   自定义角色  → 不默认授予（需在角色页显式勾选）
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：028(roles/permissions)。
-- =============================================

INSERT INTO permissions (perm_key, category, description) VALUES
  ('ai.manage_users',   'ai', 'AI 可执行用户管理（新增/删除/改角色/停用/重置密码）'),
  ('ai.manage_devices', 'ai', 'AI 可查看全部设备并解绑任意设备'),
  ('ai.manage_system',  'ai', 'AI 可修改系统参数与功能开关')
ON CONFLICT (perm_key) DO NOTHING;

-- super_admin：全部 AI 键（028 已授予全表权限，此处兜底幂等）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.category = 'ai'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- admin：保持当前 L2 整级发放的等价能力（设备管理）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'ai.manage_devices'
WHERE r.role_key = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('053', NOW())
ON CONFLICT (version) DO NOTHING;

-- =============================================
-- 052: 运维监控权限 + 公告真实触达（方案三 CO-40 / CO-35）
-- 范围：
--   1) permissions 新增 admin.ops.view（运维监控页，仅超管）
--   2) admin_announcement_reads 已读回执表——公告 delivered_count
--      从「受众数」升级为「真实触达数」
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：028(roles/permissions) / 044(admin_announcements)。
-- =============================================

INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.ops.view', 'admin', '运维监控页（仅超管）')
ON CONFLICT (perm_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'admin.ops.view'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

-- 公告已读回执：一个用户对一条公告至多一条回执
CREATE TABLE IF NOT EXISTS admin_announcement_reads (
  announcement_id UUID NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_user
  ON admin_announcement_reads(user_id);

INSERT INTO schema_migrations (version, applied_at) VALUES ('052', NOW())
ON CONFLICT (version) DO NOTHING;

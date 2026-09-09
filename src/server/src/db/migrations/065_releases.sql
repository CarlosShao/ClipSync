-- =============================================
-- 065: 版本与发布管理（AN-04，2026-09-09）
-- 编号说明：原编 061，并发撞号两连跳——061 前缀被多工单同用（migrate.js 按
-- version 互相 skip）→ 改 063 被 ops_configs 占 → 改 064 又被 admin_security_policy
-- 二次撞 → 落定 065。落定后请勿再动本文件名。
-- 范围：
--   1) app_releases 表：版本号 / 名称 / 发布日期 / 更新说明 /
--      平台下载信息(JSONB) / 强制更新 / 灰度比例 / 发布状态
--   2) permissions 新增 admin.release.manage，仅授予 super_admin
-- 消费方：routes/app.js（/version、/update.json、/updates/latest）、routes/admin/releases.js
-- 幂等：IF NOT EXISTS / ON CONFLICT DO NOTHING。
-- 依赖：028(roles/permissions)。
-- =============================================

CREATE TABLE IF NOT EXISTS app_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 语义化版本号（如 1.2.0）；UNIQUE 防同版本重复建单
  version VARCHAR(50) NOT NULL UNIQUE,
  -- 版本名称/标题（展示用）
  name VARCHAR(100) NOT NULL DEFAULT '',
  -- 发布日期（展示用）
  release_date DATE,
  -- 更新说明（客户端更新弹窗展示）
  notes TEXT NOT NULL DEFAULT '',
  -- 平台下载信息：{ "windows-x86_64": { "url": "...", "signature": "..." }, ... }
  -- 键名与 Tauri updater target 一致（windows-x86_64 / darwin-aarch64 / linux-x86_64）
  platforms JSONB NOT NULL DEFAULT '{}',
  -- 是否强制更新
  force_update BOOLEAN NOT NULL DEFAULT FALSE,
  -- 灰度比例 0-100（0=不下发，100=全量）
  rollout_percent INTEGER NOT NULL DEFAULT 100
    CHECK (rollout_percent BETWEEN 0 AND 100),
  -- 发布/撤回状态（回滚 = 置 false，客户端立即不再提示更新）
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  -- 首次发布时间（公开端点排序 + pub_date 返回）
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 公开端点只扫已发布行，按发布时间倒序取最新
CREATE INDEX IF NOT EXISTS idx_app_releases_published
  ON app_releases(published_at DESC) WHERE is_published;

-- ---- 权限：admin.release.manage（参考 059 写法，仅授 super_admin）----
INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.release.manage', 'admin', '版本发布管理（发布 / 编辑 / 撤回 / 删除）')
ON CONFLICT (perm_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'admin.release.manage'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('065', NOW())
ON CONFLICT (version) DO NOTHING;

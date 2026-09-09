-- =============================================
-- 059: 邮件多通道（AN-16 方案 A，2026-09-09 拍板）
-- 编号说明：原拟 057，因队友并发占用 057/058 前缀（同前缀迁移会被
-- migrate.js 按 version 互相 skip），改号 059。
-- 范围：
--   1) email_channels 表：多 SMTP 账号 + 按用途（transactional/marketing）路由
--      + priority 优先级 failover；provider 预留 aliyun_dm / sendgrid（仅 smtp 实现）
--   2) 将现有 system_configs 的 smtp_* 六键导入为「默认事务通道」
--      （smtp_pass 密文原样搬，沿用 utils/encryption.js 的 AES-256-GCM 同一主密钥）
--   3) permissions 新增 admin.email_channels.manage，仅授予 super_admin
-- 兼容：原 system_configs smtp_* 键保留不动（utils/email.js 只读兼容一个版本后废弃）。
-- 幂等：IF NOT EXISTS / ON CONFLICT DO NOTHING；导入用 WHERE NOT EXISTS 防重复插行。
-- 依赖：028(roles/permissions)、050(runtime_configs smtp_*)。
-- =============================================

CREATE TABLE IF NOT EXISTS email_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'transactional'
    CHECK (purpose IN ('transactional', 'marketing')),
  provider VARCHAR(20) NOT NULL DEFAULT 'smtp'
    CHECK (provider IN ('smtp', 'aliyun_dm', 'sendgrid')),
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL DEFAULT 587 CHECK (port BETWEEN 1 AND 65535),
  secure BOOLEAN NOT NULL DEFAULT FALSE,
  username VARCHAR(255) NOT NULL DEFAULT '',
  -- AN-16：密文（encryptField iv:authTag:ciphertext 格式）；任何读取路径只回 has_password
  password TEXT NOT NULL DEFAULT '',
  from_addr VARCHAR(255) NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- AN-16：数值越小越优先；发送失败按 priority 顺延降级（最多 2 次）
  priority INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 发送路径按 (purpose, priority) 选通道，仅扫启用行
CREATE INDEX IF NOT EXISTS idx_email_channels_purpose
  ON email_channels(purpose, priority) WHERE enabled;

-- ---- 导入现有 smtp_* 为「默认事务通道」（密文原样搬，不落明文）----
-- config_value 为 jsonb，#>> '{}' 取原始文本；smtp_host 为空 = 从未配置 → 不导入
INSERT INTO email_channels (name, purpose, provider, host, port, secure, username, password, from_addr, enabled, priority)
SELECT
  '默认事务通道',
  'transactional',
  'smtp',
  sc.host,
  COALESCE(NULLIF(sc.port, '')::int, 587),
  COALESCE(NULLIF(sc.secure, '')::boolean, FALSE),
  COALESCE(sc.username, ''),
  COALESCE(sc.password, ''),
  COALESCE(sc.from_addr, ''),
  TRUE,
  1
FROM (
  SELECT
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_host')  AS host,
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_port')  AS port,
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_secure') AS secure,
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_user')  AS username,
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_pass')  AS password,
    (SELECT config_value #>> '{}' FROM system_configs WHERE config_key = 'smtp_from')  AS from_addr
) sc
WHERE sc.host IS NOT NULL AND sc.host <> ''
  AND NOT EXISTS (SELECT 1 FROM email_channels WHERE name = '默认事务通道');

-- ---- 权限：admin.email_channels.manage（参考 052 写法，仅授 super_admin）----
INSERT INTO permissions (perm_key, category, description) VALUES
  ('admin.email_channels.manage', 'admin', '邮件通道管理（多 SMTP 账号 / 按用途路由 / 发送测试）')
ON CONFLICT (perm_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.perm_key = 'admin.email_channels.manage'
WHERE r.role_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('059', NOW())
ON CONFLICT (version) DO NOTHING;

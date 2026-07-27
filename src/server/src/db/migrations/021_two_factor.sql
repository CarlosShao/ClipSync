-- Migration 021: two-factor authentication (TOTP / 2FA)
-- 两步验证：启用后在登录链路中插入二次验证码挑战。
-- 密钥以加密形式落库（encryptField）。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS two_factor_secret TEXT,
  ADD COLUMN IF NOT EXISTS two_factor_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS two_factor_backup_codes TEXT;

CREATE INDEX IF NOT EXISTS idx_users_two_factor ON users(id, two_factor_enabled) WHERE two_factor_enabled = TRUE;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('021', NOW())
ON CONFLICT (version) DO NOTHING;

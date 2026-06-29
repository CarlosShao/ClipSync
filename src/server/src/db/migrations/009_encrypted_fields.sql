-- Phase 10 数据库迁移：加密字段和密钥表
-- 执行日期：2026-06-29

-- 10.1 添加加密字段到 users 表
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_encrypted TEXT;

-- 10.2 创建加密密钥表
CREATE TABLE IF NOT EXISTS encryption_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  key_type VARCHAR(20) NOT NULL CHECK (key_type IN ('ecdh_public', 'ecdh_private', 'shared_secret', 'aes_key')),
  key_data TEXT NOT NULL, -- 加密后的密钥数据
  key_salt VARCHAR(64), -- 密钥派生盐值
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_encryption_keys_user_id ON encryption_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_device_id ON encryption_keys(device_id);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active) WHERE is_active = TRUE;

-- 更新 schema 版本
INSERT INTO schema_migrations (version, applied_at) 
VALUES ('009', NOW())
ON CONFLICT (version) DO NOTHING;

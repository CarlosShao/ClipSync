-- 添加 phone_hash 和 email_hash 列（用于 O(1) 查询加密字段）
-- 修复 Red Team 发现的 O(n) 全表扫描漏洞

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(64);

-- 创建索引（部分索引，仅非空值）
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL;

-- 更新现有数据的哈希值
-- 使用 SHA-256(字段值 + 固定盐) 作为哈希，避免明文存储
UPDATE users 
SET 
  phone_hash = encode(digest(phone || 'CLIPSYNC_SALT_2026', 'sha256'), 'hex')
WHERE phone IS NOT NULL AND phone_hash IS NULL;

UPDATE users 
SET 
  email_hash = encode(digest(email || 'CLIPSYNC_SALT_2026', 'sha256'), 'hex')
WHERE email IS NOT NULL AND email_hash IS NULL;

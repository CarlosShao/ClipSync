-- 添加管理员权限字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- 添加哈希索引列（用于 O(1) 查询加密字段）
-- 详见 006_phone_email_hash.sql
-- 此文件仅确保 is_admin 字段存在

-- 创建索引（若尚未创建）
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin) WHERE is_admin = TRUE;

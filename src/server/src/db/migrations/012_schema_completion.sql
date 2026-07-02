-- =============================================
-- ClipSync 数据库完整 Schema 补全迁移
-- 原因：migrate.js 基础表只有最小字段集，
--       auth.js/subscriptionCheck.js 等路由需要额外字段和表
-- 执行日期：2026-06-29
-- =============================================

-- 1. users 表：补全所有缺失字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_consent BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS functional_consent BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_subscription_id UUID;

-- 2. 用户会话表（auth.js createSessionAndGenerateToken 需要）
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) DEFAULT 'Unknown Device',
  device_type VARCHAR(20) DEFAULT 'browser',
  platform VARCHAR(20) DEFAULT 'unknown',
  ip_address VARCHAR(45),
  user_agent TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions(user_id, is_active) WHERE is_active = TRUE;

-- 3. 订阅套餐表（subscriptionCheck.js getPlanByName 需要）
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  price_monthly DECIMAL(10,2),
  price_yearly DECIMAL(10,2),
  max_devices INTEGER DEFAULT 2,
  max_clipboard_items INTEGER DEFAULT 50,
  max_file_size_mb INTEGER DEFAULT 1,
  max_storage_mb INTEGER DEFAULT 100,
  features JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 用户订阅记录表（subscriptionCheck.js 查询需要）
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','canceled','past_due','expired')),
  billing_cycle VARCHAR(10) DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  start_date TIMESTAMPTZ DEFAULT NOW(),
  end_date TIMESTAMPTZ,
  stripe_subscription_id VARCHAR(255),
  alipay_agreement_id VARCHAR(255),
  wechat_pay_prepay_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. 通知偏好表
CREATE TABLE IF NOT EXISTS notification_preferences (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  title VARCHAR(255),
  content TEXT,
  status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'pending')),
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences(user_id);

-- 6. 加密密钥表
CREATE TABLE IF NOT EXISTS encryption_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  key_type VARCHAR(20) NOT NULL CHECK (key_type IN ('ecdh_public', 'ecdh_private', 'shared_secret', 'aes_key')),
  key_data TEXT NOT NULL,
  key_salt VARCHAR(64),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_user_id ON encryption_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_device_id ON encryption_keys(device_id);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_active ON encryption_keys(is_active) WHERE is_active = TRUE;

-- 7. 初始化订阅套餐数据
INSERT INTO subscription_plans (name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features) VALUES
('Free', '免费版', '基础剪贴板同步功能', 0, 0, 2, 50, 1, 100, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":false,"full_text_search":false,"version_history_days":3}'),
('Pro', '专业版', '完整功能解锁', 9.9, 99, 10, 500, 10, 1024, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":30}')
ON CONFLICT (name) DO NOTHING;

-- 记录到 schema_migrations
INSERT INTO schema_migrations (version, applied_at)
VALUES ('012_schema_completion', NOW())
ON CONFLICT (version) DO NOTHING;

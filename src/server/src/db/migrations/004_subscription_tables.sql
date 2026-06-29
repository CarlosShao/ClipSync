-- Phase 10 数据库迁移：订阅与支付相关表
-- 执行日期：2026-06-26

-- 10.1 订阅计划表
CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  plan_type VARCHAR(20) NOT NULL CHECK (plan_type IN ('free', 'pro', 'enterprise')),
  price_monthly DECIMAL(10, 2) NOT NULL DEFAULT 0,
  price_yearly DECIMAL(10, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  device_limit INTEGER NOT NULL DEFAULT 2,
  clipboard_limit INTEGER NOT NULL DEFAULT 50,
  file_size_limit INTEGER NOT NULL DEFAULT 1, -- MB
  storage_limit INTEGER NOT NULL DEFAULT 100, -- MB
  features JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 10.2 用户订阅表
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('active', 'cancelled', 'expired', 'past_due')),
  billing_cycle VARCHAR(10) NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  payment_method VARCHAR(20), -- wechat, alipay, stripe, apple_iap, google_play
  subscription_token_encrypted TEXT, -- 加密的订阅令牌（用于第三方支付）
  external_subscription_id VARCHAR(255), -- 第三方订阅ID
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);

-- 10.3 支付订单表
CREATE TABLE IF NOT EXISTS payment_orders (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(64) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  payment_method VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'cancelled')),
  paid_at TIMESTAMP,
  refund_amount DECIMAL(10, 2) DEFAULT 0,
  external_order_id VARCHAR(255), -- 第三方订单号
  webhook_received BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_order_no ON payment_orders(order_no);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);

-- 10.4 发票表
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(64) NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  status VARCHAR(20) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'cancelled')),
  invoice_type VARCHAR(20) NOT NULL DEFAULT 'receipt' CHECK (invoice_type IN ('receipt', 'invoice')),
  download_url VARCHAR(255),
  issued_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);

-- 10.5 扩展 users 表（添加订阅状态字段）
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'free' CHECK (subscription_status IN ('free', 'pro', 'enterprise', 'expired'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_clipboard_items INTEGER DEFAULT 50;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER DEFAULT 100;

-- 插入默认订阅计划
INSERT INTO subscription_plans (name, plan_type, price_monthly, price_yearly, device_limit, clipboard_limit, file_size_limit, storage_limit, features, sort_order)
VALUES 
  ('免费版', 'free', 0, 0, 2, 50, 1, 100, '{"e2e_encryption": true, "offline_queue": true, "ai_classification": true}', 1),
  ('专业版', 'pro', 9.9, 99, 5, 999999, 20, 5120, '{"e2e_encryption": true, "offline_queue": true, "ai_classification": true, "push_notification": true, "full_text_search": true, "version_history": 30}', 2),
  ('企业版', 'enterprise', 29.9, 299, 999999, 999999, 100, 51200, '{"e2e_encryption": true, "offline_queue": true, "ai_classification": true, "push_notification": true, "full_text_search": true, "version_history": 999999, "team_sharing": true, "priority_support": true}', 3)
ON CONFLICT DO NOTHING;

-- 更新 schema 版本
INSERT INTO schema_migrations (version, applied_at) 
VALUES ('004', NOW())
ON CONFLICT (version) DO NOTHING;

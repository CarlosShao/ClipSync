-- =============================================
-- Phase 4 订阅计划 / 用户订阅 / 支付订单 / 发票 数据库迁移
-- 设计准则：与 migrate.js 内嵌 #7、#8/#9 的 schema、后续 012 文件保持一致
--   - subscription_plans: UUID PK + display_name + max_devices/max_storage_mb 等
--   - user_subscriptions: UUID PK + plan_id UUID
--   - payment_orders:     UUID PK + amount/currency
--   - invoices:           UUID PK + amount
-- 所有写入都用 ON CONFLICT DO NOTHING 兼容历史漂移。
-- 执行日期：2026-08-03（彻底修复迁移链断裂）
-- =============================================

-- 1. 订阅套餐表（subscriptionCheck.js getPlanByName 需要）
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 1.1 兼容性 ALTER：如果表已经存在（早期漂移留下的旧 SERIAL 版或 004 旧版），
--     缺什么列就补什么列，全部使用 IF NOT EXISTS 保持幂等。
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_monthly DECIMAL(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_yearly DECIMAL(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 2;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_clipboard_items INTEGER DEFAULT 50;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_file_size_mb INTEGER DEFAULT 1;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER DEFAULT 100;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 2. 用户订阅记录表（subscriptions.js / subscriptionCheck.js 需要）
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','canceled','cancelled','past_due','expired')),
  billing_cycle VARCHAR(10) DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  end_date TIMESTAMP WITH TIME ZONE,
  auto_renew BOOLEAN DEFAULT TRUE,
  payment_method VARCHAR(20),
  stripe_subscription_id VARCHAR(255),
  alipay_agreement_id VARCHAR(255),
  wechat_pay_prepay_id VARCHAR(255),
  payment_token_encrypted TEXT,
  external_subscription_id VARCHAR(255),
  subscription_token_encrypted TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2.1 兼容性 ALTER：补齐所有可能缺失的列
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) CHECK (billing_cycle IN ('monthly','yearly'));
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT TRUE;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS alipay_agreement_id VARCHAR(255);
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS wechat_pay_prepay_id VARCHAR(255);
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS payment_token_encrypted TEXT;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS external_subscription_id VARCHAR(255);
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS subscription_token_encrypted TEXT;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP WITH TIME ZONE;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP WITH TIME ZONE;

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);

-- 3. 支付订单表（payments.js 需要）
CREATE TABLE IF NOT EXISTS payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  plan_id UUID REFERENCES subscription_plans(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'CNY',
  payment_method VARCHAR(20),
  payment_channel VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
  order_no VARCHAR(64) UNIQUE,
  out_trade_no VARCHAR(64),
  transaction_id VARCHAR(128),
  paid_at TIMESTAMP WITH TIME ZONE,
  expired_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. 发票表（invoices.js 需要）
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  payment_order_id UUID REFERENCES payment_orders(id) ON DELETE SET NULL,
  invoice_no VARCHAR(64) UNIQUE,
  title VARCHAR(255),
  tax_no VARCHAR(64),
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);

-- 5. 初始化三个订阅套餐（用 ON CONFLICT DO NOTHING 兼容已有数据）
INSERT INTO subscription_plans (name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features) VALUES
('Free', '免费版', '基础剪贴板同步功能', 0, 0, 2, 50, 1, 100, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":false,"full_text_search":false,"version_history_days":3}'),
('Pro', '专业版', '完整功能解锁', 9.9, 99, 10, 500, 10, 1024, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":30}'),
('Enterprise', '企业版', '团队协作和高级管理', 19.9, 199, 100, 5000, 50, 10240, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":365,"team_management":true,"audit_logs":true}')
ON CONFLICT (name) DO NOTHING;

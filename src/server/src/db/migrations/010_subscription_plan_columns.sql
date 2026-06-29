-- Phase 10 数据库迁移：补充 subscription_plans 表的缺失列
-- 执行日期：2026-06-29

-- 10.1 添加缺失的列到 subscription_plans 表
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) CHECK (billing_cycle IN ('monthly', 'yearly'));
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 2;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_clipboard_items INTEGER DEFAULT 50;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_file_size_mb INTEGER DEFAULT 1;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER DEFAULT 100;

-- 10.2 更新现有数据（从 price_monthly 复制到 price，从 plan_type 复制到 billing_cycle）
UPDATE subscription_plans SET 
  price = price_monthly,
  billing_cycle = 'monthly',
  max_devices = device_limit,
  max_clipboard_items = clipboard_limit,
  max_file_size_mb = file_size_limit,
  max_storage_mb = storage_limit
WHERE price IS NULL;

-- 10.3 添加 billing_cycle 列到 user_subscriptions 表
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) CHECK (billing_cycle IN ('monthly', 'yearly'));

-- 更新 schema 版本
INSERT INTO schema_migrations (version, applied_at) 
VALUES ('010', NOW())
ON CONFLICT (version) DO NOTHING;

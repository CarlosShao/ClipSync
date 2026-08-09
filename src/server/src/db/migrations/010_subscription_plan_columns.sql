-- =====================================================
-- 010_subscription_plan_columns.sql
-- 兼容：004 (UUID + max_devices 已建) / 004 早期 (SERIAL + device_limit)
-- 全部 IF NOT EXISTS / DO $$ 守卫，幂等可重跑
-- 执行：2026-08-09（CI 测试库跑空库时 device_limit 不存在，加兜底）
-- =====================================================

-- 1) 新库字段补全（004 已建/未建都安全）
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) CHECK (billing_cycle IN ('monthly', 'yearly'));
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 2;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_clipboard_items INTEGER DEFAULT 50;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_file_size_mb INTEGER DEFAULT 1;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER DEFAULT 100;

-- 2) 老字段 → 新字段搬运（仅当老列存在时执行；新库全部跳过，避免冗余）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'device_limit'
  ) THEN
    UPDATE subscription_plans
       SET max_devices = device_limit
     WHERE max_devices IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'clipboard_limit'
  ) THEN
    UPDATE subscription_plans
       SET max_clipboard_items = clipboard_limit
     WHERE max_clipboard_items IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'file_size_limit'
  ) THEN
    UPDATE subscription_plans
       SET max_file_size_mb = file_size_limit
     WHERE max_file_size_mb IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'storage_limit'
  ) THEN
    UPDATE subscription_plans
       SET max_storage_mb = storage_limit
     WHERE max_storage_mb IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'price_monthly'
  ) THEN
    UPDATE subscription_plans
       SET price = price_monthly
     WHERE price IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'plan_type'
  ) THEN
    UPDATE subscription_plans
       SET billing_cycle = 'monthly'
     WHERE billing_cycle IS NULL;
  END IF;
END $$;

-- 3) user_subscriptions.billing_cycle
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10)
  CHECK (billing_cycle IN ('monthly', 'yearly'));

-- 4) 标记迁移完成（幂等）
INSERT INTO schema_migrations (version, applied_at)
VALUES ('010', NOW())
ON CONFLICT (version) DO NOTHING;

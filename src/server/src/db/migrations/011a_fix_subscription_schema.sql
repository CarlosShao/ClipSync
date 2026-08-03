-- Migration 011a: 修复 subscription_plans 历史 schema 漂移
-- 原因：004_subscription_tables.sql 早期版本使用 SERIAL PK 与 plan_type/device_limit
--       等字段，与后续 012_schema_completion.sql、业务代码使用的 UUID PK +
--       display_name/max_devices 不一致，导致迁移链断裂。
-- 行为：检测 subscription_plans.id 类型；若是 INTEGER（旧版），则备份旧表后
--       重新创建 UUID 版，并重新 seed Free/Pro/Enterprise。
-- 当前环境：user_subscriptions / payment_orders / invoices 数据量为 0，可安全重建。
-- 执行日期：2026-08-03
-- =============================================

DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'subscription_plans' AND column_name = 'id';

  IF col_type IS NULL THEN
    -- 表不存在，直接由 004 或 012 创建，无需处理
    RETURN;
  END IF;

  IF col_type = 'uuid' THEN
    -- 已经是 UUID 版，无需处理
    RETURN;
  END IF;

  -- 旧版 INTEGER 表存在，需要整体替换
  -- 1. 删除依赖表（数据量为 0）
  DROP TABLE IF EXISTS invoices CASCADE;
  DROP TABLE IF EXISTS payment_orders CASCADE;
  DROP TABLE IF EXISTS user_subscriptions CASCADE;

  -- 2. 备份旧表
  DROP TABLE IF EXISTS subscription_plans_legacy_004;
  ALTER TABLE subscription_plans RENAME TO subscription_plans_legacy_004;

  -- 3. 重建 UUID 版 subscription_plans
  CREATE TABLE subscription_plans (
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

  -- 4. 重新 seed
  INSERT INTO subscription_plans (name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features) VALUES
  ('Free', '免费版', '基础剪贴板同步功能', 0, 0, 2, 50, 1, 100, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":false,"full_text_search":false,"version_history_days":3}'),
  ('Pro', '专业版', '完整功能解锁', 9.9, 99, 10, 500, 10, 1024, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":30}'),
  ('Enterprise', '企业版', '团队协作和高级管理', 19.9, 199, 100, 5000, 50, 10240, '{"ai_classify":true,"offline_queue":true,"e2e_encryption":true,"push_notification":true,"full_text_search":true,"version_history_days":365,"team_management":true,"audit_logs":true}');

  -- 5. 清理备份（若需要保留可改为保留）
  DROP TABLE subscription_plans_legacy_004;
END $$;

-- 兼容性 ALTER：确保所有列都存在（幂等）
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

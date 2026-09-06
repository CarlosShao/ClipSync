-- =============================================
-- 047: 补齐 user_subscriptions 缺失列（trial_end / cancel_at_period_end）
-- 背景：
--   代码链路（subscriptions.js subscribe/current/cancel/resume、aiTools 订阅工具）
--   引用了 trial_end 与 cancel_at_period_end 列，migrate-manager.js 的建表模板
--   也包含这两列；但早期迁移/init 脚本建表时未包含，导致：
--   - POST /subscriptions/subscribe → 500（INSERT trial_end 报列不存在）
--   - POST /subscriptions/cancel → 500（UPDATE cancel_at_period_end）
--   - POST /subscriptions/resume → 500（SELECT cancel_at_period_end）
-- 范围：
--   user_subscriptions.trial_end TIMESTAMPTZ（7 天试用到期时间）
--   user_subscriptions.cancel_at_period_end BOOLEAN DEFAULT false（期末取消标记）
-- 依赖：user_subscriptions（001）。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP WITH TIME ZONE;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;

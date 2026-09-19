-- =============================================
-- 072: 真实退款所需的时间戳列（任务板 #10 第二步）
-- 背景：
--   /api/payments/refund 接入 alipay.trade.refund 后，需要在「渠道确认钱已退回」
--   的同一事务里落库两个时间：订单退款时间、订阅权益收回时间。
--   而现有 schema 两列都缺：
--     - payment_orders 无 refunded_at（被废弃的那版假退款实现 UPDATE 过该列，
--       真跑起来只会 500，这也是它当年没被发现的的原因之一）
--     - user_subscriptions 无 canceled_at，只有 end_date —— 而 end_date 记的是
--       「原本排到的期末」，无法区分「自然到期」与「退款/升级被提前收回」
-- 范围：
--   payment_orders.refunded_at      TIMESTAMPTZ 渠道退款成功时间
--   user_subscriptions.canceled_at  TIMESTAMPTZ 订阅被终止时间（退款收回 / 升级取代）
-- 消费方：src/server/src/routes/payments.js（/refund）、
--         src/server/src/services/orderFulfillment.js（升级取代旧订阅）。
-- 依赖：payment_orders / user_subscriptions（004）。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP WITH TIME ZONE;

INSERT INTO schema_migrations (version, applied_at) VALUES ('072', NOW())
  ON CONFLICT (version) DO NOTHING;

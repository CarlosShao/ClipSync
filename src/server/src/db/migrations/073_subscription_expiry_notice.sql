-- =============================================
-- 073: 订阅到期提醒开关（任务板 #16 的铺路工单，本期只铺数据面，不做调度任务）
--
-- 落点选择（users 布尔列 vs notification_preferences 一行开关）：
--   选 users.subscription_expiry_notice BOOLEAN NOT NULL DEFAULT true，原因：
--     1. notification_preferences 虽已有 subscription_expiring 这类 notification_type，
--        但该表被同时当成「偏好」与「通知实例」用（带 title/content/status/sent_at/
--        read_at），且**没有任何写入方给新注册用户批量插行**（005 的回填只覆盖当时的
--        存量用户）。以它为准就得再约定一条「缺行 = 默认开启」，默认语义散在代码里；
--     2. users 布尔列 + DEFAULT true 在 PG11+ 是元数据级变更（不重写表）：存量用户
--        直接读到 true，新用户走 DEFAULT，"默认开启"只有一处定义。
--   侵入面：users 加一列，不改任何既有读写路径。
--
-- 消费方：本期无（到期提醒调度是后续工单）；届时按
--         `subscription_expiry_notice = true AND us.status='active'` 扫描即可，
--         故同时补一条 active 订阅到期时间部分索引，避免扫描走全表。
--
-- 依赖：users（001）、user_subscriptions（004）。
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expiry_notice BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_active_period_end
    ON user_subscriptions (current_period_end)
 WHERE status = 'active';

INSERT INTO schema_migrations (version, applied_at) VALUES ('073', NOW())
  ON CONFLICT (version) DO NOTHING;

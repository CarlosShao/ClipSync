-- =============================================
-- 048: 修复 user_subscriptions_status_check 约束与代码状态值漂移
-- 背景：
--   代码（subscriptions.js）使用的订阅状态值与 DB check 约束不一致，导致：
--   - POST /subscriptions/subscribe 新用户试用路径写 status='trial' → 500
--     （7 天试用是产品逻辑：isTrial 时 status='trial'、trial_end=NOW()+7d）
--   - POST /subscriptions/subscribe 已订阅升级路径写 status='cancelled' → 500
--     （英式拼写，与约束中 'canceled' 不一致）
--   - 多处查询 status IN ('active','trial')、cancel_at_period_end 逻辑依赖 trial
-- 范围：
--   user_subscriptions_status_check：允许
--     active / trial / canceled / cancelled / past_due / expired
--   幂等：先 DROP 再 ADD（同约束名），可重复执行。
-- =============================================

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_status_check
  CHECK (status::text = ANY (ARRAY['active'::character varying, 'trial'::character varying,
    'canceled'::character varying, 'cancelled'::character varying,
    'past_due'::character varying, 'expired'::character varying]::text[]));

-- =============================================
-- 074: 退款申请（两段式退款）+ 自助退款时限可配置
--
-- 为什么要这张表（产品决策 2026-09-20）：
--   原实现是「用户点退款 → 服务端同步调 alipay.trade.refund → 秒级到账」，
--   现实中没有商家这么退钱（Google 订阅退款也要显示 N 个工作日原路退回）。
--   支付宝的退款接口本身是**同步**的：一旦调用，钱几秒就退出去了，事后无法
--   「拒绝」。所以审核必须发生在**调用之前** —— 用户申请时完全不碰渠道，
--   只落一条待审记录；管理员点「通过」的那一刻才真打款。
--
-- 申请时同时**立即收回权益**（服务层把订阅置 canceled、users 回 free），
--   因此不需要额外的状态机来防「一边等退款一边用 Pro」。代价：审核期间用户
--   已在用掉的天数不退（老板裁定：没有配额可量化，只能由用户承担），
--   这条损失由 refund_self_window_days 时限封顶。
--
-- 为什么不新增 payment_orders.status='refund_requested'：
--   该列在 004 是内联 CHECK（pending/paid/failed/cancelled/refunded），加取值要
--   DROP/ADD 约束，而且全仓按 status 过滤的地方很多（自动关单 sweep、发票、
--   管理台筛选、看板统计）—— 一个新枚举值的扩散面远大于「申请单单独一张表」。
--   订单状态因此保持 paid 直到钱真的退出去，refunded 仍然只表示「款已退」，
--   这条不变量对账时最关键。
--
-- subscription_snapshot 是**驳回恢复权益**的依据：驳回时退款没发生，权益是
--   申请时被临时收回的，必须按快照还原（订阅 id / 原状态 / 原到期时间 /
--   users 当时的冗余字段）。没有这份快照就无法安全驳回。
--
-- 部分唯一索引 (order_id) WHERE status='pending'：一条订单同时只能有一个在途
--   申请。用部分索引而非整表唯一，是为了保留同一订单的历史（驳回后理论上仍可
--   再申请，审计链不能断）。
--
-- 配置键走 system_configs 但不登记进 admin/configs.js 的 CONFIG_CATALOG
--   （那份白名单文件此刻有并行改动），读写端点单独放在
--   routes/admin/refundSettings.js；先例见 utils/runtimeLimits.js / clientPolicies.js
--   的「不在 CONFIG_CATALOG 键空间」注释。
--
-- 依赖：users/payment_orders（001、004）、user_subscriptions（004）、
--       system_configs（038）。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT DO NOTHING，可重复执行。
-- =============================================

CREATE TABLE IF NOT EXISTS refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  -- 冗余业务单号：管理台列表按单号检索时不必再 JOIN 订单表
  order_no VARCHAR(64) NOT NULL,
  -- 申请时的退款金额快照（本期只全额退）。审核通过时以**订单当前 amount** 为准，
  -- 这里存的是给人看的那一条，避免"申请 9.9、退的是另一个数"看不懂。
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
  -- processing 是「已认领、正在调渠道、结果未知」的中间态：审核通过要跨一次外部
  -- HTTP，不能用事务行锁横跨（并发审核会互相排队、锁超时还会留下"钱退了库没改"）。
  -- 用 CAS 先把 pending 抢成 processing 再打款，就既不跨网络持锁，又能让人看出
  -- 「这条卡在渠道调用上」—— 停在 processing 的行必须先去支付宝查单，不能盲重试。
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'approved', 'rejected')),
  -- 申请时生效的自助退款时限（天）：事后管理员判断"当初为什么放行"要用
  window_days_at_request INTEGER NOT NULL DEFAULT 7,
  user_reason TEXT,
  -- 权益快照（驳回恢复用）：{ subscriptionId, subscriptionStatus, currentPeriodEnd,
  --   planId, userId, userSubscriptionStatus, userCurrentSubscriptionId }
  entitlement_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 一条订单只允许一个在途申请（资金动作的幂等闸，防重复提交与并发双退）
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_requests_pending_per_order
    ON refund_requests (order_id)
 WHERE status = 'pending';

-- 管理台默认视图：待审列表按申请时间正序（先申请先处理）
CREATE INDEX IF NOT EXISTS idx_refund_requests_pending_requested_at
    ON refund_requests (requested_at)
 WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_refund_requests_user_requested_at
    ON refund_requests (user_id, requested_at DESC);

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('refund_self_window_days', '7'::jsonb,
   '属主自助退款时限（天）：付款后超过该天数不再受理退款申请', 'payment'),
  ('refund_review_business_days', '3'::jsonb,
   '退款审核承诺工作日数：仅用于客户端文案「预计 N 个工作日内原路退回」', 'payment')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('074', NOW())
  ON CONFLICT (version) DO NOTHING;

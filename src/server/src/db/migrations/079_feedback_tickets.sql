-- =============================================
-- 079: 应用内反馈工单（feedback_tickets）
--
-- 背景：桌面端「设置 → 关于 ClipSync → 发送反馈」此前是跳转 GitHub Issue
--   （src/desktop/src/components/settings/settings-dialog/AboutView.vue），
--   另有两处同功能桩实现（FeedbackSubPage.vue / FeedbackModal.vue）因为
--   「后端没有 POST /api/feedback」而只能提示"服务未接入"。本迁移 + 新路由
--   routes/feedback.js 让它变成真实的应用内工单：**先落库**、再尽力发企业邮箱。
--
-- 为什么落库优先、发信尽力而为（产品决策）：
--   用户提交反馈时 SMTP 抖动 / 邮件通道未配置 / 断路器打开都不该让用户看到失败。
--   落库成功即接口成功（HTTP 200），发信结果只作为附注写回本行：
--     email_sent=true 且 email_error IS NULL  → 已投递给 SMTP；
--     email_sent=false 且 email_error 有值     → 未投递（原因可查，管理台可重发）。
--   注意：utils/email.js 在「通道未配置」时走 console 兜底并返回
--   { success: true, fallback: true } —— 那**不是**真实投递。feedback 路由把这
--   种兜底显式记为 email_sent=false / email_error='smtp_unconfigured'，
--   绝不在库里留下"已发送"的假结论（否则事后无法分辨哪些工单真发出去了）。
--
-- user_id 用 ON DELETE SET NULL 而非 CASCADE：反馈是产品改进的输入，
--   用户注销后工单必须留档（只是失去提交人关联），不能被级联删掉。
--
-- contact 是可选的回访方式（邮箱/手机/微信都合法），因此不做格式约束，
--   只限长度；真正的邮箱格式校验只用于「默认带出当前用户邮箱」这一前端行为。
--
-- category / status 的取值白名单与 routes/feedback.js 的 FEEDBACK_CATEGORIES
--   保持一致（服务端另有显式校验，CHECK 是最后一道防线）。
--
-- 依赖：users（001）。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT DO NOTHING，可重复执行。
-- =============================================

CREATE TABLE IF NOT EXISTS feedback_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 提交人；用户注销后保留工单（SET NULL 而非 CASCADE）
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL
    CHECK (char_length(title) BETWEEN 1 AND 200),
  -- 'feature' | 'bug' | 'performance' | 'ui' | 'other'（与路由白名单一致）
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('feature', 'bug', 'performance', 'ui', 'other')),
  content TEXT NOT NULL
    CHECK (char_length(content) BETWEEN 1 AND 5000),
  contact TEXT
    CHECK (contact IS NULL OR char_length(contact) <= 200),
  app_version TEXT,
  platform TEXT,
  -- 工单生命周期：open → in_progress → resolved / closed（本期只写 open）
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 按用户查自己的历史反馈 / 管理台看某用户的工单
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_user_id
    ON feedback_tickets (user_id);

-- 管理台默认视图：最新工单在前
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_created_at
    ON feedback_tickets (created_at DESC);

INSERT INTO schema_migrations (version, applied_at) VALUES ('079', NOW())
  ON CONFLICT (version) DO NOTHING;

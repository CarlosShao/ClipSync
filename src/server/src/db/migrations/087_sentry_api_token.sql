-- =============================================
-- 087: Sentry API Token（错误列表集成用）
--
-- 背景：迁移 086 已让服务端能把错误上报到 Sentry（`sentry_dsn`）。但**看**错误还得登 sentry.io ✗ ——
-- 管理台里只有配置项、没有错误列表。owner 2026-10-08 要求做"最完善的那个"：
-- 后台内直接看未解决 issue 列表（级别 / 次数 / 最近发生 / 标题 / 点击跳 sentry）。
--
-- 为什么要单独一个 token（而不是复用 DSN）：
--   DSN 是**只写**凭据（仅够上报，Sentry 设计如此），读 issue 必须用 **API Token**
--   （Sentry → Settings → Auth Tokens，scope 至少 `project:read` + `event:read`）。
--   token 是真正的读凭据 ⇒ **加密落库**（与 smtp_pass / sms_access_key_secret 同口径），
--   管理台只回显"已配置/未配置"，永不回传明文。
--
-- 只需填两个值：`sentry_dsn`（机构/项目从 DSN 里推导）+ `sentry_api_token`（本迁移新增）。
--
-- 语义：留空 ⇒ 「错误列表」卡显示"未配置 API Token"，功能整体不启用（零副作用）。
-- 幂等：ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/utils/sentry.js（getSentryApiToken / fetchSentryIssues）。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('sentry_api_token', '""', 'Sentry API Token（加密存储；用于在管理台读取错误列表。Sentry → Settings → Auth Tokens，scope 需 project:read + event:read）', 'ops')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('087', NOW())
  ON CONFLICT (version) DO NOTHING;

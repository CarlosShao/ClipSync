-- =============================================
-- 089: 第三方登录（OAuth 设备码流）—— 身份关联表 + 配置键
--
-- 背景：桌面端登录/注册页有 7 个品牌按钮，但全是空占位（点了只弹「注册流程即将推出！」）。
-- owner 2026-10-08 定：先做 **GitHub**（已给 Client ID）与 **Microsoft Entra**（已给客户端/租户 ID），
-- 其余（WeChat / Apple / WeCom）**隐藏**，等账号+备案齐了再开。
--
-- 为什么用 **RFC 8628 设备码流**（Device Authorization Grant）而不是浏览器回调：
--   桌面端要落地回调，就得在 Rust 侧起本地监听端口或注册深链协议；而设备码流
--   **不需要回调地址、不需要备案域名、不必改 Rust** —— 应用内显示 8 位码，
--   用户在 github.com/login/device 输入即可。GitHub 与 Entra 都原生支持。
--
-- ⚠️ users.phone 是 NOT NULL（varchar，无默认值）⇒ 第三方首次登录**没有手机号**，
--    这里用**占位值** `oauth:<provider>:<providerUserId>`：
--      - 唯一、且绝不与 11 位真实手机号冲突；
--      - `phone_hash` 保持 NULL ⇒ 不会被"手机号+验证码"登录命中（两个入口不会互相串号）；
--      - 用户后续可在客户端绑定真实手机号（届时覆盖占位值，走既有的换绑口径）。
--    没有选择"把 phone 改成可空"：那会让所有以 phone 为键的老逻辑（登录、风控、审计）都要重新审一遍，
--    风险远大于收益。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/services/oauthDevice.js、routes/auth-oauth.js
-- =============================================

CREATE TABLE IF NOT EXISTS oauth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(128) NOT NULL,
  email VARCHAR(255),
  nickname VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT oauth_identities_provider_uid_key UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

COMMENT ON TABLE oauth_identities IS
  '第三方登录身份（GitHub / Microsoft 设备码流）。唯一键 (provider, provider_user_id) 保证一个第三方账号只对应一个本站账号。';

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('oauth_github_client_id', '""', 'GitHub OAuth App 的 Client ID（设备码流**不需要** Client Secret）；留空 = 该入口不可用', 'security'),
  ('oauth_microsoft_client_id', '""', 'Microsoft Entra 应用的「应用程序(客户端) ID」（public client，无需 secret）；留空 = 该入口不可用', 'security'),
  ('oauth_microsoft_tenant', '"common"', 'Entra 租户 ID 或域名；多租户填 common（默认）', 'security')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('089', NOW())
  ON CONFLICT (version) DO NOTHING;

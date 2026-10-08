-- =============================================
-- 088: 人机验证（Cloudflare Turnstile）配置键
--
-- 背景：owner 2026-10-08 已注册 Turnstile 并拿到 Site Key / Secret Key，但**界面上没有能填的地方** ——
-- 之前没有任何迁移种过人机验证的配置键。
--
-- 三个键（与短信/邮件同口径：运行时配置 + 管理台可填，不进 env、不必重启容器）：
--   turnstile_site_key    公开值，前端渲染 widget 用（可明文落库）
--   turnstile_secret_key  服务端校验用（**加密落库**，与 smtp_pass / sms_access_key_secret 同口径）
--   turnstile_enabled     **总开关，默认 false**
--
-- ⚠️ 为什么必须有独立开关、且默认关：
--   发码接口（POST /api/auth/send-code）是**桌面端 / 移动端 / 管理台共用**的。
--   一旦强制要求 captcha token，**没带 token 的客户端会立刻登录不了** ✗。
--   所以顺序必须是：① 填 key（本迁移的键，此时零影响）→ ② 客户端也挂上 widget
--   → ③ 再打开 `turnstile_enabled`。开关默认 false = 行为与今天完全一致。
--
-- 幂等：ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/utils/turnstile.js（校验）、routes/auth-verify.js / auth.js（发码前的门控）。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('turnstile_site_key', '""', 'Cloudflare Turnstile Site Key（公开值，前端渲染组件用）', 'security'),
  ('turnstile_secret_key', '""', 'Cloudflare Turnstile Secret Key（加密存储；服务端校验用）', 'security'),
  ('turnstile_enabled', 'false', '人机验证总开关：默认 false。⚠️ 打开前必须确保桌面端/移动端也已挂上 widget，否则客户端将无法发码登录', 'security')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('088', NOW())
  ON CONFLICT (version) DO NOTHING;

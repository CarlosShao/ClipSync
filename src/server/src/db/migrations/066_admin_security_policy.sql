-- =============================================
-- 066: AN-12 管理员安全策略 —— force_2fa_for_admin 开关
-- （061~065 已被并发工单 AN-03/AN-04/AN-06 占用，避让取 066）
-- 语义：开启后，管理角色（roles.level >= 50，admin / super_admin）
--       在登录时若未绑定两步验证（users.two_factor_enabled = false），
--       登录接口返回 403 + forceTwoFactorSetup 标识，引导先绑定 2FA。
-- 强制点：src/server/src/utils/adminSecurity.js（shouldForceTwoFactorForAdmin），
--         由 routes/auth.js /login、/verify-code、/verify-email-code 及
--         routes/auth-verify.js 同名路由调用。
-- 默认 FALSE：升级零行为变化。
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(feature_flags)。
-- =============================================

INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('force_2fa_for_admin', FALSE, 'AN-12 强制管理员两步验证（管理角色未绑定 2FA 时登录被拦截并引导绑定）')
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('066', NOW())
ON CONFLICT (version) DO NOTHING;

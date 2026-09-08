-- =============================================
-- 051: 注册总开关 enable_signup（方案三 CO-31）
-- 语义：与 signup_waitlist 正交——
--   enable_signup=false → 注册接口直接 403（完全关闭注册）
--   enable_signup=true + signup_waitlist=true → 注册进待审核
--   enable_signup=true + signup_waitlist=false → 正常注册
-- 默认 true：升级零行为变化。两端注册入口按此开关隐藏。
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(feature_flags)。
-- =============================================

INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('enable_signup', TRUE, '注册总开关（关闭后完全禁止新用户注册）')
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('051', NOW())
ON CONFLICT (version) DO NOTHING;

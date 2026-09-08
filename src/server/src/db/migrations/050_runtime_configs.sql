-- =============================================
-- 050: 运行时可调配置键（方案三 WP-A 限流 / WP-D SMTP·日志·菜单覆盖）
-- 范围：
--   1) 限流键 5 个（默认值 = 现硬编码值，升级零行为变化）
--   2) 日志级别 log_level（运维页热调，logger.js 消费）
--   3) SMTP 键组（邮件链路落地，email.js 消费；pass 由管理台加密写入）
--   4) menu_overrides（方案一 v2 菜单覆盖，预留）
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(system_configs)。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('rate_limit_api_per_min',            '300'::jsonb,  '全局 API 限流阈值（次/分钟/用户，匿名按 IP）', 'rate_limit'),
  ('rate_limit_send_code_per_hour',     '5'::jsonb,    '验证码发送限流（次/小时/手机号）',             'rate_limit'),
  ('rate_limit_login_failed_per_15min', '5'::jsonb,    '登录失败锁定阈值（次/15分钟/手机号）',         'rate_limit'),
  ('rate_limit_upload_per_min',         '20'::jsonb,   '上传接口限流（次/分钟/用户）',                 'rate_limit'),
  ('rate_limit_disabled',               'false'::jsonb, '限流总开关（生产环境禁开）',                   'rate_limit'),
  ('log_level',                         '"info"'::jsonb, '运行时日志级别（debug/info/warn/error，热生效）', 'operations'),
  ('smtp_host',       '""'::jsonb, 'SMTP 服务器地址（空=邮件走控制台兜底）', 'email'),
  ('smtp_port',       '465'::jsonb, 'SMTP 端口（465=SSL / 587=STARTTLS）',   'email'),
  ('smtp_user',       '""'::jsonb, 'SMTP 用户名',                            'email'),
  ('smtp_pass',       '""'::jsonb, 'SMTP 密码/授权码（管理台加密存储）',      'email'),
  ('smtp_from',       '""'::jsonb, '发件人地址（如 no-reply@example.com）',   'email'),
  ('smtp_secure',     'true'::jsonb, '是否使用 SSL 直连（465=true）',          'email'),
  ('menu_overrides',  '{}'::jsonb, '菜单可见性覆盖（方案一 v2 预留，形如 {"nav.ai":{"minPlan":"Pro"}}）', 'operations')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('050', NOW())
ON CONFLICT (version) DO NOTHING;

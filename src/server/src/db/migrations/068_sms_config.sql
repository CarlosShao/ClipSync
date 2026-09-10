-- 068: 短信服务配置键（A4）
--
-- 背景：文档 external-dependency-audit 第 1 节「脏状态」第 1 条 ——
-- auth-verify.js 曾用固定码 888888 且无 NODE_ENV 判断，生产环境任何人
-- 输 888888 即可登录任意手机号。
--
-- 本迁移种入 5 个配置键，默认 provider=console（未开通）。
-- 生产环境 send-code / send-reset-pin-code 在 provider=console 或配置不全时
-- 返回 503 明确报错，绝不静默降级为固定码。
--
-- 消费方：src/server/src/utils/sms.js

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('sms_provider',           '"console"', '短信服务商：aliyun / tencent / console（未开通）', 'sms'),
  ('sms_access_key_id',      '""',        '短信 AccessKeyId（阿里云）或 SecretId（腾讯云）', 'sms'),
  ('sms_access_key_secret',  '""',        '短信 AccessKeySecret（加密存储）', 'sms'),
  ('sms_sign_name',          '""',        '短信签名（需服务商审核通过）', 'sms'),
  ('sms_template_code',      '""',        '验证码短信模板 CODE，模板变量 ${code}', 'sms')
ON CONFLICT (config_key) DO NOTHING;

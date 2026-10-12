-- =============================================
-- 091: 飞书群机器人告警配置（D1）
--
-- 背景：审计把「飞书群机器人（告警）」列为增强项（D2/D1），但代码里**一处都没有**（我 grep 过 ✗）。
-- Sentry 解决"事后去看"，告警解决"出事就知道" —— 5xx 突发、短信/邮件通道失效、支付回调异常，
-- 没人盯后台就等于没发现。
--
-- 两个键（运行时配置，管理台可填，不必重启容器）：
--   feishu_webhook_url    https://open.feishu.cn/open-apis/bot/v2/hook/xxxx（**加密落库**）
--   feishu_webhook_secret 机器人开启「签名校验」时才有；同样加密
--
-- 语义：未配置 / URL 不是飞书域名 ⇒ utils/feishu.js 全程 no-op，不发任何请求、不影响任何流程。
-- 幂等：ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/utils/feishu.js（getFeishuConfig / sendFeishuAlert）
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('feishu_webhook_url', '""', '飞书群机器人 Webhook（加密存储）。填 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx 后，5xx 突发等告警会推到群里；留空则不发', 'ops'),
  ('feishu_webhook_secret', '""', '飞书机器人「签名校验」密钥（加密存储）；机器人没开签名校验就留空', 'ops')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('091', NOW())
  ON CONFLICT (version) DO NOTHING;

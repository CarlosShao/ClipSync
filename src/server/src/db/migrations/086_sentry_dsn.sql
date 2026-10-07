-- =============================================
-- 086: 错误追踪（Sentry）DSN 运行时可配置
--
-- 背景：`SENTRY_DSN` 此前只出现在 `src/server/.env.example`，**代码零读取** ——
-- 也就是说注册了 Sentry、拿了 DSN，也不会有任何事件上报（v1 全量审计 §06 已录该漂移）。
--
-- 设计（与本仓库既有的短信 068、邮件 059 保持一致）：
--   凭据走 `system_configs` + 管理台「系统参数」可填 —— **不进 env、不必重启容器**。
--   这与既有架构债（生产真相分散在 .env.production / nginx / compose 三处不可版本化）解耦：
--   运营方拿到 DSN 后自己填一次即可生效，不需要开发侧改 env 再重启。
--
-- 语义：
--   sentry_dsn = ''                    ⇒ 不加载 SDK，`captureError()` 为 no-op
--                                        （**行为与加本迁移之前完全一致，零风险**）
--   sentry_dsn = https://<key>@o<org>.ingest.sentry.io/<project>
--                                      ⇒ 服务端未捕获异常 / unhandledRejection / 5xx 响应
--                                        带上请求路径与方法上报（**不含 PII**）
--
-- 隐私口径（接线侧强制，见 utils/sentry.js 的 scrubEvent）：
--   `sendDefaultPii:false` + beforeSend 剔除请求体 / Authorization / Cookie / query 里的
--   phone|token|code / extra 里的手机号邮箱密钥剪贴板内容 / 整个 user 段。
--
-- 自托管替代：GlitchTip 同 DSN 协议，改填它的 DSN 即可（校验只要求 http(s)://…@…/<project>）。
--
-- 幂等：ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/utils/sentry.js（getSentryConfig 读取；管理台保存该键即失效缓存并重初始化）。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('sentry_dsn', '""', 'Sentry DSN（留空=不启用错误追踪）。填好后服务端未捕获异常与 5xx 会上报，不含 PII；也可填 GlitchTip 的 DSN', 'ops')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('086', NOW())
  ON CONFLICT (version) DO NOTHING;

-- =============================================
-- 055: 运维页 Grafana 地址配置键（方案 AF-30）
-- 背景：运维页「打开 Grafana 容器总览」此前硬编码 http://localhost:3001，
--       与后端 API 端口冲突（点开是 health JSON）。改为管理台可配置：
--       CONFIG_CATALOG 增加 grafana_url，ops/overview 下发，为空时前端按钮置灰。
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(system_configs)。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('grafana_url', '""'::jsonb, 'Grafana 地址（运维页跳转用，如 http://127.0.0.1:3004；为空则按钮置灰）', 'operations')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('055', NOW())
ON CONFLICT (version) DO NOTHING;

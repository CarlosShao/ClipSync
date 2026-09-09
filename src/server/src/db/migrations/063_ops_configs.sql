-- =============================================
-- 063: 运维域新增配置键（AN-06 / AN-15 / AN-08）
-- ⚠️ 原编号 061 与 AN-12（061_admin_security_policy）/ AN-04（061_releases）撞号——
--    migrate.js 按 file.split('_')[0] 取 version，同前缀互相 skip，故改号 063。
-- 背景：管理台运维页能力补齐——
--   prometheus_url        AN-15 活跃告警只读代理数据源（ops/alerts → Prometheus /api/v1/alerts）
--   backup_retention_days AN-06 手动备份保留策略（trigger_backup 落盘后清理超期文件，默认 7）
--   storage_cleanup_enabled AN-08 存储清理总开关（ops/cleanup 手动触发闸门，默认 true）
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(system_configs)。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('prometheus_url', '""'::jsonb, 'Prometheus 地址（运维页活跃告警数据源，如 http://127.0.0.1:9090；为空则告警卡显示「告警服务不可用」）', 'operations'),
  ('backup_retention_days', '7'::jsonb, '备份文件保留天数（手动备份后自动清理超期文件，默认 7）', 'operations'),
  ('storage_cleanup_enabled', 'true'::jsonb, '存储清理开关（关闭后管理台「存储清理」动作拒绝执行）', 'operations')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('063', NOW())
ON CONFLICT (version) DO NOTHING;

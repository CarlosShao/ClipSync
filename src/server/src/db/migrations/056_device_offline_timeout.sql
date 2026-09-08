-- =============================================
-- 056: 设备离线判定阈值配置键（AF-50）
-- 背景：devices.is_online 此前仅由 WS register（置 true）与 close 处理器
--       （置 false）维护。close 依赖进程存活——docker restart / kill / 崩溃
--       等非优雅退出不会执行 close，is_online 残留 true；客户端未连 WS 时
--       也没有基于 last_seen_at 的兜底纠正（审计实测 4 台全离线）。
--       新增 deviceOnlineSweep 定时扫描（每 60s）将心跳超时的在线设备置离线，
--       阈值走本键，管理台「系统参数」可改，缺省 5 分钟。
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(system_configs)。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('device_offline_timeout_minutes', '"5"'::jsonb, '设备离线判定阈值（分钟）：在线设备超过该时长未上报心跳（WS ping）将被定时扫描置为离线', 'operations')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('056', NOW())
ON CONFLICT (version) DO NOTHING;

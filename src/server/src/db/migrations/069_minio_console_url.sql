-- 069: MinIO 控制台地址配置键（D1）
--
-- 用途：管理台「运维监控」页直接提供对象存储控制台入口，
-- 免去每次手敲 http://localhost:9011。
-- 仅用于跳转展示，不参与存储读写；为空时前端按钮置灰。
--
-- 消费方：src/server/src/routes/admin/ops.js（probeObjectStorage → overview.objectStorage.consoleUrl）

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES (
  'minio_console_url',
  '""',
  '对象存储 Web 控制台地址（如 http://localhost:9011）；空=运维页按钮置灰',
  'ops'
)
ON CONFLICT (config_key) DO NOTHING;

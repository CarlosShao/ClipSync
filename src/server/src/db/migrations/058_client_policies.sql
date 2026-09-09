-- =============================================
-- 058: 客户端策略下发（AN-02）
-- ⚠️ 编号说明：原编号 057——但 migrate.js 按「文件名前缀」取 version，同前缀迁移
--    互相 skip（057 已被 057_announcement_deliveries.sql 占用导致本迁移被跳过、
--    表未创建），实测踩坑后改编号 058。
-- 背景：桌面端 20 项配置全部 localStorage/Tauri 本地存储，服务端零管控（G3）。
--       新表 client_policies 承载面向客户端的下发策略，scope 先只支持 'global'
--       （本期不做按用户/按套餐分组，见工单 AN-02 边界）。
-- payload 结构（JSONB，键 = 策略键）：
--   { "pin_min_length": { "value": 4, "allowUserOverride": true }, ... }
--   value  = 策略值（服务端为默认/边界，语义见 utils/clientPolicies.js POLICY_CATALOG）
--   allowUserOverride = false 时客户端对应设置项置灰锁定
-- 键目录与校验唯一真相源：src/server/src/utils/clientPolicies.js（POLICY_CATALOG），
-- 本迁移只建表与种子行，不写业务键（未配置的键按 catalog default 兜底 = 现行为，零破坏）。
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：无（独立新表）。
-- =============================================

CREATE TABLE IF NOT EXISTS client_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(32) NOT NULL UNIQUE DEFAULT 'global',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 种子：全局策略行（payload 空 = 全部键走目录默认值）
INSERT INTO client_policies (scope, payload) VALUES ('global', '{}'::jsonb)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('057', NOW())
ON CONFLICT (version) DO NOTHING;

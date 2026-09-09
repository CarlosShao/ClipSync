-- =============================================
-- 060: 废弃无消费方配置键（AN-14，第二轮死配置清理）
-- 编号说明：原编 057，因与 057_announcement_deliveries.sql 撞号
--           （migrate.js 按文件名首段取 version，先登记者生效、后者被 SKIP）
--           改号为 060（058=client_policies、059=email_channels 已被占用）。
-- 背景：AN-09 为 CONFIG_CATALOG 逐键登记 consumer 后，确认以下两键
--       consumer === null 且无任何工单规划接线：
--         max_collection_depth  —— collections 链路无任何 depth 读取点（无硬编码校验也无读取）
--         enable_audit_log      —— utils/audit.js logAuditEvent 无条件写库，无此键读取点
--       管理台「系统参数」已同步从展示目录（routes/admin/configs.js CONFIG_CATALOG）移除，
--       运营不再可见「配了不生效」的死项（AN-14 验收口径）。
-- 处理：仅登记废弃语义，不删除 system_configs 历史数据（审计留痕可回溯）；
--       若未来接线消费（如 AN-03 式改造），恢复目录登记即可，数据无需重建。
-- 幂等：可重复执行（本文件无 DML，仅注释）。
-- 依赖：050(system_configs 展示键种子)。
-- =============================================

-- 说明：system_configs 无 schema 级注释位，废弃标记以本文件注释 +
--       代码侧 CONFIG_CATALOG 移除为准。如需在库内直观可见，
--       可手工执行（默认不代跑，避免覆盖 description 展示）：
--       UPDATE system_configs SET description = description || '（已废弃：无消费方，见 060）'
--        WHERE config_key IN ('max_collection_depth', 'enable_audit_log');

INSERT INTO schema_migrations (version, applied_at) VALUES ('060', NOW())
ON CONFLICT (version) DO NOTHING;

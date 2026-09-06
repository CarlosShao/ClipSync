-- =============================================
-- 045: audit_logs.resource_id 改为 TEXT
-- 背景：管理端审计（T-A3/A5/T-A1.5）的 resourceId 可能是订单号(CS2026…)、
--       开关键(signup_waitlist)、请求路径(/flags/x) 等非 UUID 字符串，
--       而建表时 resource_id 为 UUID 类型，导致审计 INSERT 静默失败
--       （logAuditEvent 捕获后仅记日志，业务成功但审计丢失）。
-- 方案：列类型放宽为 TEXT（UUID 值以文本存储完全兼容，现有索引不涉及该列）。
-- 幂等：对已是 TEXT 的列重复执行为无操作。
-- =============================================

ALTER TABLE audit_logs ALTER COLUMN resource_id TYPE text USING resource_id::text;

INSERT INTO schema_migrations (version, applied_at) VALUES ('045', NOW())
  ON CONFLICT (version) DO NOTHING;

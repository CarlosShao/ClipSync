-- =============================================
-- ClipSync 迁移 042: 文件同步 v1 套餐限额（file sync plan limits）
-- 用途：为跨设备文件同步 v1 落地套餐级文件配额：
--       1) subscription_plans 新增 max_files_per_clip / file_retention_days 两列
--       2) 新增列先 COALESCE 回填默认，再按方案 B 数值 UPDATE 三个套餐
--          （同时修正 max_file_size_mb / max_storage_mb 的旧 seed 漂移：
--           Free 1MB→20MB/100MB→200MB，Pro 10MB→128MB/1GB→20GB，Enterprise 50MB→512MB/10GB→200GB）
--       3) clipboard_items 文件条目查询部分索引
-- 执行日期：2026-09-02
-- 关联工单：docs/plans/file-sync-v1-tickets.md F0.1
-- 方案 B（保守，控成本）数值来源：docs/plans/file-sync-v1-plan.md 第 3.2 节：
--   | 维度               | Free   | Pro    | Enterprise |
--   | 单文件大小上限      | 20 MB  | 128 MB | 512 MB     | → max_file_size_mb: 20 / 128 / 512
--   | 云端文件总容量      | 200 MB | 20 GB  | 200 GB     | → max_storage_mb: 200 / 20480 / 204800
--   | 单次多文件数量上限  | 3 个   | 10 个  | 50 个      | → max_files_per_clip: 3 / 10 / 50
--   | 文件条目保留期      | 3 天   | 30 天  | 90 天      | → file_retention_days: 3 / 30 / 90
-- 套餐 name 取值：'Free' / 'Pro' / 'Enterprise'（与 004 / 011a 的 seed 一致；
--   012 与 migrate.js 内嵌 seed 仅补 Free/Pro，Enterprise 行由 004/011a 提供）。
-- 不修改 004 / 011a / 012 旧 seed 文件，历史迁移链保持不变（工单 F0.1 要求用 UPDATE）。
-- 幂等性：全部语句可重复执行——ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   UPDATE 为确定性赋值；手工 psql 重跑与 migrate.js 重跑均不报错、最终结果一致。
-- 事务包裹方式：与 041/012 惯例一致，文件内不使用显式 BEGIN/COMMIT，依赖幂等语句；
--   经 migrate.js 执行时，node-postgres 简单查询协议将整个文件的多语句包在单个
--   隐式事务中原子上 applied；手工 psql -f 为逐语句自动提交，故语句级幂等是必须的。
-- 版本记录：不在此文件内写 schema_migrations，由 migrate.js 执行后自动登记
--   version = '042'（file.split('_')[0]，见 migrate.js 目录扫描逻辑）。
-- 执行前备份建议（psql 内执行）：
--   SELECT * FROM subscription_plans;  -- 人工留档当前套餐数值快照
--   \copy (SELECT * FROM subscription_plans) TO 'subscription_plans_backup_042.csv' CSV HEADER
-- =============================================

-- 1. 新增列（幂等）
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_files_per_clip INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS file_retention_days INTEGER;

-- 2. COALESCE 回填默认（防新增列 NULL；未识别的套餐名走最保守的 Free 档默认值）
UPDATE subscription_plans
SET max_files_per_clip  = COALESCE(max_files_per_clip,
      CASE name WHEN 'Free' THEN 3 WHEN 'Pro' THEN 10 WHEN 'Enterprise' THEN 50 ELSE 3 END),
    file_retention_days = COALESCE(file_retention_days,
      CASE name WHEN 'Free' THEN 3 WHEN 'Pro' THEN 30 WHEN 'Enterprise' THEN 90 ELSE 3 END);

-- 3. 按方案 B 写入目标值（确定性覆盖，可重复执行，最终三行均为下表数值）
UPDATE subscription_plans SET max_file_size_mb = 20,  max_storage_mb = 200,    max_files_per_clip = 3,  file_retention_days = 3  WHERE name = 'Free';
UPDATE subscription_plans SET max_file_size_mb = 128, max_storage_mb = 20480,  max_files_per_clip = 10, file_retention_days = 30 WHERE name = 'Pro';
UPDATE subscription_plans SET max_file_size_mb = 512, max_storage_mb = 204800, max_files_per_clip = 50, file_retention_days = 90 WHERE name = 'Enterprise';

-- 4. 文件条目查询部分索引（幂等）
CREATE INDEX IF NOT EXISTS idx_clipboard_items_user_file
  ON clipboard_items (user_id) WHERE content_type = 'file';
CREATE INDEX IF NOT EXISTS idx_clipboard_items_expires
  ON clipboard_items (expires_at) WHERE expires_at IS NOT NULL;

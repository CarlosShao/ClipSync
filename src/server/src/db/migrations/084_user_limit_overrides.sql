-- =============================================
-- 084: 单用户配额覆盖（users.limit_overrides JSONB）
--
-- 场景：某个用户需要**单独的**配额（客诉补偿、大客户、内部测试），而既有的
-- `PATCH /admin/plans/:id` 改的是套餐行 —— 那会同时影响该套餐下的**所有人**，
-- 完全是两回事。此前只能改库，而改库有两个问题：无审计，且 planLimits 是
-- "按套餐算配额"的唯一入口，改库只改了数据、没有改口径。
--
-- 落点选择（users JSONB 列 vs 独立表 vs 改套餐行）：
--   1. 独立表 user_limit_overrides：覆盖是**与用户 1:1 的小属性**，独立表只会给
--      "每次上传都要跑一次"的 getPlanLimits 多加一个 JOIN，没有收益；
--   2. 改 subscription_plans：影响该套餐所有人 —— 正是要避免的事；
--   3. users.limit_overrides JSONB：与 users 天然 1:1、一次查询就能取到，
--      且覆盖通常是**稀疏补丁**（一般只改一两项）。选它。
--
-- 为什么 JSONB 而不是 4 个显式列（max_file_size_mb/max_storage_mb/
-- max_files_per_clip/file_retention_days）：稀疏补丁用 4 列会出现大量 NULL
-- 语义歧义（"没覆盖"与"覆盖为不限"都可能是 NULL），而 JSONB 用
-- **键是否存在**表达"有没有覆盖"、**键值为 null** 表达"这一项不限"
-- （与 subscription_plans 里 NULL = 不限的既有语义一致）。仓内已有
-- subscription_plans.features / clipboard_items.metadata 两处 JSONB 先例。
--
-- 语义：
--   NULL / 键不存在 ⇒ 沿用套餐值（**存量用户全部走这条，行为零变化**）
--   键存在且为数字 ⇒ 覆盖为该值（单位与 subscription_plans 对应列一致：
--                    MB / 个数 / 天）
--   键存在且为 null ⇒ 该项**不限**
--
-- ⚠️ 消费方必须**先探测列是否存在**（information_schema，与 042 的
-- max_files_per_clip / file_retention_days 同一套路）：迁移在服务启动时执行，
-- 但"新二进制 + 旧库"的窗口真实存在，直接 SELECT 一个不存在的列会让整条配额查询
-- 抛错，而 planLimits 的兜底是 **FALLBACK_LIMITS（Free 级别）** —— 那等于把全体
-- 用户静默降级。宁可退化成"没有覆盖"，也不能让查询炸。
--
-- 依赖：users（001/012）。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_overrides JSONB;

COMMENT ON COLUMN users.limit_overrides IS
  '单用户配额覆盖（稀疏补丁）。键：max_file_size_mb / max_storage_mb / max_files_per_clip / file_retention_days；键值为 null 表示该项不限。NULL 或键缺失 = 沿用套餐值。写入方：POST /api/admin/users/:id/limits。';

INSERT INTO schema_migrations (version, applied_at) VALUES ('084', NOW())
  ON CONFLICT (version) DO NOTHING;

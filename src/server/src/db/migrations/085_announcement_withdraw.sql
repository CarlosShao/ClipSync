-- =============================================
-- 085: 公告软撤回（admin_announcements.withdrawn_at）
--
-- 背景：公告此前**只能发、不能撤**。发错内容（写错价格、发错受众、把内部草稿发出去）
-- 时，客户端 `GET /api/app/announcements` 仍会一直返回它，运营只能改库 —— 而表上
-- 根本没有表示"撤回"的列，改库连语义都没有。
--
-- 为什么是**软**撤回（加列）而不是硬删：
--   1. `admin_announcement_deliveries`（057 触达）与 `admin_announcement_reads`（052 已读）
--      都是 `announcement_id ... REFERENCES admin_announcements(id) ON DELETE CASCADE`
--      —— 硬删会**连带删掉送达/已读/点击统计**，而这几张表正是"这条公告到底发给了谁、
--      多少人看过"的唯一证据。发错公告之后恰恰最需要这份证据。
--   2. 撤回本身是要留痕的操作：`withdrawn_at` 让"什么时候撤的"成为数据的一部分，
--      审计里另有 `admin.announce.withdraw` 记操作者与原因。
--
-- 语义：
--   withdrawn_at IS NULL      ⇒ 正常公告（**存量行全部如此，行为零变化**）
--   withdrawn_at IS NOT NULL  ⇒ 已撤回：客户端拉取侧过滤掉；管理台历史里仍可见并标记
--
-- ⚠️ 消费方（routes/app.js 的客户端拉取）直接引用本列。这里不加 information_schema 探测，
-- 理由是启动链更硬：`src/index.js` 在监听端口**之前** `await migrate()`，失败即
-- `process.exit(1)` —— 也就是说**任何正在对外服务的实例都必然已跑过本迁移**。
--
-- 依赖：admin_announcements（044）。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- =============================================

ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

COMMENT ON COLUMN admin_announcements.withdrawn_at IS
  '软撤回时间。NULL = 正常公告；非 NULL = 已撤回（客户端拉取侧过滤，管理台历史仍可见）。写入方：POST /api/admin/announcements/:id/withdraw。';

INSERT INTO schema_migrations (version, applied_at) VALUES ('085', NOW())
  ON CONFLICT (version) DO NOTHING;

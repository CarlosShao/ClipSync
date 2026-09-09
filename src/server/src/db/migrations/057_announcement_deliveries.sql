-- =============================================
-- 057: 公告真实触达表（工单 AN-05 + AF-22 第 3 点预留的 reached_count）
-- 口径：送达 = WS 推送成功的用户 ∪ 上线后拉取到公告的用户，
--       按公告受众过滤后去重记录；管理台 reached_count = 本表去重用户数。
--       已读仍走 052 回执表 admin_announcement_reads（AF-22 口径不变，勿回退）。
-- 幂等：CREATE TABLE IF NOT EXISTS；可重复执行。
-- 依赖：044(admin_announcements) / 052(同构回执表)。
-- =============================================

-- 一个用户对一条公告至多一条触达记录（announcement_id + user_id 唯一）
CREATE TABLE IF NOT EXISTS admin_announcement_deliveries (
  announcement_id UUID NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_channel VARCHAR(16) NOT NULL DEFAULT 'pull', -- 首次触达渠道：ws（WS 推送成功）/ pull（上线拉取）
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_deliveries_user
  ON admin_announcement_deliveries(user_id);

INSERT INTO schema_migrations (version, applied_at) VALUES ('057', NOW())
ON CONFLICT (version) DO NOTHING;

-- 022: 搜索历史表
-- 用途：持久化用户的历史搜索关键词，随账号跨设备同步。
--       (user_id, keyword) 唯一，重复搜索只更新 updated_at（顶到列表最前）。

CREATE TABLE IF NOT EXISTS search_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id);
CREATE INDEX IF NOT EXISTS idx_search_history_user_updated ON search_history(user_id, updated_at DESC);

INSERT INTO schema_migrations (version, applied_at) VALUES ('022', NOW())
  ON CONFLICT (version) DO NOTHING;

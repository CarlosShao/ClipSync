-- 019: 剪贴板分享链接表
-- 用途：用户把一段剪贴板内容生成对外分享链接（token 即访问凭证），
--       支持过期时间、访问计数、撤销。内容 at-rest 加密存储。

CREATE TABLE IF NOT EXISTS shared_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token             TEXT NOT NULL UNIQUE,
  title             TEXT,
  content_encrypted TEXT NOT NULL,
  content_preview   TEXT,
  content_type      TEXT NOT NULL DEFAULT 'text',
  views             INTEGER NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_links_user ON shared_links(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

INSERT INTO schema_migrations (version, applied_at) VALUES ('019', NOW())
  ON CONFLICT (version) DO NOTHING;

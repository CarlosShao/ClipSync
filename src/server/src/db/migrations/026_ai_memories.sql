-- 026: AI 长程记忆（用户偏好 / 项目事实 / 反馈等跨会话记忆）
-- 用途：让定制化 AI（ClipSync 资深工程师）在每次对话开始时都能读取用户的长期记忆，
--       实现“记忆管理”：用户可手动增删改，AI 也可在 agent 模式下主动保存耐久事实。

CREATE TABLE IF NOT EXISTS ai_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category VARCHAR(40) NOT NULL DEFAULT 'fact',  -- preference | fact | project | feedback | other
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_memories_user_updated
  ON ai_memories (user_id, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES ('026')
  ON CONFLICT (version) DO NOTHING;

-- =============================================
-- AI 对话与会话历史表
-- 支持右侧 AI 面板的新对话、历史列表、消息持久化
-- =============================================

CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  provider_id UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  model TEXT,
  mode TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'agent')),
  thinking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_updated
  ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT,
  tool_calls JSONB DEFAULT '[]',
  tool_results JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
  ON ai_messages(conversation_id, created_at ASC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('025', NOW())
ON CONFLICT (version) DO NOTHING;

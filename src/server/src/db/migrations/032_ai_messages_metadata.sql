-- Migration 032: ai_messages 增 metadata JSONB 列，用于承载上下文自动压缩摘要标记
-- 用 is_context_summary=true 标记由 runChatLoop 自动写入的"前面历史摘要"
-- saveMessages 路径保留这些行（前端全量替换 messages 时不删除），
-- 而前端 UI 通过 metadata 过滤隐藏这些消息，对应"无感延续记忆"。
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- 索引最近一次摘要便于后端快速读取
CREATE INDEX IF NOT EXISTS idx_ai_messages_context_summary
  ON ai_messages (conversation_id, created_at DESC)
  WHERE metadata->>'is_context_summary' = 'true';

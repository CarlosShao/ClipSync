-- Migration 030: Persist AI conversation token usage (#226+)
-- Adds token/caching/thinking columns to ai_conversations so historical conversations
-- retain their last known context usage.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'prompt_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN prompt_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'completion_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN completion_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'total_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN total_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'cache_read_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'cache_write_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'cache_hit_rate') THEN
    ALTER TABLE ai_conversations ADD COLUMN cache_hit_rate NUMERIC(5,2) DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'thinking_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN thinking_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'reply_tokens') THEN
    ALTER TABLE ai_conversations ADD COLUMN reply_tokens INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_conversations' AND column_name = 'context_window') THEN
    ALTER TABLE ai_conversations ADD COLUMN context_window INTEGER DEFAULT 0;
  END IF;
END $$;

-- 035: 长程记忆开关持久化（memory_enabled）
-- 说明：原 030 版本号与 030_ai_conversation_usage.sql 冲突会被跳过，故改用 035。
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT FALSE;
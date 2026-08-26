-- =============================================
-- 039: AI 供应商协议格式（api_format）
-- 范围：ai_providers 新增 api_format 列，标记自定义供应商使用的兼容格式：
--       openai（OpenAI 兼容）/ anthropic（Anthropic 兼容）/ responses（OpenAI Responses）。
--       非 custom 供应商固定走预设内置协议族，不受此列影响；历史 custom 走默认 openai。
-- 幂等：列用 IF NOT EXISTS；迁移版本登记用 ON CONFLICT DO NOTHING。
-- =============================================

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS api_format VARCHAR(20) NOT NULL DEFAULT 'openai';

-- 迁移登记
INSERT INTO schema_migrations (version, applied_at) VALUES ('039', NOW())
  ON CONFLICT (version) DO NOTHING;
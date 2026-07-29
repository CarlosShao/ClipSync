-- =============================================
-- 027: AI 设置持久化 + 供应商多模型支持
-- 1) ai_providers 增加 models jsonb（可选模型列表，由上游 /v1/models 刷新得到）
-- 2) 新建 ai_settings 表（每用户一行，存默认供应商/模型/模式/思考/并行等偏好）
-- =============================================

-- 1. ai_providers.models：该配置下可用的模型列表（标签来源）
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS models JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. ai_settings：用户级 AI 偏好（入库持久化，替代 localStorage）
CREATE TABLE IF NOT EXISTS ai_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_provider_id  UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  default_model        TEXT,                                   -- 默认选中的模型标识
  selected_models      JSONB NOT NULL DEFAULT '{}'::jsonb,     -- { providerId: modelId } 每供应商当前选中模型快照
  default_mode         TEXT NOT NULL DEFAULT 'ask' CHECK (default_mode IN ('ask', 'agent')),
  thinking_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  thinking_strength    TEXT NOT NULL DEFAULT 'medium' CHECK (thinking_strength IN ('low', 'medium', 'high')),
  parallel_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_settings_user ON ai_settings(user_id);

INSERT INTO schema_migrations (version, applied_at) VALUES ('027', NOW())
  ON CONFLICT (version) DO NOTHING;

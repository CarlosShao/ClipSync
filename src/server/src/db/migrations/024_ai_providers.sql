-- 024: AI 供应商配置表（BYOK 多模型）
-- 用途：支撑「AI Agent 侧边栏」的 BYOK（Bring Your Own Key）能力。
--       用户在此配置多个供应商（OpenAI / Anthropic / DeepSeek / Qwen / Hunyuan / 自定义），
--       每个供应商保存 api_key（加密落库）、base_url、model；聊天请求由后端代理，
--       api_key 明文只在内存中解密使用，绝不以任何接口返回明文。
--       所有记录按 user_id 隔离。

CREATE TABLE IF NOT EXISTS ai_providers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,                       -- openai / anthropic / deepseek / qwen / hunyuan / custom
  name                TEXT NOT NULL,                       -- 用户自定义的显示名称
  api_key_encrypted   TEXT,                                -- AES-256-GCM 密文（iv:authTag:ciphertext），明文不落库
  base_url            TEXT,                                -- OpenAI 兼容接口的 base URL，可空（用预设默认值）
  model               TEXT NOT NULL,                       -- 模型标识，如 gpt-4o / claude-3-5-sonnet
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,      -- 每个用户仅一个默认供应商
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user_default ON ai_providers(user_id, is_default);

-- 保证同一用户只有一个默认供应商：通过部分唯一索引实现
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_providers_user_default
  ON ai_providers(user_id) WHERE is_default = TRUE;

INSERT INTO schema_migrations (version, applied_at) VALUES ('024', NOW())
  ON CONFLICT (version) DO NOTHING;

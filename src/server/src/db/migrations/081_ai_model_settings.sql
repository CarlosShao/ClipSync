-- =============================================
-- 081: 按模型配置（ai_model_settings）
--
-- 背景（用户需求）：AI 供应商配置里的「模型」此前只有一个名字 + provider 级 context_window，
--   而模型的上下文窗口 / 最大输出 / 多模态能力（识图·文本·视频·音频）各不相同，必须**按模型**配置；
--   内置预设只作为"刷新出来的模型的默认参数"，**配置入口必须暴露**给用户改。
--
-- 与「思考强度」的关系（本次一并修好的半假功能）：
--   src/utils/aiProviders.js 里 thinking 只在 Anthropic 协议分支下发（body.thinking /
--   body.output_config），而调用方（routes/aiChatCore.js、routes/aiOrchestrator.js）又用
--   `family === 'anthropic'` 才计算 thinkingBudget ⇒ 对 OpenAI 兼容族（LongCat / 阶跃 /
--   MiMo / Agnes / 通义 等）思考强度**从未下发**。本表给每个模型声明
--   reasoning_protocol（该模型真正支持的推理参数形态）+ reasoning_levels（low/medium/high
--   → 该协议取值），调用方按它决定下发哪个字段 ⇒ 思考强度真正作用到模型推理等级。
--
-- 语义约定（与 utils/modelPresets.js、utils/aiModelSettings.js 严格一致）：
--   · context_window / max_output 为 NULL ⇒ 回退到内置预设（modelPresets.js）再回退到
--     aiProviders.js 内置 MODEL_CONTEXT_WINDOWS；非 NULL ⇒ 用户显式值，最高优先级。
--   · reasoning_protocol = 'inherit' ⇒ 完全沿用既有行为（OpenAI 兼容族=不下发，Anthropic 族=
--     沿用原 thinking / output_config 逻辑）。这是**安全底线**：不支持的协议绝不塞未知字段（会 400）。
--   · reasoning_levels 形如 {"low":"low","medium":"medium","high":"high"}（openai_reasoning_effort）、
--     或 {"low":1024,"medium":4096,"high":8192}（anthropic_thinking 的 budget_tokens /
--     qwen_enable_thinking 的 thinking_budget）。
--   · 写入策略（路由层）：PUT 时把「预设 ← 已有覆盖 ← patch」的**完整生效值**整体落库，
--     避免只写单列时其余 NOT NULL 列吃到 DEFAULT（例如只为改 context_window 建行，
--     却把 reasoning_enabled 静默变 FALSE，导致 claude 系思考强度被杀）。
--
-- 依赖：users（001）、ai_providers（024）。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT DO NOTHING，可重复执行。
-- =============================================

CREATE TABLE IF NOT EXISTS ai_model_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  -- NULL = 用预设/内置值（modelPresets.js → aiProviders.MODEL_CONTEXT_WINDOWS）
  context_window INTEGER,
  -- NULL = 用预设/内置值（未知一律留 NULL，不编造精确数字）
  max_output INTEGER,
  -- 多模态能力按模态分开配置（文本是基线；识图 / 视频 / 音频各自独立）
  supports_text BOOLEAN NOT NULL DEFAULT TRUE,
  supports_image BOOLEAN NOT NULL DEFAULT FALSE,
  supports_video BOOLEAN NOT NULL DEFAULT FALSE,
  supports_audio BOOLEAN NOT NULL DEFAULT FALSE,
  -- 该模型是否启用推理/思考参数（与用户全局 thinking 开关是 AND 关系）
  reasoning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- inherit | none | openai_reasoning_effort | anthropic_thinking | output_config_effort | qwen_enable_thinking
  -- （白名单同样硬编码在 utils/modelPresets.js REASONING_PROTOCOLS，路由层先校验再落库）
  reasoning_protocol TEXT NOT NULL DEFAULT 'inherit',
  -- {"low":…,"medium":…,"high":…} 映射到该协议取值
  reasoning_levels JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider_id, model)
);

-- 主查询路径：某用户某供应商的按模型配置（GET /api/ai/model-settings）
CREATE INDEX IF NOT EXISTS idx_ai_model_settings_user_provider
    ON ai_model_settings (user_id, provider_id);

-- 级联删除（供应商删除后配置一并清掉）走 provider_id
CREATE INDEX IF NOT EXISTS idx_ai_model_settings_provider_id
    ON ai_model_settings (provider_id);

INSERT INTO schema_migrations (version, applied_at) VALUES ('081', NOW())
  ON CONFLICT (version) DO NOTHING;

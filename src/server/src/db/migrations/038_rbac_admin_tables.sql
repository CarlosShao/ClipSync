-- =============================================
-- 038: 后台管理配置表（system_configs / feature_flags）
-- 范围：新增两张管理面配置表并植入默认种子数据。
--       system_configs：键值对 (config_key -> JSONB value)，
--          分类字段 category 便于按域分组，updated_by 记录修改人。
--       feature_flags：布尔功能开关，供前端/后端按 feature 做灰度/启停。
-- 明确不做：不建 subscriptions、不改 audit_logs、不给 collections 加 parent_id；
--          收藏层级已由 favorite_collections 的 ltree path 支持。
-- 幂等：建表全部 IF NOT EXISTS；种子全部 ON CONFLICT DO NOTHING。
-- =============================================

-- ---- system_configs ----
CREATE TABLE IF NOT EXISTS system_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key VARCHAR(100) UNIQUE NOT NULL,
  config_value JSONB NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'general',
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- feature_flags ----
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key VARCHAR(100) UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT FALSE,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- system_configs 种子数据 ----
INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('ai_max_tokens',             '4096'::jsonb,        'AI 单次生成的最大 token 数',        'ai'),
  ('ai_default_provider',       '"openrouter"'::jsonb, 'AI 默认供应商（默认值语义）',        'ai'),
  ('max_collection_depth',      '5'::jsonb,           '收藏层级最大深度',                  'collection'),
  ('enable_audit_log',          'true'::jsonb,        '是否启用审计日志',                  'security'),
  ('session_timeout_minutes',   '30'::jsonb,          '会话空闲超时（分钟）',              'session')
ON CONFLICT (config_key) DO NOTHING;

-- ---- feature_flags 种子数据 ----
INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('enable_ai_agent',        TRUE,  '启用 AI Agent 侧边栏能力'),
  ('enable_subscription',    TRUE,  '启用订阅功能'),
  ('enable_public_sharing',  TRUE,  '启用公开分享'),
  ('enable_2fa',             TRUE,  '启用两步验证')
ON CONFLICT (flag_key) DO NOTHING;

-- 迁移登记
INSERT INTO schema_migrations (version, applied_at) VALUES ('038', NOW())
  ON CONFLICT (version) DO NOTHING;
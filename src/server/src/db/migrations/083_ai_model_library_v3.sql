-- =============================================
-- 083: 模型库契约 v3 —— ai_model_settings 增列（停用 / 别名 / 排序）
--
-- 背景（用户需求：模型库要能停用、起别名、排序）：
--   · enabled      逻辑删：false = 用户停用该模型，**配置保留可恢复**（不删行 = 不丢自定义值）。
--                  它是「聊天模型选择器」的数据源联动开关：PUT 里 enabled=true 会把模型加入
--                  ai_settings.selected_models[providerId]，false 则移除（同一事务，见
--                  routes/aiModelSettings.js）。因为刷新只写 ai_providers.models（模型名清单），
--                  永远不写 ai_model_settings ⇒ 刷新既不会冲掉配置，也不会复活被停用的模型。
--   · alias        用户给模型起的显示别名（UI 展示用；不影响上游请求的 model 字段）。
--   · sort_order   用户自定义排序（小的在前；NULL = 未排序，排在最后，再按模型名字典序）。
--
-- 与既有列的关系：
--   · 081 建表时的列全部保持不变（reasoning_levels 亦保留，见 082 注释）。
--   · 新增列都带默认值/可空 ⇒ 存量行立即满足新契约：enabled=TRUE（默认启用）、
--     alias=NULL、sort_order=NULL（排在列表最后）。
--
-- 依赖：ai_model_settings（081）。
-- 幂等：ADD COLUMN IF NOT EXISTS + ON CONFLICT DO NOTHING，可重复执行。
-- =============================================

-- 逻辑删开关：FALSE = 用户停用（配置保留，可随时恢复）
ALTER TABLE ai_model_settings ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 显示别名（NULL = 未设置，UI 退回显示模型名）
ALTER TABLE ai_model_settings ADD COLUMN IF NOT EXISTS alias TEXT;

-- 用户排序（小的在前；NULL 最后）
ALTER TABLE ai_model_settings ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- 列表查询按「排序值 + 模型名」出结果（GET /api/ai/model-settings 的默认序）
CREATE INDEX IF NOT EXISTS idx_ai_model_settings_provider_sort
    ON ai_model_settings (user_id, provider_id, sort_order);

INSERT INTO schema_migrations (version, applied_at) VALUES ('083', NOW())
  ON CONFLICT (version) DO NOTHING;

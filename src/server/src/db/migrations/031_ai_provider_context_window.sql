-- 为 ai_providers 增加 context_window 列，供用户为自定义/未知模型指定真实上下文窗口（token 数）。
-- 非空时优先级高于内置 MODEL_CONTEXT_WINDOWS 表，确保「上下文用量百分比」按真实模型计算。
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS context_window INTEGER;

-- =============================================
-- 070: 用户级联网搜索配置
-- 范围：ai_settings 新增搜索源三列，用户在桌面端 AI 设置中配置
--       联网搜索源 + Key + 自建源地址（SearXNG 用）。
--       key 加密存储（search_api_key_encrypted），GET 永不回传明文。
-- 幂等：列用 IF NOT EXISTS；迁移版本登记用 ON CONFLICT DO NOTHING。
-- 消费方：src/server/src/routes/aiTools.js（web_search 执行，优先级最高级）
-- =============================================

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS search_provider TEXT DEFAULT NULL;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS search_api_key_encrypted TEXT DEFAULT NULL;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS search_base_url TEXT DEFAULT NULL;

INSERT INTO schema_migrations (version, applied_at) VALUES ('070', NOW())
  ON CONFLICT (version) DO NOTHING;

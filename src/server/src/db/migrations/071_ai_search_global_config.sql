-- =============================================
-- 071: 管理台全局联网搜索配置键
-- 范围：system_configs 种入 ai_search_* 三键，作为用户未配置搜索源时
--       的全局兜底（web_search 执行优先级第二级）。
--       api_key 为空 = 未配置，未配且用户也未配时走 AnySearch 匿名额度。
-- 幂等：ON CONFLICT DO NOTHING；迁移版本登记同上。
-- 消费方：src/server/src/routes/aiTools.js（web_search 执行）；
--         src/server/src/routes/admin/configs.js（CONFIG_CATALOG 展示目录）；
--         src/admin-console/src/pages/ai（AI 配置页）+ settings（设置页 AI 分组）。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('ai_search_provider',              '""', '全局联网搜索源：anysearch / bocha / brave / tavily / searxng（用户未配时兜底）', 'ai'),
  ('ai_search_api_key_encrypted',     '""', '全局搜索 API Key（加密存储，SearXNG 自建源不需要）', 'ai'),
  ('ai_search_base_url',              '""', '自建 SearXNG 公网地址（仅 searxng 源需要，如 https://search.example.com）', 'ai')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('071', NOW())
  ON CONFLICT (version) DO NOTHING;

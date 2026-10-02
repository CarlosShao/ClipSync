-- 078_ai_settings_columns_backfill.sql
--
-- 范围：把 ai_settings 的「可选列」再担保一遍（幂等）。
--
-- 为什么要单独一条（而不是依赖 035 / 040 / 070）：
--   这些列本来分别由 035_ai_memory_enabled、040_ai_custom_system_prompt、
--   070_ai_search_user_config 添加，但 migrate.js 对「旧式数字版本记录」有一次回填
--   （见 src/db/migrate.js 中 legacy 回填段）：如果历史库里存在形如 '040' 的数字记录，
--   回填会把 040_*.sql 判定为「已执行」——**即使它当时并没有真正跑过**。
--   结果就是库结构漂移：表里没有 custom_system_prompt / memory_enabled 等列。
--
-- 后果（已用运行时证据复现，见 tests/ai-settings-persistence.test.js）：
--   PUT /api/ai/settings 的 baseCols 对 memory_enabled / custom_system_prompt /
--   parallel_enabled 是**无条件写**（搜索三列反而做了存在性探测），
--   因此缺任一列 ⇒ 整条保存 42703 undefined_column ⇒ 500
--   ⇒ **所有 AI 设置（默认模式、思考、记忆、系统提示词、搜索源）一起存不进去**，
--      前端表现为"一刷新又回到没配置的样子"。
--
-- 本迁移是新版本号，因此在任何漂移库上都会真正执行一次；全部 ADD COLUMN IF NOT EXISTS，
-- 对结构正常的库是 no-op（幂等、可重复执行）。
-- 待后续把回填逻辑修好（或清理历史数字记录）后，本文件可保留作为兜底，不必删除。

ALTER TABLE ai_settings
    ADD COLUMN IF NOT EXISTS memory_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS custom_system_prompt  TEXT    DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS parallel_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS search_provider       TEXT    DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS search_api_key_encrypted TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS search_base_url       TEXT    DEFAULT NULL;

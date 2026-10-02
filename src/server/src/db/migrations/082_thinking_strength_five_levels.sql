-- =============================================
-- 082: 思考强度枚举扩到 5 档（low | medium | high | xhigh | max）
--
-- 背景（用户需求原文）：「你要起码得有这么多等级，也不用翻译成低中高了，直接英文就行，
--   不用管映射，所以你再修改下，把思考强度映射那个配置去掉吧」
--   参考等级：Default / Off / Low / Medium / High / Xhigh / Max
--   （Default / Off 由「用户思考开关 + 该模型 reasoning_protocol」表达，不是额外枚举值）
--
-- 契约 v2（与 utils/modelPresets.js / routes/aiSettings.js / routes/aiModelSettings.js 一致）：
--   1) ai_settings.thinking_strength 放宽到 5 档：low | medium | high | xhigh | max（默认仍 medium）。
--      027 建表时的内联 CHECK 自动命名为 ai_settings_thinking_strength_check，
--      这里先 DROP IF EXISTS 再 ADD CONSTRAINT —— 成对执行即幂等，可重复跑整个文件。
--   2) 等级**原样透传**：reasoning_effort / output_config.effort 直接用等级字面值，
--      不再从 ai_model_settings.reasoning_levels（081 引入的「等级映射表」）里查表。
--      该列**不再对外暴露、不再被读取**；列本身保留（不删列，避免破坏性迁移），
--      仅作历史遗留 —— 已废弃原因见 utils/modelPresets.js 头部注释。
--   3) Anthropic 的 budget_tokens 仍必须是数字 ⇒ 代码内部把 5 档换算成预算
--      （1024 / 4096 / 8192 / 16384 / 32768，见 utils/modelPresets.js
--      ANTHROPIC_BUDGET_TOKENS）。这是**内部换算**，不是用户可配的映射。
--
-- 兼容性：老客户端只发 low|medium|high → 继续合法；xhigh|max 对不支持的上游由各协议的
--   「不支持就不发」底线兜住（inherit / none / reasoning_enabled=false 一个字都不下发）。
--
-- 依赖：ai_settings（027）。
-- 幂等：DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT + ON CONFLICT DO NOTHING，可重复执行。
-- =============================================

ALTER TABLE ai_settings
    DROP CONSTRAINT IF EXISTS ai_settings_thinking_strength_check;

ALTER TABLE ai_settings
    ADD CONSTRAINT ai_settings_thinking_strength_check
    CHECK (thinking_strength IN ('low', 'medium', 'high', 'xhigh', 'max'));

INSERT INTO schema_migrations (version, applied_at) VALUES ('082', NOW())
  ON CONFLICT (version) DO NOTHING;

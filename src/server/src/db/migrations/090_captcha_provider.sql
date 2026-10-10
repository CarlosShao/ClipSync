-- =============================================
-- 090: 人机验证 provider 抽象（把 turnstile_enabled 合并进 captcha_provider，消除重复配置）
--
-- 背景（owner 2026-10-09）：
--   1) 现有实现把"总开关"写成 turnstile_enabled ⇒ 一旦支持多家（Turnstile / 自建），
--      界面上就会出现"人机验证开关"+"Turnstile 开关"两个开关 = **重复配置**（owner 明确反对）。
--   2) owner 要求做**可切换 provider**，且优先**免费方案**：阿里云/极验按次计费不用 ⇒ 自建滑块。
--
-- 因此引入**唯一**的开关 + provider 选择：`captcha_provider`
--   'off'       关闭（默认；行为与今天完全一致）
--   'turnstile' Cloudflare Turnstile（海外用户友好；已有的 site/secret 键保留不动）
--   'self'      自建滑块（服务端出题 + 一次性 token；0 成本、国内可达、无需第三方凭据）
--
-- 迁移动作：
--   ① 种入 captcha_provider，默认 'off'
--   ② 若历史 turnstile_enabled 为 true ⇒ 把值搬成 'turnstile'（不丢用户既有选择）
--   ③ **删除 turnstile_enabled**（键与值一并删除）——它已并入 captcha_provider，
--      留着会在管理台「其它」兜底卡里冒出来，正是"重复配置项"。删前已确保值被搬走。
--   ④ 从配置目录（src/routes/admin/configs.js 的 CONFIG_CATALOG）中同步移除该键（代码侧）
--
-- 幂等：INSERT ... ON CONFLICT / UPDATE 条件化 / DELETE 精确键；可重复执行。
-- 消费方：src/server/src/utils/captcha.js（getCaptchaConfig / verifyCaptcha / captchaGate）
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category)
VALUES
  ('captcha_provider', '"off"', '人机验证方式：off 关闭 / turnstile Cloudflare / self 自建滑块（免费、国内可达）。这是唯一的总开关', 'security')
ON CONFLICT (config_key) DO NOTHING;

-- ② 保留历史选择：曾开启 Turnstile 的库，迁移后仍是 turnstile（且键值齐全才算数）
UPDATE system_configs
   SET config_value = '"turnstile"'::jsonb,
       updated_at = NOW()
 WHERE config_key = 'captcha_provider'
   AND (config_value::text = '"off"' OR config_value::text = '""')
   AND EXISTS (
     SELECT 1 FROM system_configs t
      WHERE t.config_key = 'turnstile_enabled'
        AND lower(t.config_value::text) LIKE '%true%'
   )
   AND EXISTS (
     SELECT 1 FROM system_configs s
      WHERE s.config_key = 'turnstile_site_key'
        AND length(s.config_value::text) > 4
   );

-- ③ 删掉已并入的旧开关（避免在「其它」卡里冒出来形成重复项）
DELETE FROM system_configs WHERE config_key = 'turnstile_enabled';

INSERT INTO schema_migrations (version, applied_at) VALUES ('090', NOW())
  ON CONFLICT (version) DO NOTHING;

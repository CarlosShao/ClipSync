-- =============================================
-- 067: 发布产物下载地址配置（GH-01，Tauri 更新签名链路打通）
-- 编号说明：061~066 已被并发工单占用（AN-03/04/06/08/12/15），本单取 067。
--
-- 背景：
--   routes/app.js 的 GET /api/app/update.json 在「该平台无产物」分支曾硬编码回退
--   `https://example.com/downloads/...`——一个虚构域名。客户端拿到它真去请求，
--   表现为下载 404/超时，而非「服务器没配下载地址」，运维侧完全看不出根因。
--
-- 本次落地：
--   1) 新增配置键 release_download_base_url：下载地址的部署级来源。
--      解析优先级（见 src/server/src/utils/releaseArtifacts.js）：
--        app_releases.platforms[target].url  （发布单显式地址，逐版本覆盖）
--        > RELEASE_DOWNLOAD_BASE_URL 环境变量（部署级覆盖）
--        > system_configs.release_download_base_url（本键，管理台可改）
--        > 都没有 → 端点返回 410 + unconfigured（绝不伪造占位链接）
--   2) 托管方案：GitHub Releases（仓库 CarlosShao/ClipSync）。
--      本键可填裸仓库地址 https://github.com/CarlosShao/ClipSync 或 CDN 前缀，
--      前者按 releaseArtifacts.buildArtifactUrl 自动拼成
--      https://github.com/<owner>/<repo>/releases/download/v<version>/<filename>
--
-- 默认值为空串（未配置）：升级零行为变化——未配置时端点明确报未配置，
-- 而不是继续伪装成有下载地址。运维在管理台「系统设置」填入后 ≤60s 生效。
--
-- 幂等：ON CONFLICT DO NOTHING；可重复执行。
-- 依赖：038(system_configs)。
-- =============================================

INSERT INTO system_configs (config_key, config_value, description, category) VALUES
  ('release_download_base_url', '""'::jsonb,
   '发布产物下载地址来源（GitHub Releases 仓库地址如 https://github.com/CarlosShao/ClipSync，或自建 CDN 前缀）；为空时更新端点返回「下载地址未配置」',
   'operations')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at) VALUES ('067', NOW())
ON CONFLICT (version) DO NOTHING;

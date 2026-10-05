/**
 * ClipSync 域名单一事实源（Single Source of Truth）
 * ================================================
 *
 * 根域名决策记录见 docs/audit/filing-guide-2026-09-09.md §4。
 *
 * 本文件是所有「域名相关」字面量的唯一权威来源。
 * 凡是可以 import 的地方（Node 服务端、admin-console、website），
 * 一律从本文件派生，不要硬编码域名。
 *
 * ⚠️ 无法 import 的地方（k8s YAML、nginx conf、HTML 静态页、CI workflow、
 *    文档），保持字面量，但必须在注释里标明「与 src/shared/domains.ts 保持一致」。
 *
 * 本文件刻意使用「零依赖的 ESM .js」而不是 .ts：
 *   - src/server 是 ESM（package.json "type": "module"），可直接 import
 *   - 前端（vite/tsc）可通过 allowJs 或在 .ts 中 import
 *   - 不需要任何构建步骤，避免跨包依赖地狱
 */

/** 根域名 */
export const ROOT_DOMAIN = 'clipchain.top';

/** 各子域（不含协议） */
export const DOMAINS = Object.freeze({
  /** 后端 API（含支付回调） */
  api: `api.${ROOT_DOMAIN}`,
  /** WebSocket */
  ws: `ws.${ROOT_DOMAIN}`,
  /** Tauri 更新端点 */
  updates: `updates.${ROOT_DOMAIN}`,
  /** 官网 */
  www: `www.${ROOT_DOMAIN}`,
  /** 管理台 */
  admin: `admin.${ROOT_DOMAIN}`,
  /** 裸根域名（无子域） */
  root: ROOT_DOMAIN,
});

/** 带 https 协议的完整源站 URL */
export const ORIGINS = Object.freeze({
  api: `https://${DOMAINS.api}`,
  ws: `https://${DOMAINS.ws}`,
  updates: `https://${DOMAINS.updates}`,
  www: `https://${DOMAINS.www}`,
  admin: `https://${DOMAINS.admin}`,
  root: `https://${DOMAINS.root}`,
});

/** 客服/法务邮箱本地部分 */
export const EMAIL_LOCAL_PARTS = Object.freeze({
  support: 'support',
  privacy: 'privacy',
  dpo: 'dpo',
  noreply: 'noreply',
});

/**
 * 按本地部分构造邮箱地址。
 * @param {keyof typeof EMAIL_LOCAL_PARTS} localPart
 * @returns {string} 例如 support@clipchain.top
 */
export function email(localPart) {
  return `${localPart}@${ROOT_DOMAIN}`;
}

/** 常用邮箱地址（预构造，便于引用） */
export const EMAILS = Object.freeze({
  support: email(EMAIL_LOCAL_PARTS.support),
  privacy: email(EMAIL_LOCAL_PARTS.privacy),
  dpo: email(EMAIL_LOCAL_PARTS.dpo),
  noreply: email(EMAIL_LOCAL_PARTS.noreply),
});

/**
 * 服务端法务页面路径（由 src/server/src/index.js 的 express.static 暴露）。
 *
 * 事实依据：index.js 第 235 行
 *   app.use(express.static(path.join(__dirname, '../../views')));
 * → views/ 目录挂在站点根，因此文件 terms-of-service.html 的公开路径为
 *   /terms-of-service.html
 *
 * 注意：src/server/public/*.html（privacy-policy.html / dpa.html /
 * cookie-policy.html / tos.html）目前【没有】任何路由或 express.static
 * 挂载，因此在服务端是 404 的。对外可见的法务页只有 views/ 下的两个。
 */
export const LEGAL_PATHS = Object.freeze({
  termsOfService: '/terms-of-service.html',
  privacyPolicy: '/privacy-policy.html',
});

/** 法务页完整 URL（挂在 API 源站上） */
export const LEGAL_URLS = Object.freeze({
  termsOfService: `${ORIGINS.api}${LEGAL_PATHS.termsOfService}`,
  privacyPolicy: `${ORIGINS.api}${LEGAL_PATHS.privacyPolicy}`,
});

/**
 * Tauri 更新端点（desktop 端 tauri.conf.json 使用）。
 * 与 src/desktop/src-tauri/tauri.conf.json 的 updater.endpoints 保持一致。
 */
export const UPDATE_ENDPOINT_TEMPLATE =
  `${ORIGINS.updates}/api/app/updates/latest?target={{target}}&current_version={{current_version}}`;

/**
 * ⚠️ **本常量服务端不读，改它不会改变任何线上行为。**
 *
 * 服务端 CORS 白名单来自环境变量 `CORS_ORIGINS`（`docker-compose.prod.yml` 透传 →
 * `src/server/src/config.js` → `src/server/src/index.js` 的 `cors({ origin })`）。
 * `ALLOWED_ORIGINS` 是同义的历史遗留名，**全仓零消费方**，只在 k8s configmap 里出现
 * 同名键（而 k8s 这条路已废弃）。
 *
 * 这个坑已经咬过两次，故把口径写死在这里：
 *   · 2026-09-19：运维按「白名单」配了 `ALLOWED_ORIGINS` 而没配 `CORS_ORIGINS`
 *     → `allowedOrigins` 成空数组 → **所有带 Origin 的跨域请求一律 403**，Web 端全不可用
 *     （见 docs/audit/v1-full-audit-2026-09-22/06-server-datalayer-api-design.md:936,945）。
 *   · 2026-10-04：另一个 agent 看到本数组缺 Tauri origin，误判为「发版阻断」——
 *     而生产 `CORS_ORIGINS` 本来就含 `http://tauri.localhost` 与 `http://localhost:1420`。
 *
 * 真值以**生产 `.env.production` 的 `CORS_ORIGINS`** 为准（含桌面端两个 origin）。
 * 这里保留 Web 三域 + 桌面端 origin 只是为了与 k8s configmap 的历史值对齐、便于人工比对。
 */
export const ALLOWED_ORIGINS = Object.freeze([
  ORIGINS.www,
  ORIGINS.admin,
  ORIGINS.root,
  // 桌面端（Tauri）origin：Windows 打包后是 http://tauri.localhost，dev 是 http://localhost:1420。
  // 生产 CORS_ORIGINS 已包含这两项；此处列出以免再被误读成"漏了"。
  'http://tauri.localhost',
  'http://localhost:1420',
]);

export default {
  ROOT_DOMAIN,
  DOMAINS,
  ORIGINS,
  EMAILS,
  EMAIL_LOCAL_PARTS,
  email,
  LEGAL_PATHS,
  LEGAL_URLS,
  UPDATE_ENDPOINT_TEMPLATE,
  ALLOWED_ORIGINS,
};

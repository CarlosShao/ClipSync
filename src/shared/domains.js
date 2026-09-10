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

/** CORS 白名单（生产）。对应 k8s configmap 的 ALLOWED_ORIGINS。 */
export const ALLOWED_ORIGINS = Object.freeze([
  ORIGINS.www,
  ORIGINS.admin,
  ORIGINS.root,
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

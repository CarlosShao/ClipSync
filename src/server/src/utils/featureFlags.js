import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 功能开关读取层（feature_flags 表）——客户端行为强制生效的唯一事实来源。
 *
 * 生效链路与优先级（对设置页说明文案同样适用）：
 *   1. 管理台 PATCH /api/admin/flags/:key 写库（持久化）→ 本进程缓存失效 + WS 全端广播
 *      `feature_flags.updated`；
 *   2. 服务端各端点经 isFlagEnabled/requireFlag 强制拦截（~5s 内全进程生效，跨进程靠短 TTL）；
 *   3. 客户端可 GET /api/app/feature-flags 主动拉取，或接收 WS 推送即时感知；
 *      未适配的客户端在下次请求时被服务端 403 拒绝（兜底）。
 *
 * 缓存策略：进程内 5s TTL。读库失败时按 fallback 放行并告警——开关系统故障不阻塞主业务。
 */

const FLAG_TTL_MS = 5000;
let cache = { map: null, at: 0 };

/** 返回 `{ [flagKey]: enabled }` 全量快照（带 5s 进程内缓存） */
export async function getFeatureFlags() {
  const now = Date.now();
  if (cache.map && now - cache.at < FLAG_TTL_MS) return cache.map;
  const { rows } = await pool.query('SELECT flag_key, enabled FROM feature_flags');
  const map = Object.fromEntries(rows.map((r) => [r.flag_key, Boolean(r.enabled)]));
  cache = { map, at: now };
  return map;
}

/** 管理台写库后调用：立刻失效本进程缓存，下次读取直连库 */
export function invalidateFlagsCache() {
  cache = { map: null, at: 0 };
}

/**
 * 读取单个开关。缺表/查库失败时返回 fallback（默认 true=放行）：
 * 开关基础设施故障不应导致全体用户功能不可用。
 */
export async function isFlagEnabled(key, fallback = true) {
  try {
    const flags = await getFeatureFlags();
    return flags[key] ?? fallback;
  } catch (err) {
    logger.warn('[featureFlags] read failed, fallback enabled', { key, error: err.message });
    return fallback;
  }
}

/**
 * 端点守卫中间件工厂：开关关闭时返回 403 JSON（带 flagDisabled 标识，客户端可据此提示）。
 * @param {string} key feature_flags.flag_key
 * @param {string} message 关闭时的用户可见提示
 */
export function requireFlag(key, message) {
  return async (req, res, next) => {
    if (await isFlagEnabled(key)) return next();
    res.status(403).json({ error: message, flagDisabled: key });
  };
}

// ───────────────────────── AN-10：强制点清单 ─────────────────────────
// 静态清单：登记每个 feature_flags 键在服务端的真实强制点（requireFlag / isFlagEnabled 调用），
// GET /api/admin/flags 据此返回 enforced 字段（「DB 值 / 进程缓存值 / 是否强制」自检口径，
// 防 AF-04「UI 有开关、后端无强制点」复发）。
//
// ⚠️ 维护方式（手动 grep，新增/删除开关时必须同步本清单）：
//   grep -rn "requireFlag(\|isFlagEnabled(" src/server/src
// 查到调用点 → 键入列；查无调用点 → 不得入列（flags 接口会如实返回 enforced:false 告警）。
// 当前登记（2026-09-09 逐点查证）：
//   enable_subscription → subscriptionCheck.js:53 / planFeature.js:79
//   enable_ai_agent     → index.js:449（aiFlagGuard，AI 四挂载点统一强制）
//   enable_public_sharing → sharedLinks.js:156,182
//   enable_2fa          → two-factor.js:54,71
//   signup_waitlist     → auth.js:360,589,943 / auth-verify.js:165,263
//   enable_signup       → auth.js:330,559,862 / auth-verify.js:158,256
export const ENFORCED_FLAG_KEYS = [
  'enable_subscription',
  'enable_ai_agent',
  'enable_public_sharing',
  'enable_2fa',
  'signup_waitlist',
  'enable_signup',
];

/** 该开关是否登记了服务端强制点（清单外键一律 false） */
export function isFlagEnforced(key) {
  return ENFORCED_FLAG_KEYS.includes(key);
}

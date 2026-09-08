import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 运行时限流阈值读取层（system_configs 表，迁移 050）—— 限流配置化的唯一事实来源。
 *
 * ⚠️ 与 featureFlags.js 的容错方向相反（fail-closed vs fail-open），不可共用/照搬：
 *   - featureFlags 读库失败时 fallback=true 放行——开关系统故障不应阻塞主业务（可用性优先）；
 *   - 本模块读库失败/键缺失时回退【硬编码保守默认值】，且 disabled 恒为 false——
 *     限流配置系统一旦故障就变成"不限流"，等于把限流总闸交给故障路径（安全优先，fail-closed）。
 *
 * 消费方：middleware/rateLimiter.js（每次限流检查取当前值，无需重建 limiter）。
 * 配置键（CONFIG_CATALOG 见 routes/admin/configs.js，管理台「限流配置」卡片）：
 *   rate_limit_api_per_min / rate_limit_send_code_per_hour /
 *   rate_limit_login_failed_per_15min / rate_limit_upload_per_min / rate_limit_disabled
 */

const LIMITS_TTL_MS = 5000;

/** 硬编码默认值（= 迁移 050 种子值 = 改配置化前的字面量阈值），读库失败/键缺失时的回退目标 */
export const DEFAULT_LIMITS = Object.freeze({
  apiPerMin: 300,
  sendCodePerHour: 5,
  loginFailedPer15Min: 5,
  uploadPerMin: 20,
  disabled: false,
});

const LIMIT_CONFIG_KEYS = [
  'rate_limit_api_per_min',
  'rate_limit_send_code_per_hour',
  'rate_limit_login_failed_per_15min',
  'rate_limit_upload_per_min',
  'rate_limit_disabled',
];

let cache = { limits: null, at: 0 };

/** JSONB config_value（如 '300'::jsonb）→ 正整数；非法值回退默认（fail-closed） */
function toPositiveInt(raw, fallback) {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** disabled 只认 boolean / 'true'/'false' 字符串；其余一律按 false（保守：限流继续生效） */
function toDisabled(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

/**
 * 读取当前限流阈值快照（带 5s 进程内 TTL 缓存）。
 * 永不 throw：读库失败回退 DEFAULT_LIMITS 并 logger.warn（fail-closed，见文件头）。
 * 失败结果同样按 TTL 缓存，避免 DB 故障期间每个请求都打一次库。
 */
export async function getRuntimeLimits() {
  const now = Date.now();
  if (cache.limits && now - cache.at < LIMITS_TTL_MS) return cache.limits;

  const limits = { ...DEFAULT_LIMITS };
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [LIMIT_CONFIG_KEYS]
    );
    for (const { config_key, config_value } of rows) {
      switch (config_key) {
        case 'rate_limit_api_per_min':
          limits.apiPerMin = toPositiveInt(config_value, DEFAULT_LIMITS.apiPerMin);
          break;
        case 'rate_limit_send_code_per_hour':
          limits.sendCodePerHour = toPositiveInt(config_value, DEFAULT_LIMITS.sendCodePerHour);
          break;
        case 'rate_limit_login_failed_per_15min':
          limits.loginFailedPer15Min = toPositiveInt(config_value, DEFAULT_LIMITS.loginFailedPer15Min);
          break;
        case 'rate_limit_upload_per_min':
          limits.uploadPerMin = toPositiveInt(config_value, DEFAULT_LIMITS.uploadPerMin);
          break;
        case 'rate_limit_disabled':
          limits.disabled = toDisabled(config_value);
          break;
      }
    }
  } catch (err) {
    logger.warn('[runtimeLimits] system_configs unavailable, falling back to hardcoded defaults', {
      error: err.message,
    });
  }
  Object.freeze(limits);
  cache = { limits, at: now };
  return limits;
}

/** 管理台写库后调用：立刻失效本进程缓存，下次读取直连库（configs.js PATCH 路径） */
export function invalidateLimitsCache() {
  cache = { limits: null, at: 0 };
}

/**
 * 同步取最近一次缓存的快照（无快照时回退 DEFAULT_LIMITS）。
 * 仅供无法 await 的调用方使用（如 checkWsConnectionLimit 被 ws/server.js 同步调用）；
 * 新鲜度 ≤5s TTL，且依赖异步 getRuntimeLimits() 被常规请求持续预热。
 */
export function getCachedRuntimeLimits() {
  return cache.limits ?? DEFAULT_LIMITS;
}

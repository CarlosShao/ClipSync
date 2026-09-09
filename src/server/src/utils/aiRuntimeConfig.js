import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * AI 运行时配置读取层（system_configs 表，迁移 038 种子）—— AN-03 接线的唯一事实来源。
 *
 * 消费方：
 *   - utils/aiProviders.js buildUpstreamChat（clampMaxTokens 统一钳制 max_tokens，
 *     覆盖 chat/summarize/dedup/refactor/suggest/OCR/压缩全链路）
 *   - 本文件 resolveUserProvider（aiChat.js 各端点 providerId 缺省时的兜底路由，
 *     按 ai_default_provider 供应商族选用户已配置的供应商）
 *   - routes/admin/aiProviders.js（全局参数展示与 aiProviders.js 用户端禁用过滤联动）
 *
 * 容错方向：fail-open（与 runtimeLimits 的 fail-closed 相反）——
 * AI 配置读库失败不应阻断 AI 主链路，回退硬编码默认值（= 038 种子值）并 logger.warn。
 */

const AI_RUNTIME_TTL_MS = 5000;

/** 硬编码默认值（= 迁移 038 种子值），读库失败/键缺失时的回退目标 */
export const DEFAULT_AI_RUNTIME = Object.freeze({
  /** 单次生成 token 上限（无显式 maxTokens 的调用按 1024 兜底后再与该值取 min） */
  maxTokens: 4096,
  /** 默认供应商族（provider 预设键）；空串 = 未配置，不做兜底路由 */
  defaultProvider: '',
});

const AI_RUNTIME_KEYS = ['ai_max_tokens', 'ai_default_provider'];

let cache = { config: null, at: 0 };

/** JSONB config_value（如 '4096'::jsonb / '"openrouter"'::jsonb）→ 正整数；非法回退默认 */
function toPositiveInt(raw, fallback) {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** JSONB config_value → 供应商族字符串；仅收录预设键形态（小写字母/数字/下划线/连字符） */
function toProviderKey(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  const s = String(typeof raw === 'object' ? '' : raw).trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(s) ? s : fallback;
}

/**
 * 读取 AI 运行时配置快照（带 5s 进程内 TTL 缓存）。
 * 永不 throw：读库失败回退 DEFAULT_AI_RUNTIME（fail-open，见文件头）；
 * 失败结果同样按 TTL 缓存，避免 DB 故障期间每次 AI 调用都打一次库。
 */
export async function getAiRuntimeConfig() {
  const now = Date.now();
  if (cache.config && now - cache.at < AI_RUNTIME_TTL_MS) return cache.config;

  const config = { ...DEFAULT_AI_RUNTIME };
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [AI_RUNTIME_KEYS]
    );
    for (const { config_key, config_value } of rows) {
      if (config_key === 'ai_max_tokens') {
        config.maxTokens = toPositiveInt(config_value, DEFAULT_AI_RUNTIME.maxTokens);
      } else if (config_key === 'ai_default_provider') {
        config.defaultProvider = toProviderKey(config_value, DEFAULT_AI_RUNTIME.defaultProvider);
      }
    }
  } catch (err) {
    logger.warn('[aiRuntimeConfig] system_configs unavailable, falling back to defaults', {
      error: err.message,
    });
  }
  Object.freeze(config);
  cache = { config, at: now };
  return config;
}

/**
 * 同步取最近一次缓存快照（无快照时回退 DEFAULT_AI_RUNTIME）。
 * 仅供无法 await 的同步调用方使用（buildUpstreamChat 是纯同步函数）；
 * 新鲜度 ≤5s TTL，且依赖异步 getAiRuntimeConfig() 被 AI 请求持续预热。
 */
export function getCachedAiRuntimeConfig() {
  return cache.config ?? DEFAULT_AI_RUNTIME;
}

/** 管理台写库后调用：立刻失效本进程缓存（configs.js PATCH 路径可挂） */
export function invalidateAiRuntimeConfigCache() {
  cache = { config: null, at: 0 };
}

/**
 * 钳制单次生成的 max_tokens（AN-03：ai_max_tokens 全链路统一消费点）。
 * - requested 缺省/非法时按 fallback（1024，= 原 buildUpstreamChat 字面量）兜底；
 * - 返回 min(effective, 全局 ai_max_tokens)，保证「后台改全局上限 → AI 调用实际受限」。
 */
export function clampMaxTokens(requested, fallback = 1024) {
  const cap = getCachedAiRuntimeConfig().maxTokens;
  const n = Number(requested);
  const effective = Number.isInteger(n) && n > 0 ? n : fallback;
  return Math.min(effective, cap);
}

/**
 * 解析一次 AI 调用使用的供应商行（AN-03：ai_default_provider 兜底路由消费点）。
 * 优先级：显式 providerId（须属于该用户且未禁用）→ 用户 is_default 行 →
 * 全局 ai_default_provider 供应商族的该用户首行（按创建时间）→ null。
 * 仅返回 enabled = TRUE 的行（管理台禁用后所有 AI 路径统一不可用）。
 * @returns {Promise<object|null>} ai_providers 行或 null（调用方回 404）
 */
export async function resolveUserProvider(userId, providerId) {
  if (providerId) {
    const { rows } = await pool.query(
      'SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2 AND enabled = TRUE',
      [providerId, userId]
    );
    return rows[0] || null;
  }
  const { rows: def } = await pool.query(
    `SELECT * FROM ai_providers
     WHERE user_id = $1 AND is_default = TRUE AND enabled = TRUE
     ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  if (def[0]) return def[0];
  const config = await getAiRuntimeConfig();
  if (!config.defaultProvider) return null;
  const { rows: byFamily } = await pool.query(
    `SELECT * FROM ai_providers
     WHERE user_id = $1 AND provider = $2 AND enabled = TRUE
     ORDER BY created_at ASC LIMIT 1`,
    [userId, config.defaultProvider]
  );
  return byFamily[0] || null;
}

import pool from '../db/pool.js';
import { logger } from './logger.js';
import { decryptField } from './encryption.js';

/**
 * 人机验证（Cloudflare Turnstile）—— **运行时可配置，未启用（默认）则完全不影响任何请求**。
 *
 * 配置来源（迁移 088，与短信/邮件同口径：进 `system_configs`，管理台可填，不必重启容器）：
 *   turnstile_site_key    公开值，前端渲染 widget 用
 *   turnstile_secret_key  **加密落库**，服务端校验用
 *   turnstile_enabled     总开关，**默认 false**
 *
 * ⚠️ 为什么必须有独立开关、且默认关（这是本模块最重要的设计约束）：
 *   `POST /api/auth/send-code` 是**桌面端 / 移动端 / 管理台共用**的接口。一旦强制要求 captcha token，
 *   没挂 widget 的客户端会**立刻无法登录**。所以顺序必须是：
 *     ① 填 key（本模块的这些键，此时零影响）→ ② 各端都挂上 widget → ③ 再打开开关。
 *   默认 false ⇒ 行为与加这个模块之前完全一致。
 *
 * 语义细节：
 *   - `enabled` 只在 **密钥齐全** 时才为 true：半配状态（只填了 site key）一律按未启用处理，
 *     避免"配了一半把登录锁死"。
 *   - 校验服务不可用（超时/网络错）⇒ **fail-closed（拒绝）**，因为这是安全门控；
 *     但记 error 级日志便于发现。也正因如此才默认不开 —— 别让第三方抖动锁死登录。
 *   - 已校验成功的 token 是一次性的，Cloudflare 侧负责去重，这里不做缓存。
 */

const CFG_TTL_MS = 5000;
const CONFIG_KEYS = ['turnstile_site_key', 'turnstile_secret_key', 'turnstile_enabled'];
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

let cache = { cfg: undefined, at: 0 };

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * 读配置（5s 进程内缓存；管理台保存即失效）。
 * @returns {Promise<{siteKey: string, secretKey: string, enabled: boolean}>}
 */
export async function getTurnstileConfig() {
  const now = Date.now();
  if (cache.cfg !== undefined && now - cache.at < CFG_TTL_MS) {
    return cache.cfg;
  }
  const cfg = { siteKey: '', secretKey: '', enabled: false };
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [CONFIG_KEYS]
    );
    for (const r of rows) {
      let v = r.config_value;
      if (v && typeof v === 'object') v = v.value ?? '';
      const s = toTrimmedString(v);
      if (r.config_key === 'turnstile_site_key') cfg.siteKey = s;
      else if (r.config_key === 'turnstile_secret_key') cfg.secretKey = s ? toTrimmedString(decryptField(s)) : '';
      else if (r.config_key === 'turnstile_enabled') cfg.enabled = s === 'true';
    }
  } catch (err) {
    // 读库失败不覆写缓存（保住最近一次成功快照）；按"未启用"处理
    logger.warn('[turnstile] 读取配置失败，按未启用处理', { error: err.message });
    return cache.cfg === undefined ? cfg : cache.cfg;
  }
  // 半配状态视为未启用：绝不因为"填了一半"把登录锁死
  const enabled = cfg.enabled && Boolean(cfg.siteKey) && Boolean(cfg.secretKey);
  const resolved = { ...cfg, enabled };
  cache = { cfg: resolved, at: now };
  return resolved;
}

export function invalidateTurnstileConfigCache() {
  cache = { cfg: undefined, at: 0 };
}

/**
 * 校验前端传来的 Turnstile token。
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, codes?: string[]}>}
 */
export async function verifyTurnstile(token, ip) {
  const cfg = await getTurnstileConfig();
  if (!cfg.enabled) return { ok: true, skipped: true };

  const t = toTrimmedString(token);
  if (!t) return { ok: false, reason: 'missing_token' };

  try {
    const body = new URLSearchParams({ secret: cfg.secretKey, response: t });
    if (ip) body.set('remoteip', String(ip).replace(/^::ffff:/, ''));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let data = {};
    try {
      const resp = await fetch(VERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
      data = await resp.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
    if (data?.success === true) return { ok: true };
    return { ok: false, reason: 'verify_failed', codes: data?.['error-codes'] || [] };
  } catch (err) {
    // 安全门控 ⇒ fail-closed（拒绝），但记 error 便于发现第三方抖动
    logger.error('[turnstile] 校验请求失败，按拒绝处理（fail-closed）', { error: err.message });
    return { ok: false, reason: 'verify_unavailable' };
  }
}

/**
 * 发码等入口的门控。未启用 ⇒ 直接放行（与今天行为一致）。
 * token 位置：body.turnstileToken（前端/客户端），或 `x-turnstile-token` 头。
 * @returns {Promise<{ok: true} | {ok: false, status: number, message: string}>}
 */
export async function gateCaptcha(req) {
  const token = req?.body?.turnstileToken ?? req?.headers?.['x-turnstile-token'];
  const result = await verifyTurnstile(token, req?.ip);
  if (result.ok) return { ok: true };
  const message =
    result.reason === 'missing_token'
      ? '请先完成人机验证'
      : result.reason === 'verify_unavailable'
        ? '人机验证服务暂时不可用，请稍后重试'
        : '人机验证未通过，请重试';
  return { ok: false, status: 400, message };
}

/**
 * Express 中间件形态（推荐用它接路由）：`router.post('/send-code', sendCodeLimiter, captchaGate, handler)`。
 * 未启用时 `next()` 直接放行 —— 打开开关前，加了这个中间件也**零行为变化**。
 */
export async function captchaGate(req, res, next) {
  try {
    const gate = await gateCaptcha(req);
    if (gate.ok) return next();
    return res.status(gate.status).json({ code: 40003, message: gate.message });
  } catch (err) {
    // 门控自身出错：安全门控 fail-closed（拒绝），并记日志
    logger.error('[turnstile] 门控异常，按拒绝处理', { error: err.message });
    return res.status(400).json({ code: 40003, message: '人机验证未通过，请重试' });
  }
}

import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { encryptField, decryptField } from '../utils/encryption.js';

/**
 * 第三方登录 · **设备码流**（RFC 8628 Device Authorization Grant）
 *
 * 为什么选它（而不是浏览器回调）：桌面端要落地回调就得在 Rust 侧起本地监听端口 / 注册深链协议；
 * 设备码流**不需要回调地址、不需要备案域名、不必改 Rust** —— 应用内显示 8 位码，
 * 用户去 github.com/login/device 输入即可。GitHub 与 Microsoft Entra 原生支持。
 *
 * 安全要点：
 *   - `device_code` 是**轮询密钥**（拿到它就能换 access token）⇒ **绝不发给客户端**。
 *     这里把 `{provider, deviceCode}` 用 AES 加密成 opaque 的 `pollToken` 交给客户端，
 *     客户端轮询时原样回传，服务端解密后才用自己的 client_id 去换 token（client_id 也不外泄）。
 *   - access token 只在服务端内存里存在（换取资料后即丢弃，不落库）。
 *   - 账号关联规则（见 resolveOrCreateUser）：先按 (provider, providerUserId) 命中既有身份 →
 *     否则按**已验证邮箱**并入既有账号 → 都没有则新建（手机号用占位值，见迁移 089 的说明）。
 */

const CFG_TTL_MS = 5000;
const CFG_KEYS = ['oauth_github_client_id', 'oauth_microsoft_client_id', 'oauth_microsoft_tenant'];

let cfgCache = { cfg: undefined, at: 0 };

export const OAUTH_PROVIDERS = ['github', 'microsoft'];

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** 读 OAuth 配置（5s 缓存；管理台保存即失效） */
export async function getOAuthConfig() {
  const now = Date.now();
  if (cfgCache.cfg !== undefined && now - cfgCache.at < CFG_TTL_MS) return cfgCache.cfg;
  const cfg = { githubClientId: '', microsoftClientId: '', microsoftTenant: 'common' };
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [CFG_KEYS]
    );
    for (const r of rows) {
      let v = r.config_value;
      if (v && typeof v === 'object') v = v.value ?? '';
      const s = toTrimmedString(v);
      if (r.config_key === 'oauth_github_client_id') cfg.githubClientId = s;
      else if (r.config_key === 'oauth_microsoft_client_id') cfg.microsoftClientId = s;
      else if (r.config_key === 'oauth_microsoft_tenant') cfg.microsoftTenant = s || 'common';
    }
  } catch (err) {
    logger.warn('[oauth] 读取配置失败，按未配置处理', { error: err.message });
    return cfgCache.cfg ?? cfg;
  }
  const resolved = { ...cfg, microsoftTenant: cfg.microsoftTenant || 'common' };
  cfgCache = { cfg: resolved, at: now };
  return resolved;
}

export function invalidateOAuthConfigCache() {
  cfgCache = { cfg: undefined, at: 0 };
}

/** 该 provider 是否已配置（未配置 ⇒ 前端不显示入口，避免"点了没反应"） */
export function isProviderConfigured(cfg, provider) {
  if (provider === 'github') return Boolean(cfg.githubClientId);
  if (provider === 'microsoft') return Boolean(cfg.microsoftClientId);
  return false;
}

/** providers 列表视图（前端据此决定显示哪些按钮） */
export function listProviders(cfg) {
  return OAUTH_PROVIDERS.map((p) => ({
    provider: p,
    name: p === 'github' ? 'GitHub' : 'Microsoft',
    configured: isProviderConfigured(cfg, p),
  }));
}

function endpoints(provider, cfg) {
  if (provider === 'github') {
    return {
      clientId: cfg.githubClientId,
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scope: 'read:user user:email',
    };
  }
  const t = encodeURIComponent(cfg.microsoftTenant);
  return {
    clientId: cfg.microsoftClientId,
    deviceCodeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/devicecode`,
    tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    scope: 'openid profile email User.Read',
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 表单式 POST，兼容 JSON 与 form-encoded 两类响应（GitHub 两者都可能给） */
async function postForm(url, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = Object.fromEntries(new URLSearchParams(text));
    }
    return { status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ① 发起设备码流。
 * @returns {Promise<{ok:true, userCode:string, pollToken:string, verificationUri:string,
 *                    verificationUriComplete:string|null, expiresIn:number, interval:number}
 *                  | {ok:false, reason:string, detail?:string}>}
 */
export async function startDeviceFlow(provider, cfgInput) {
  if (!OAUTH_PROVIDERS.includes(provider)) return { ok: false, reason: 'unknown_provider' };
  const cfg = cfgInput ?? (await getOAuthConfig());
  if (!isProviderConfigured(cfg, provider)) return { ok: false, reason: 'not_configured' };

  const meta = endpoints(provider, cfg);
  try {
    const { status, data } = await postForm(meta.deviceCodeUrl, {
      client_id: meta.clientId,
      scope: meta.scope,
    });
    const userCode = toTrimmedString(data.user_code);
    const deviceCode = toTrimmedString(data.device_code);
    if (status >= 400 || !userCode || !deviceCode) {
      const detail =
        toTrimmedString(data.error_description) || toTrimmedString(data.error) || `HTTP ${status}`;
      logger.warn('[oauth] 发起设备码流失败', { provider, status, detail });
      return { ok: false, reason: 'start_failed', detail };
    }
    const expiresIn = Math.max(Number(data.expires_in) || 900, 60);
    const interval = Math.max(Number(data.interval) || 5, 5);
    // 诊断（临时）：把发出的码记下来（code 是公开值，用户屏幕上就印着它）
    logger.info('[oauth] start ok', { provider, userCode, interval, expiresIn });
    return {
      ok: true,
      provider,
      userCode,
      // ⚠️ device_code 绝不外发：加密成 opaque pollToken（见文件头说明）
      // userCode 一并放进密文：只为诊断时能把「用户屏幕上的码」与「正在轮询的流」对上（不外发）
      pollToken: encryptField(JSON.stringify({ provider, deviceCode, userCode, iat: Date.now() })),
      verificationUri: toTrimmedString(data.verification_uri) || (provider === 'github' ? 'https://github.com/login/device' : ''),
      verificationUriComplete: toTrimmedString(data.verification_uri_complete) || null,
      expiresIn,
      interval,
      message: toTrimmedString(data.message) || null,
    };
  } catch (err) {
    logger.warn('[oauth] 发起设备码流异常', { provider, error: err.message });
    return { ok: false, reason: 'network_error', detail: err.message };
  }
}

/**
 * ② 轮询换 token（服务端代客户端轮询；客户端只回传 opaque pollToken）。
 * @returns {Promise<{ok:true, accessToken:string} | {ok:false, reason:string, detail?:string}>}
 */
export async function pollDeviceFlow(provider, pollToken) {
  if (!OAUTH_PROVIDERS.includes(provider)) return { ok: false, reason: 'unknown_provider' };
  let payload;
  try {
    payload = JSON.parse(decryptField(toTrimmedString(pollToken)));
  } catch {
    return { ok: false, reason: 'invalid_poll_token' };
  }
  if (!payload?.deviceCode || payload.provider !== provider) {
    return { ok: false, reason: 'invalid_poll_token' };
  }
  const cfg = await getOAuthConfig();
  if (!isProviderConfigured(cfg, provider)) return { ok: false, reason: 'not_configured' };

  const meta = endpoints(provider, cfg);
  try {
    const { status, data } = await postForm(meta.tokenUrl, {
      client_id: meta.clientId,
      device_code: payload.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const accessToken = toTrimmedString(data.access_token);
    if (accessToken) return { ok: true, accessToken };
    const err = toTrimmedString(data.error);
    // 诊断（临时）：provider 说还没授权时，把「它认识的 userCode」记下来，
    // 好和用户屏幕上显示的码对齐（排查"浏览器已授权但服务端仍 pending"）
    if (err === 'authorization_pending') {
      logger.info('[oauth] provider 应答 authorization_pending', {
        provider,
        userCode: toTrimmedString(payload.userCode) || '(无)',
      });
    }
    // RFC 8628 标准错误码（GitHub 与 Entra 同名）
    if (err === 'authorization_pending') return { ok: false, reason: 'pending' };
    if (err === 'slow_down') return { ok: false, reason: 'slow_down' };
    if (err === 'expired_token') return { ok: false, reason: 'expired' };
    if (err === 'access_denied') return { ok: false, reason: 'denied' };
    return {
      ok: false,
      reason: 'poll_failed',
      detail: toTrimmedString(data.error_description) || err || `HTTP ${status}`,
    };
  } catch (err) {
    return { ok: false, reason: 'network_error', detail: err.message };
  }
}

/** ③ 用 access token 拉第三方资料 */
export async function fetchProviderProfile(provider, accessToken) {
  try {
    if (provider === 'github') {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        // GitHub API 要求带 UA，否则 403
        'User-Agent': 'ClipSync',
      };
      const meResp = await fetchWithTimeout('https://api.github.com/user', { headers }, 10000);
      if (!meResp.ok) return { ok: false, reason: 'profile_failed', detail: `HTTP ${meResp.status}` };
      const me = await meResp.json();
      let email = toTrimmedString(me.email) || null;
      if (!email) {
        // /user 的 email 可能为空（用户没设公开邮箱）⇒ 取"已验证且 primary"的那个
        const emResp = await fetchWithTimeout('https://api.github.com/user/emails', { headers }, 10000);
        if (emResp.ok) {
          const emails = await emResp.json();
          if (Array.isArray(emails)) {
            const pick = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
            if (pick?.email) email = toTrimmedString(pick.email);
          }
        }
      }
      return {
        ok: true,
        providerUserId: String(me.id),
        email,
        // GitHub 只允许把"已验证"的邮箱设为公开邮箱；能取到即视为已验证
        emailVerified: Boolean(email),
        nickname: toTrimmedString(me.name) || toTrimmedString(me.login) || null,
      };
    }

    // Microsoft：Graph /me
    const resp = await fetchWithTimeout(
      'https://graph.microsoft.com/v1.0/me',
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      10000
    );
    if (!resp.ok) return { ok: false, reason: 'profile_failed', detail: `HTTP ${resp.status}` };
    const me = await resp.json();
    const email = toTrimmedString(me.mail) || toTrimmedString(me.userPrincipalName) || null;
    return {
      ok: true,
      providerUserId: String(me.id),
      email,
      // 组织内 UPN 由租户签发，视为可信；用于"并入既有账号"的判据
      emailVerified: Boolean(email),
      nickname: toTrimmedString(me.displayName) || null,
    };
  } catch (err) {
    return { ok: false, reason: 'profile_error', detail: err.message };
  }
}

/**
 * ④ 关联或创建本站账号（单事务；`oauth_identities` 唯一键兜住并发重复建号）。
 * @returns {Promise<{ok:true, user:object, created:boolean, linkedExisting:boolean} | {ok:false, reason:string}>}
 */
export async function resolveOrCreateUser(provider, profile) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, profile.providerUserId]
    );
    if (existing.rows.length > 0) {
      const userId = existing.rows[0].user_id;
      await client.query(
        `UPDATE oauth_identities
            SET last_login_at = NOW(),
                email = COALESCE($3, email),
                nickname = COALESCE($4, nickname)
          WHERE provider = $1 AND provider_user_id = $2`,
        [provider, profile.providerUserId, profile.email || null, profile.nickname || null]
      );
      const u = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
      return { ok: true, user: u.rows[0], created: false, linkedExisting: true };
    }

    // 按已验证邮箱并入既有账号（避免同一人两套账号）
    if (profile.email && profile.emailVerified) {
      const byEmail = await client.query(
        'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1',
        [profile.email]
      );
      if (byEmail.rows.length > 0) {
        const user = byEmail.rows[0];
        await client.query(
          `INSERT INTO oauth_identities (user_id, provider, provider_user_id, email, nickname, last_login_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (provider, provider_user_id) DO NOTHING`,
          [user.id, provider, profile.providerUserId, profile.email, profile.nickname || null]
        );
        await client.query('COMMIT');
        return { ok: true, user, created: false, linkedExisting: true };
      }
    }

    // 全新账号：users.phone 是 NOT NULL ⇒ 用占位值（见迁移 089 的详细说明）
    const placeholderPhone = `oauth:${provider}:${profile.providerUserId}`;
    const createdUser = await client.query(
      `INSERT INTO users (phone, nickname, email, is_active, subscription_status)
       VALUES ($1, $2, $3, TRUE, 'free')
       RETURNING *`,
      [placeholderPhone, profile.nickname || provider, profile.email || null]
    );
    const user = createdUser.rows[0];
    await client.query(
      `INSERT INTO oauth_identities (user_id, provider, provider_user_id, email, nickname, last_login_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [user.id, provider, profile.providerUserId, profile.email || null, profile.nickname || null]
    );
    await client.query('COMMIT');
    return { ok: true, user, created: true, linkedExisting: false };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 回滚失败也要往下抛原始错误 */
    }
    logger.error('[oauth] 关联/创建账号失败', { provider, error: err.message });
    return { ok: false, reason: 'account_error' };
  } finally {
    client.release();
  }
}

import { apiGet, apiPost } from '@/api/client';
import type { LoginResp, RefreshPayload, WhoamiResp } from '@/api/types';

/**
 * 真实后端契约（src/server/src/routes/auth-password.js / auth.js）：
 * - POST /auth/login  body {email|phone, password}          → { token, sessionId, user }
 * - POST /auth/send-code {phone}                            → { message }（dev 为固定码）
 * - POST /auth/verify-code {phone, code}                    → { token, ... }
 * - GET  /admin/whoami（T-A1）→ { userId, roleKey, roleLevel, permissions }
 * 登录响应不含角色信息，统一在登录成功后调 whoami 组装前端会话。
 * TOTP：真实登录链路的 2FA 校验由 two-factor 路由承担，本层暂不传（字段保留在表单）。
 */

interface RealLoginResp {
  token: string;
  sessionId?: string;
  user?: { id?: string; phone?: string | null; email?: string | null; nickname?: string | null };
}

function splitAccount(account: string): { email?: string; phone?: string } {
  const clean = account.trim().toLowerCase();
  return clean.includes('@') ? { email: clean } : { phone: clean };
}

/** 登录成功后：取角色与权限，组装前端会话对象（此时尚未写入 store，需显式带 token） */
async function finalizeSession(real: RealLoginResp, account: string): Promise<LoginResp> {
  const who = await apiGet<WhoamiResp>('/admin/whoami', {
    headers: { Authorization: `Bearer ${real.token}` },
  });
  return {
    accessToken: real.token,
    refreshToken: null,
    account,
    nickname: real.user?.nickname || account,
    roleKey: who.roleKey,
    // 沿用约定：super_admin 存 ['*']（hasPerm 对 super_admin 恒真）
    permissions: who.roleKey === 'super_admin' ? ['*'] : who.permissions,
  };
}

/** 管理员登录 · 密码方式（账号为邮箱或手机号） */
export async function loginByPassword(payload: {
  account: string;
  password: string;
}): Promise<LoginResp> {
  const real = await apiPost<RealLoginResp>('/auth/login', {
    ...splitAccount(payload.account),
    password: payload.password,
  });
  return finalizeSession(real, payload.account.trim());
}

/** 发送登录验证码（dev 环境为 MVP 固定码，见后端 send-code） */
export async function sendLoginCode(phone: string): Promise<void> {
  await apiPost('/auth/send-code', { phone: phone.trim() });
}

/** 管理员登录 · 验证码方式 */
export async function loginByCode(phone: string, code: string): Promise<LoginResp> {
  const real = await apiPost<RealLoginResp>('/auth/verify-code', {
    phone: phone.trim(),
    code: code.trim(),
  });
  return finalizeSession(real, phone.trim());
}

/** 用 refreshToken 换新令牌（一般由 client.ts 401 拦截自动调用；真实后端接入后契约对齐 auth-refresh 路由） */
export function refresh(payload: RefreshPayload): Promise<LoginResp> {
  return apiPost<LoginResp>('/auth/refresh', payload);
}

/**
 * 管理台单点登录（RB-SSO）：桌面端超管点击「管理控制台」签发一次性 code（60s），
 * 浏览器带 code 打开 /sso 页面后调本接口兑换正式会话（后端 GETDEL 原子消费，防重放）。
 */
export async function ssoExchange(code: string): Promise<LoginResp> {
  const real = await apiPost<RealLoginResp>('/auth/sso-exchange', { code });
  const account = real.user?.phone || real.user?.email || 'sso';
  return finalizeSession(real, account);
}

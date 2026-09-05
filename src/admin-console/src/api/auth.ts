import { apiPost } from '@/api/client';
import type { LoginPayload, LoginResp, RefreshPayload } from '@/api/types';

/** 管理员登录（账号 + 密码 + 6 位 TOTP） */
export function login(payload: LoginPayload): Promise<LoginResp> {
  return apiPost<LoginResp>('/auth/login', payload);
}

/** 用 refreshToken 换新令牌（一般由 client.ts 401 拦截自动调用） */
export function refresh(payload: RefreshPayload): Promise<LoginResp> {
  return apiPost<LoginResp>('/auth/refresh', payload);
}

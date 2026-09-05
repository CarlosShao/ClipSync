import { App } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import type { ApiErrorBody, ApiResp, LoginResp } from '@/api/types';

export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// ── message 桥接：拦截器在 React 之外，通过 antd App.useApp() 取得支持主题上下文的 message ──
let messageApi: MessageInstance | null = null;

export function bindMessageApi(api: MessageInstance | null): void {
  messageApi = api;
}

/** 供 App 挂载一次，把 App.useApp() 的 message 绑定给拦截器 */
export function MessageBridge(): null {
  const { message } = App.useApp();
  useEffect(() => {
    bindMessageApi(message);
    return () => bindMessageApi(null);
  }, [message]);
  return null;
}

function notifyError(text: string): void {
  if (messageApi) {
    void messageApi.error(text);
  }
  // message 未绑定时静默（理论不可达：Bridge 在根组件最先挂载）
}

/** 业务错误（code !== 0），拦截器已 toast */
export class ApiError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export const client = axios.create({
  baseURL: API_BASE,
  timeout: 15_000,
});

client.interceptors.request.use((config) => {
  const { accessToken } = useAuthStore.getState();
  if (accessToken) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  // CSRF 占位：后端启用 CSRF 校验时由登录接口下发真实 token
  config.headers.set('X-CSRF-Token', 'placeholder');
  return config;
});

let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;
  try {
    const resp = await axios.post<ApiResp<LoginResp>>(
      `${API_BASE}/auth/refresh`,
      { refreshToken },
      { headers: { 'X-CSRF-Token': 'placeholder' } },
    );
    const body = resp.data;
    if (body.code !== 0) return null;
    useAuthStore.getState().setAuth(body.data);
    return body.data.accessToken;
  } catch {
    return null;
  }
}

function redirectToLogin(): void {
  useAuthStore.getState().clearAuth();
  if (window.location.pathname !== '/login') {
    window.location.replace('/login');
  }
}

const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: '请求参数错误',
  401: '登录已过期，请重新登录',
  403: '没有执行该操作的权限',
  404: '资源不存在',
  429: '请求过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后再试',
  502: '网关错误，请稍后再试',
  503: '服务暂不可用，请稍后再试',
};

client.interceptors.response.use(
  (resp) => {
    // 统一展开响应壳 { code, data, message? } → 直接返回 data
    const body = resp.data as ApiResp<unknown> | undefined;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        const text = body.message ?? '请求失败';
        notifyError(text);
        return Promise.reject(new ApiError(body.code, text));
      }
      return body.data as never;
    }
    return resp;
  },
  async (error: AxiosError) => {
    const config = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;
    const errBody = error.response?.data as ApiErrorBody | undefined;

    // 401：单次刷新令牌后重放；鉴权接口本身不重试
    if (status === 401 && config && !config._retried && !config.url?.includes('/auth/')) {
      config._retried = true;
      refreshing ??= refreshAccessToken().finally(() => {
        refreshing = null;
      });
      const token = await refreshing;
      if (token) {
        config.headers = { ...(config.headers ?? {}), Authorization: `Bearer ${token}` };
        return client.request(config);
      }
      redirectToLogin();
    }

    notifyError(errBody?.message ?? HTTP_STATUS_MESSAGES[status ?? 0] ?? `请求失败（${status ?? '网络异常'}）`);
    return Promise.reject(error);
  },
);

// ── 薄封装：响应已被拦截器展开为 data，这里只做类型还原 ──

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  return (await client.get(url, config)) as T;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return (await client.post(url, body, config)) as T;
}

export async function apiPatch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return (await client.patch(url, body, config)) as T;
}

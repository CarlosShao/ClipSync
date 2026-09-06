import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LoginResp } from '@/api/types';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  /** 已知内置角色：super_admin / admin / user；自定义角色为 custom_* */
  roleKey: string | null;
  account: string | null;
  nickname: string | null;
  /** 权限键列表；super_admin 为 ['*'] */
  permissions: string[];
  setAuth: (payload: LoginResp) => void;
  clearAuth: () => void;
}

/**
 * 登录态 store。
 * accessToken 常规放内存；本管理台为低频内部工具，直接 zustand persist 到 localStorage，
 * 由 client.ts 在 401 时用 refreshToken 单次续期。
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      roleKey: null,
      account: null,
      nickname: null,
      permissions: [],
      setAuth: (payload) =>
        set({
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          roleKey: payload.roleKey,
          account: payload.account,
          nickname: payload.nickname,
          permissions: payload.permissions ?? [],
        }),
      clearAuth: () =>
        set({
          accessToken: null,
          refreshToken: null,
          roleKey: null,
          account: null,
          nickname: null,
          permissions: [],
        }),
    }),
    { name: 'clipsync-admin-auth' },
  ),
);

/** 可进入后台的管理角色 */
export const ADMIN_ROLE_KEYS: readonly string[] = ['admin', 'super_admin'];

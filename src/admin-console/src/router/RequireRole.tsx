import { Navigate, useLocation } from 'react-router';
import type { ReactElement } from 'react';
import { ADMIN_ROLE_KEYS, useAuthStore } from '@/stores/authStore';
import { ForbiddenPage } from '@/pages/forbidden';
import { hasPerm } from '@/utils/permissions';

interface RequireRoleProps {
  children: ReactElement;
  /**
   * 可选权限点（RB-07 路由级守卫）：单个键或键数组（任一满足即通过）。
   * 仅做 UX 裁剪，真正鉴权以后端 requirePerm 中间件为准。
   */
  permission?: string | string[];
}

/**
 * 路由级权限守卫：
 * - 未登录 → /login（记录来源路径）
 * - roleKey ∉ {admin, super_admin} → 403 页
 * - 传入 permission 且当前登录态无对应权限键 → 403 页
 */
export function RequireRole({ children, permission }: RequireRoleProps) {
  const { accessToken, roleKey } = useAuthStore();
  const location = useLocation();

  if (!accessToken) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!roleKey || !ADMIN_ROLE_KEYS.includes(roleKey)) {
    return <ForbiddenPage />;
  }
  if (permission && !(Array.isArray(permission) ? permission.some((p) => hasPerm(p)) : hasPerm(permission))) {
    return <ForbiddenPage />;
  }
  return children;
}

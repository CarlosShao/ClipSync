import { Navigate, useLocation } from 'react-router';
import type { ReactElement } from 'react';
import { ADMIN_ROLE_KEYS, useAuthStore } from '@/stores/authStore';
import { ForbiddenPage } from '@/pages/forbidden';

interface RequireRoleProps {
  children: ReactElement;
}

/**
 * 路由级权限守卫：
 * - 未登录 → /login（记录来源路径）
 * - roleKey ∉ {admin, super_admin} → 403 页
 * 仅做 UX 裁剪，真正鉴权以后端中间件为准。
 */
export function RequireRole({ children }: RequireRoleProps) {
  const { accessToken, roleKey } = useAuthStore();
  const location = useLocation();

  if (!accessToken) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!roleKey || !ADMIN_ROLE_KEYS.includes(roleKey)) {
    return <ForbiddenPage />;
  }
  return children;
}

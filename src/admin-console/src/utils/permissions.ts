import { useAuthStore } from '@/stores/authStore';

/**
 * 按钮级权限判断（仅做 UX 裁剪：隐藏无权按钮）。
 * 真正的鉴权以后端 requirePerm 中间件为准，前端不做安全假设。
 */
export function hasPerm(permKey: string): boolean {
  const { roleKey, permissions } = useAuthStore.getState();
  if (!roleKey) return false;
  if (roleKey === 'super_admin') return true;
  if (permissions.includes('*')) return true;
  return permissions.includes(permKey);
}

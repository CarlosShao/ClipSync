import { apiGet } from '@/api/client';
import type { Permission, Role } from '@/api/types';

/** 角色列表（含每个角色的权限键集合） */
export function getRoles(): Promise<Role[]> {
  return apiGet<Role[]>('/admin/roles');
}

/** 权限目录（按 category 分组展示） */
export function getPermissions(): Promise<Permission[]> {
  return apiGet<Permission[]>('/admin/permissions');
}

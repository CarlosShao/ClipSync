import { apiGet, apiPatch, apiPost } from '@/api/client';
import type {
  CreateRolePayload,
  Permission,
  Role,
  UpdateRolePermissionsPayload,
} from '@/api/types';

/** 角色列表（含每个角色的权限键集合） */
export function getRoles(): Promise<Role[]> {
  return apiGet<Role[]>('/admin/roles');
}

/** 权限目录（按 category 分组展示） */
export function getPermissions(): Promise<Permission[]> {
  return apiGet<Permission[]>('/admin/permissions');
}

/** 保存角色权限集合（后端写入审计 admin.roles.update，敏感操作） */
export function updateRolePermissions(
  id: string,
  payload: UpdateRolePermissionsPayload,
): Promise<Role> {
  return apiPatch<Role>(`/admin/roles/${id}/permissions`, payload);
}

/** 创建自定义角色（roleKey 必须 custom_ 前缀） */
export function createRole(payload: CreateRolePayload): Promise<Role> {
  return apiPost<Role>('/admin/roles', payload);
}

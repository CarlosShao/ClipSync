import { apiGet, apiPatch, apiPost } from '@/api/client';
import type {
  AdminUser,
  PageData,
  UpdateUserStatusPayload,
  UserDetail,
  UserListParams,
} from '@/api/types';

/** 用户列表（分页 + 搜索 + 套餐/状态/注册时间筛选） */
export function getUsers(params: UserListParams): Promise<PageData<AdminUser>> {
  return apiGet<PageData<AdminUser>>('/admin/users', { params });
}

/** 用户详情（含设备与最近审计） */
export function getUserDetail(id: string): Promise<UserDetail> {
  return apiGet<UserDetail>(`/admin/users/${id}`);
}

/** 停用 / 启用账号（停用必须带 reason，写入审计日志） */
export function updateUserStatus(id: string, payload: UpdateUserStatusPayload): Promise<AdminUser> {
  return apiPatch<AdminUser>(`/admin/users/${id}/status`, payload);
}

/** 审批通过等待名单用户（signup_waitlist 开关落地），写入审计日志 */
export function approveUser(id: string): Promise<AdminUser> {
  return apiPost<AdminUser>(`/admin/users/${id}/approve`, {});
}

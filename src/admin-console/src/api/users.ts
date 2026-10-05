import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';
import type {
  AdminUser,
  NotifyUserPayload,
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

/** AF-11：强制下线（吊销全部活跃会话；原因写审计 admin.user.force_logout） */
export function forceLogoutUser(
  id: string,
  payload: { reason: string }
): Promise<{ id: string; revokedSessions: number }> {
  return apiPost<{ id: string; revokedSessions: number }>(
    `/admin/users/${id}/force-logout`,
    payload
  );
}

/** AF-12：删除账户（软删 is_active=false；原因写审计 user.delete；非物理删除，可重新启用） */
export function deleteUser(
  id: string,
  payload: { reason: string }
): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(`/admin/users/${id}`, payload);
}

/**
 * 2026-10-05 补：分配角色（端点 `PATCH /admin/users/:id/role` 早就存在，此前**前端零调用** ——
 * 见 docs/audit/admin-console-db-only-gaps-2026-10-05.md）。
 * 后端两道闸：超管角色不可授予（403 40301）、不得授予等级不低于操作者的角色（403 40303）。
 * 权限键是 `admin.roles.manage`（与 users.manage 分开）。
 */
export function assignUserRole(
  id: string,
  payload: { roleId: string; reason?: string }
): Promise<AdminUser> {
  return apiPatch<AdminUser>(`/admin/users/${id}/role`, payload);
}

/**
 * 2026-10-05 补：重置两步验证（端点 `POST /admin/users/:id/reset-2fa` 早就存在，此前前端零调用）。
 * 清空 TOTP 四列即完成，用户需重新绑定；写审计 admin.user.reset_2fa。
 */
export function resetUserTwoFactor(id: string): Promise<{ id: string; twoFactorEnabled: boolean }> {
  return apiPost<{ id: string; twoFactorEnabled: boolean }>(`/admin/users/${id}/reset-2fa`, {});
}

/**
 * 2026-10-05：对**单个用户**定向通知（原因/正文写入审计 admin.user.notify）。
 * 通道是站内通知（notification_history 落库 + WS 实时推给该用户所有在线设备）。
 * 返回值里的 onlineDevices 用于如实告诉运营"对方此刻是否在线"——落库一定会成功，
 * 但在线数可能为 0（对方下次打开客户端才会在通知中心看到）。
 */
export function notifyUser(
  id: string,
  payload: NotifyUserPayload
): Promise<{ userId: string; notificationType: string; title: string; onlineDevices: number }> {
  return apiPost<{ userId: string; notificationType: string; title: string; onlineDevices: number }>(
    `/admin/users/${id}/notify`,
    payload
  );
}

/**
 * AN-13：数据主体数据导出（可携权）——拉取 JSON 产物 Blob（后端 Content-Disposition 附件）。
 * 后端：GET /admin/users/:id/export?reason=（审计 admin.users.export）；
 * 响应为裸 JSON 文件（非 { code, data } 壳），拦截器对 Blob 原样放行。
 */
export async function exportUserData(id: string, reason: string): Promise<Blob> {
  const resp = await apiGet<Blob>(`/admin/users/${id}/export`, {
    params: { reason },
    responseType: 'blob',
  });
  return resp;
}

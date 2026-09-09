import { apiGet, apiPost } from '@/api/client';
import type { AdminSession, AdminSessionListParams, PageData } from '@/api/types';

/**
 * AN-12 管理员安全策略 · 管理员会话 API
 * 后端：src/server/src/routes/admin/sessions.js
 *  - GET  /admin/sessions           管理角色（level>=50）活跃会话分页列表
 *  - POST /admin/sessions/:id/revoke 单会话强制下线（原因必填，写审计 admin.session.revoke）
 * 权限：列表 admin.users.view / 下线 admin.users.manage（复用既有键，不新增权限目录项）。
 */

/** 管理员会话列表（分页 + 昵称/ID 关键词过滤） */
export function getAdminSessions(
  params: AdminSessionListParams,
): Promise<PageData<AdminSession>> {
  return apiGet<PageData<AdminSession>>('/admin/sessions', { params });
}

/** 强制下线单个管理员会话（原因必填，写入审计日志） */
export function revokeAdminSession(
  id: string,
  payload: { reason: string },
): Promise<{ id: string; revoked: boolean }> {
  return apiPost<{ id: string; revoked: boolean }>(`/admin/sessions/${id}/revoke`, payload);
}

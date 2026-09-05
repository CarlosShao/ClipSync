import { apiGet } from '@/api/client';
import type { AuditLog, AuditLogListParams, PageData } from '@/api/types';

/** 审计日志列表（动作/操作者/结果/IP/日期筛选 + 分页） */
export function getAuditLogs(params: AuditLogListParams): Promise<PageData<AuditLog>> {
  return apiGet<PageData<AuditLog>>('/admin/audit-logs', { params });
}

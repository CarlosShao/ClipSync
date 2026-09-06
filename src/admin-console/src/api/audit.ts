import { apiGet } from '@/api/client';
import type { AuditLog, AuditLogListParams, PageData } from '@/api/types';

/** 审计日志列表（动作/操作者/结果/IP/日期筛选 + 分页） */
export function getAuditLogs(params: AuditLogListParams): Promise<PageData<AuditLog>> {
  return apiGet<PageData<AuditLog>>('/admin/audit-logs', { params });
}

/**
 * CSV 导出用：按当前筛选条件全量拉取审计日志（内部分页循环）。
 * cap 为安全上限（默认 1 万条 / 50 页），避免超大导出拖垮浏览器。
 */
export async function fetchAllAuditLogs(
  params: AuditLogListParams,
  cap = 10_000,
): Promise<AuditLog[]> {
  const pageSize = 200;
  const maxPages = Math.ceil(cap / pageSize);
  const out: AuditLog[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= maxPages && out.length < Math.min(total, cap); page += 1) {
    const data = await getAuditLogs({ ...params, page, pageSize });
    total = data.total;
    out.push(...data.list);
    if (data.list.length < pageSize) break;
  }
  return out;
}

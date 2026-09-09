import { apiGet, apiPost } from '@/api/client';
import type {
  OpsActionResult,
  OpsActionKey,
  OpsAlerts,
  OpsBackups,
  OpsCleanupResult,
  OpsOverview,
  OpsStorage,
  SlowQueriesResp,
} from '@/api/types';

/**
 * 运维监控概览（CO-40/CO-41）：健康探针（DB/Redis）+ 版本/运行时长 +
 * 进程内存 + 请求/错误指标聚合。需要 admin.ops.view 权限（仅超管）。
 */
export function getOpsOverview(): Promise<OpsOverview> {
  return apiGet<OpsOverview>('/admin/ops/overview');
}

/** 备份文件概览（CO-33）：备份目录扫描 items + 汇总 summary（admin.ops.view 权限） */
export function getOpsBackups(): Promise<OpsBackups> {
  return apiGet<OpsBackups>('/admin/ops/backups');
}

/** 慢查询 TOP（pg_stat_statements 聚合，admin.audit.view 权限） */
export function getSlowQueries(): Promise<SlowQueriesResp> {
  return apiGet<SlowQueriesResp>('/admin/slow-queries');
}

/**
 * 运维动作区（AN-06）：clear_cache / reload_configs / force_logout_all / trigger_backup。
 * reason 必填（ConfirmReasonModal 收集），随审计落库；POST 走 adminStrictLimiter。
 */
export function postOpsAction(action: OpsActionKey, reason: string): Promise<OpsActionResult> {
  return apiPost<OpsActionResult>('/admin/ops/actions', { action, reason });
}

/** 活跃告警（AN-15，只读）：Prometheus 代理，降级时 unavailable=true 而非报错 */
export function getOpsAlerts(): Promise<OpsAlerts> {
  return apiGet<OpsAlerts>('/admin/ops/alerts');
}

/** 存储用量统计（AN-08）：总量 + 按表体积 + 用户 TOP10 */
export function getOpsStorage(): Promise<OpsStorage> {
  return apiGet<OpsStorage>('/admin/ops/storage');
}

/** 存储清理手动触发（AN-08）：reason 必填审计，受 storage_cleanup_enabled 闸门控制 */
export function postOpsCleanup(reason: string): Promise<OpsCleanupResult> {
  return apiPost<OpsCleanupResult>('/admin/ops/cleanup', { reason });
}

/**
 * 备份文件下载（AN-06）：blob 拉取后触发浏览器保存（GET 需带 Authorization 头，
 * 不能用裸 <a href>，故走 axios blob → createObjectURL）。
 */
export async function downloadBackupFile(file: string): Promise<void> {
  const blob = await apiGet<Blob>('/admin/ops/backups/download', {
    params: { file },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.split('/').pop() ?? 'backup';
  anchor.click();
  URL.revokeObjectURL(url);
}

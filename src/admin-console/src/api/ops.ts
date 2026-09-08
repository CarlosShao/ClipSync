import { apiGet } from '@/api/client';
import type { OpsBackups, OpsOverview, SlowQueriesResp } from '@/api/types';

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

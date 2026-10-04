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
 * 支付宝渠道凭据自检结论（H1/H4，只读）。
 *
 * 为什么单独一张卡：H1 之后缺公钥会让下单接口直接拒绝收钱，可**只有付款用户能感知**
 * （运营在后台看不到任何异常），所以必须把「渠道现在能不能收钱」摆到台面上。
 * problems 是给运营的可操作清单（如「ALIPAY_PUBLIC_KEY 看起来是应用公钥」），逐条展示。
 *
 * 类型就近定义在本文件（先例：api/refundReviews.ts）——它是新端点，不塞进 api/types.ts
 * 的历史契约面，避免与并行改动打架。
 */
export interface AlipayStatus {
  /** true = 下单与回调验签所需凭据齐全，渠道当前能正常收款 */
  ok: boolean;
  /** ok=false 时的逐条原因；ok=true 时为空数组 */
  problems: string[];
}

/** 支付宝渠道凭据自检（只读，权限同 admin.ops.view）：GET /api/admin/ops/alipay-status */
export function getAlipayStatus(): Promise<AlipayStatus> {
  return apiGet<AlipayStatus>('/admin/ops/alipay-status');
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

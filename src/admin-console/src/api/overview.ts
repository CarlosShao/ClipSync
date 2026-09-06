import { apiGet } from '@/api/client';
import type { OverviewData } from '@/api/types';

/** 看板聚合数据：KPI + 近 14 天订单 + 套餐分布 + 渠道占比 + 待处理事项 */
export function getOverview(): Promise<OverviewData> {
  return apiGet<OverviewData>('/admin/overview');
}

import { apiGet, apiPost } from '@/api/client';
import type {
  AdminSubscription,
  GrantSubscriptionPayload,
  PageData,
  SubscriptionListParams,
  SubscriptionStats,
} from '@/api/types';

/**
 * 订阅域 queryKey 工厂（本地定义：queryKeys.ts 本工单禁改，后续合并；
 * 前缀 ['subscriptions'] 用于写操作后整体失效——同时命中列表与统计）。
 */
export const subscriptionKeys = {
  list: (params: SubscriptionListParams) => ['subscriptions', params] as const,
  stats: () => ['subscriptions', 'stats'] as const,
};

/** 订阅列表（用户/手机号关键词 + 套餐/状态筛选 + 分页，含用户摘要） */
export function getSubscriptions(
  params: SubscriptionListParams,
): Promise<PageData<AdminSubscription>> {
  return apiGet<PageData<AdminSubscription>>('/admin/subscriptions', { params });
}

/** 订阅页头统计：活跃 / 本月到期 / 试用中 */
export function getSubscriptionStats(): Promise<SubscriptionStats> {
  return apiGet<SubscriptionStats>('/admin/subscriptions/stats');
}

/** 赠期 / 调整套餐（原因必填，写入审计 admin.subscriptions.grant） */
export function grantSubscription(
  id: string,
  payload: GrantSubscriptionPayload,
): Promise<AdminSubscription> {
  return apiPost<AdminSubscription>(`/admin/subscriptions/${id}/grant`, payload);
}

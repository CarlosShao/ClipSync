import { apiGet, apiPost } from '@/api/client';
import type {
  AdminSubscription,
  GrantSubscriptionPayload,
  PageData,
  RevokeSubscriptionPayload,
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

/**
 * 收回订阅权益（2026-10-05 新增；原因必填，写入审计 admin.subscriptions.revoke）。
 *
 * 服务端有**保护闸**：该订阅下存在真实已付订单时返回 409 HAS_PAID_ORDER ——
 * 用户花钱买到的权益只能走「退款审核」原路退款，不能在这里撤。
 * 调用方需把该 code 讲成人话（见 RevokeSubscriptionModal）。
 */
export function revokeSubscription(
  id: string,
  payload: RevokeSubscriptionPayload,
): Promise<AdminSubscription & { revokedMode: string; revokedAt: string }> {
  return apiPost<AdminSubscription & { revokedMode: string; revokedAt: string }>(
    `/admin/subscriptions/${id}/revoke`,
    payload,
  );
}

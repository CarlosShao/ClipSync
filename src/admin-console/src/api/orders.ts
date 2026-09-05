import { apiGet, apiPost } from '@/api/client';
import type { Order, OrderListParams, PageData, RefundPayload } from '@/api/types';

/** 订单列表（状态 Tabs + 渠道/时间筛选 + 分页） */
export function getOrders(params: OrderListParams): Promise<PageData<Order>> {
  return apiGet<PageData<Order>>('/admin/orders', { params });
}

/** 执行退款（仅 super_admin；原因必填并写入审计日志） */
export function refundOrder(orderNo: string, payload: RefundPayload): Promise<Order> {
  return apiPost<Order>(`/admin/orders/${orderNo}/refund`, payload);
}

import { apiGet, apiPost } from '@/api/client';
import type {
  Order,
  OrderListQuery,
  PageData,
  ReconciliationReport,
  RefundPayload,
} from '@/api/types';

/** 订单列表（状态 Tabs + 渠道/时间筛选 + 分页；status 支持 refunding 伪状态） */
export function getOrders(params: OrderListQuery): Promise<PageData<Order>> {
  return apiGet<PageData<Order>>('/admin/orders', { params });
}

/** 订单详情（全字段，用于详情弹窗） */
export function getOrder(orderNo: string): Promise<Order> {
  return apiGet<Order>(`/admin/orders/${orderNo}`);
}

/** 执行退款（仅 super_admin；原因必填并写入审计日志） */
export function refundOrder(orderNo: string, payload: RefundPayload): Promise<Order> {
  return apiPost<Order>(`/admin/orders/${orderNo}/refund`, payload);
}

/** 对账报告（按渠道汇总笔数 / 成交额 / 退款额，日终快照） */
export function getReconciliation(): Promise<ReconciliationReport> {
  return apiGet<ReconciliationReport>('/admin/reconciliation');
}

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

/**
 * 执行退款 —— **真实渠道退款（全额、不可撤销）**：服务端调支付宝 alipay.trade.refund
 * 按订单全额原路退回，仅当渠道确认到账才落库：订单置 refunded + 关联订阅立即 canceled
 * （权益当场收回）+ 写审计。渠道侧失败时订单保持 paid 不动，可原样重试（幂等键=订单号）。
 *
 * ⚠️ 旧口径已废除：这条链路不再是「记账式人工标记」，也**不支持部分退款**——
 * payload.amount 恒等于订单金额（RefundModal 已去掉金额输入框），传部分金额会被
 * 400 PARTIAL_REFUND_NOT_SUPPORTED 拒绝。
 * 权限：requirePerm('admin.orders.refund')（superAdminOnly）；原因必填并写入审计日志。
 */
export function refundOrder(orderNo: string, payload: RefundPayload): Promise<Order> {
  return apiPost<Order>(`/admin/orders/${orderNo}/refund`, payload);
}

/**
 * 对账报告（按渠道汇总笔数 / 成交额 / 退款额）。
 * 服务端口径：本站 payment_orders 近 30 天 paid/refunded 订单聚合，
 * generatedAt = 请求时刻（不是渠道日终对账文件）。
 */
export function getReconciliation(): Promise<ReconciliationReport> {
  return apiGet<ReconciliationReport>('/admin/reconciliation');
}

/** 单次导出分页大小（对齐审计导出惯例） */
const EXPORT_PAGE_SIZE = 200;

/** 导出条数上限（1 万条，防误操作全量拉爆） */
const EXPORT_CAP = 10_000;

/**
 * AF-14：按当前筛选条件拉取全部订单（分页循环，pageSize=200，上限 1 万条）。
 * 用于「导出」CSV；与审计页 fetchAllAuditLogs 同模式。
 */
export async function fetchAllOrders(params: OrderListQuery): Promise<Order[]> {
  const all: Order[] = [];
  const total = (await getOrders({ ...params, page: 1, pageSize: 1 })).total;
  const pages = Math.min(
    Math.ceil(total / EXPORT_PAGE_SIZE),
    Math.ceil(EXPORT_CAP / EXPORT_PAGE_SIZE)
  );
  for (let page = 1; page <= pages; page++) {
    const { list } = await getOrders({ ...params, page, pageSize: EXPORT_PAGE_SIZE });
    all.push(...list);
  }
  return all;
}

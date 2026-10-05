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
 * 2026-10-05 新增：人工补履约（渠道回调丢失时「钱到了、货没到」的唯一人工出口）。
 *
 * **服务端会先向支付宝核实到账**（`alipay.trade.query`）：
 *   - 未支付 → 409（拒绝凭空发货）
 *   - 核实调用失败 → 503
 *   - 渠道没回金额 → 409（fail-closed）
 *   - 渠道金额与订单金额不符 → 409（并落 metadata.amount_mismatch 进看板待办）
 * 权限：`admin.orders.refund`（与退款同属资金级写操作）；原因必填写审计 admin.order.manual_fulfill。
 * 因此前端**给按钮不等于能给货**：真正的闸在渠道那一次查询上。
 */
export function fulfillOrder(orderNo: string, payload: { reason: string }): Promise<Order> {
  return apiPost<Order>(`/admin/orders/${orderNo}/fulfill`, payload);
}

/**
 * 对账报告（按渠道汇总笔数 / 成交额 / 退款额）。
 * 服务端口径：本站 payment_orders 近 30 天 paid/refunded 订单聚合，
 * generatedAt = 请求时刻（不是渠道日终对账文件）。
 */
export function getReconciliation(): Promise<ReconciliationReport> {
  return apiGet<ReconciliationReport>('/admin/reconciliation');
}

/**
 * 这一行能否走退款端点（POST /admin/orders/:orderNo/refund）——**必须与服务端的窄口径一致**，
 * 放行过宽只会换来 40005（ORDER_NOT_REFUNDABLE）并让运营白填一次原因：
 *
 *  - paid：常规路径，全额原路退回并立即取消订阅权益。
 *  - refunded：无论资金是否已退回（refundAmount=null 的「退款处理中」）都不得再发起退款。
 *  - cancelled / pending + channelReportsPaid：**异常到账**（H2/H4）——渠道已收款、本地未履约
 *    （sweep 查单发现渠道已付款故没有关单；cancelled 的是 H2 之前关单的历史/竞态数据）。
 *    钱在渠道手里，只能原路退回，故服务端对这**一种**情形放宽了状态闸。
 *    没有该标记时一律不放行——服务端仍会拒。
 *  - failed / 无标记的 pending、cancelled：渠道没收钱，无钱可退。
 */
export function isOrderRefundable(order: Pick<Order, 'status' | 'channelReportsPaid'>): boolean {
  if (order.status === 'paid') return true;
  if (order.status === 'refunded') return false;
  return (
    (order.status === 'cancelled' || order.status === 'pending') &&
    order.channelReportsPaid === true
  );
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

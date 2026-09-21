import { apiGet, apiPost, apiPut } from '@/api/client';
import type { PageData } from '@/api/types';

/**
 * 退款审核域 —— 两段式退款（产品决策 2026-09-20）。
 *
 * 口径：用户在客户端「申请退款」时服务端**不动钱**，只落一条待审申请并当场收回订阅权益；
 * 管理员在本域「通过」的那一刻才真调支付宝 alipay.trade.refund 打款，
 * 「驳回」则不调渠道、按申请时存的权益快照把用户恢复回原套餐。
 *
 * 类型与 queryKey 就近定义在本文件（先例：api/releases.ts、api/ai.ts、api/emailChannels.ts；
 * api/types.ts 是历史契约的单一来源，新域不再往里追加以免与并行改动打架）。
 */

/**
 * refund_requests.status。
 * 契约冻结的**筛选**取值只有 pending | approved | rejected | all，但行内还可能出现
 * 瞬时态 processing（管理员已认领、正在调渠道、结果未知）——列表读得到它，
 * 类型不写进来就会在展示层被迫断言，故这里如实列出（本页不给它开 Tab）。
 */
export type RefundReviewStatus = 'pending' | 'processing' | 'approved' | 'rejected';

/** 列表筛选取值（契约冻结：pending | approved | rejected | all，不含 processing） */
export type RefundReviewStatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

/** 列表行：GET /admin/refund-reviews 的 items 元素 */
export interface RefundReview {
  id: string;
  status: RefundReviewStatus;
  /** 用户提交申请的时刻 */
  requestedAt: string | null;
  reviewedAt: string | null;
  /** 用户在客户端填的申请理由（可空），审核判断的第一手信息 */
  userReason: string | null;
  /** 审核备注：驳回时为「不通过的理由」，会反馈给申请人 */
  reviewNote: string | null;
  reviewedByName: string | null;
  orderNo: string;
  /** 退款金额（元，全额——本期不支持部分退款） */
  amount: number;
  currency: string;
  /** 以下三项来自 LEFT JOIN（用户注销/订单未挂套餐时为空），渲染须兜底 */
  planName: string | null;
  userName: string | null;
  /** 打码手机号，如 138****2765 */
  userPhone: string | null;
  paidAt: string | null;
  /** 申请时生效的自助退款时限（天）：事后判断「当初为什么放行」的依据 */
  windowDaysAtRequest: number;
}

export interface RefundReviewListParams {
  page: number;
  pageSize: number;
  status?: RefundReviewStatusFilter;
}

/**
 * 本域分页壳用 items（其余域用 PageData 的 list）。
 * 服务端实测同时下发 list 与 items 两个键且同值，这里只认契约里的 items，
 * 形状转换收在 getRefundReviews 一处，上层继续用 useTableQuery 认的 list。
 */
export interface RefundReviewListResp {
  items: RefundReview[];
  total: number;
  page: number;
  pageSize: number;
}

/** 审核通过：同时回写申请单与订单（订单转 refunded） */
export interface ApproveRefundReviewResp {
  request: RefundReview;
  order: { orderNo: string; status: 'refunded' };
}

/** 审核驳回：权益按快照恢复，订单保持 paid */
export interface RejectRefundReviewResp {
  request: RefundReview;
  /**
   * 契约未列、服务端实测带：false = 用户在等审期间又另购了新套餐，
   * 旧权益未自动还原（避免造出两条 active 订阅），需人工核对。
   */
  entitlementRestored?: boolean;
}

/** GET/PUT /admin/refund-settings */
export interface RefundSettings {
  /** 自助退款时限（天）：付款后 N 天内允许用户自行申请退款 */
  windowDays: number;
  /** 审核承诺工作日数：给用户的「预计 N 个工作日内完成审核」文案来源 */
  reviewBusinessDays: number;
}

/**
 * 退款审核域 queryKey 工厂（前缀 ['refund-reviews'] 供写操作后整体失效——
 * 同时命中当前筛选页与各状态 Tab 计数）。queryKeys.ts 未含本域，按订阅域先例就近定义。
 */
export const refundReviewKeys = {
  list: (params: RefundReviewListParams) => ['refund-reviews', params] as const,
  settings: () => ['refund-settings'] as const,
};

/** 退款申请列表（状态筛选 + 分页；权限 admin.orders.view） */
export async function getRefundReviews(
  params: RefundReviewListParams
): Promise<PageData<RefundReview>> {
  const resp = await apiGet<RefundReviewListResp>('/admin/refund-reviews', { params });
  return { list: resp.items, total: resp.total, page: resp.page, pageSize: resp.pageSize };
}

/**
 * 审核通过 —— **真调支付宝原路全额退款，不可撤销**（权限 admin.orders.refund）。
 * 失败：409 REFUND_STATE_CONFLICT / ALREADY_REFUNDED，502 REFUND_CHANNEL_FAILED
 * （渠道失败时资金未变动，可原样重试；幂等键=申请单 id）。
 */
export function approveRefundReview(id: string): Promise<ApproveRefundReviewResp> {
  return apiPost<ApproveRefundReviewResp>(`/admin/refund-reviews/${id}/approve`, {});
}

/**
 * 审核驳回（权限 admin.orders.refund）：reason 必填、≤200 字，
 * 服务端按申请时存的快照恢复用户权益（退款没发生，权益只是被临时收回）。
 */
export function rejectRefundReview(id: string, reason: string): Promise<RejectRefundReviewResp> {
  return apiPost<RejectRefundReviewResp>(`/admin/refund-reviews/${id}/reject`, { reason });
}

/** 读取退款参数 */
export function getRefundSettings(): Promise<RefundSettings> {
  return apiGet<RefundSettings>('/admin/refund-settings');
}

/** 保存退款参数（部分更新，只带出现的键；权限 admin.orders.refund） */
export function updateRefundSettings(patch: Partial<RefundSettings>): Promise<RefundSettings> {
  return apiPut<RefundSettings>('/admin/refund-settings', patch);
}

/** 服务端失败码 → 可操作说明（拦截器只会 toast 一句 HTTP 状态文案，行内提示补业务口径） */
const FAILURE_HINTS: Record<string, string> = {
  REFUND_STATE_CONFLICT:
    '申请状态已变化（可能已被其他管理员处理，或订单已关单）。列表已重新拉取，请核对最新状态后再操作。',
  ALREADY_REFUNDED: '该订单已完成退款，无需再次操作。',
  REFUND_CHANNEL_FAILED:
    '支付宝退款渠道调用失败，资金未发生变动，可稍后原样重试；连续失败请去支付宝商户后台核对该笔退款。',
};

/**
 * 从失败响应里取业务码。
 * 契约写的是 { code: 'REFUND_STATE_CONFLICT' }，服务端实际按仓库常规错误壳返回
 * { code: 40902, message, refundCode: 'REFUND_STATE_CONFLICT' } —— 字符串码在 refundCode，
 * 故两种写法都读；数字 code 不是业务码，用正则挡掉以免误判。
 */
function extractFailureCode(err: unknown): string | null {
  const body = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!body || typeof body !== 'object') return null;
  for (const field of ['refundCode', 'code', 'errorCode', 'error'] as const) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  }
  return null;
}

/** 审核失败的行内提示文案（未知码回落到服务端 message，再回落到通用文案） */
export function refundReviewFailureHint(err: unknown): string {
  const code = extractFailureCode(err);
  const hint = code ? FAILURE_HINTS[code] : undefined;
  if (hint) return hint;
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  return typeof message === 'string' && message
    ? message
    : '退款操作未通过服务端校验，列表已刷新，请核对最新状态后重试。';
}

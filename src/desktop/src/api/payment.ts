import { api } from './client'

/**
 * 支付相关接口（桌面端扫码支付链路）。
 *
 * 后端契约（见 src/server/src/routes/payments.js）：
 *   POST /api/payments/create-order
 *     body { subscriptionId, paymentMethod: 'alipay' }
 *     200 → { order: { orderNo, amount, currency, status, paymentParams: { channel, cashierUrl } } }
 *     202 → 由 /api/subscriptions/subscribe 返回（建单成功、待支付）
 *     403 → 生产环境试图使用 mock 渠道
 *     503 → 支付宝凭据未配置（ALIPAY_NOT_CONFIGURED / ALIPAY_NOTIFY_URL_MISSING）
 *   GET  /api/payments/order/:orderNo/status
 *     200 → { order: { status: 'pending'|'paid'|... } }
 *
 * 注意：`api()` 的签名是 (method, path, body) —— method 在前。
 */

export interface CashierParams {
  channel: 'alipay'
  /** 支付宝收银台 URL；前端放进 <iframe> 展示二维码（qr_pay_mode=4） */
  cashierUrl: string
}

export interface PaymentOrder {
  id: string
  orderNo: string
  amount: number
  currency: string
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded'
  paidAt?: string | null
  transactionId?: string | null
  createdAt?: string
  paymentParams?: CashierParams
}

export interface OrderStatus {
  status: PaymentOrder['status']
}

/**
 * 创建支付订单（支付宝渠道）。
 *
 * 两种入口（服务端二者取一，见 payments.js）：
 *  - `subscriptionId`：升级/续费已有订阅
 *  - `planId`：全新订阅（用户还没有订阅记录，履约时按 planId 创建）
 *
 * 失败时返回原始 ApiResponse，由调用方决定文案：
 * 不要在这里吞掉 error —— `client.ts` 已统一处理 401/429 与 toast。
 */
export function createPaymentOrder(
  params: { subscriptionId?: string; planId?: string; billingCycle?: 'monthly' | 'yearly' },
  paymentMethod: 'alipay' = 'alipay',
) {
  return api<{ order: PaymentOrder; message?: string }>('POST', '/api/payments/create-order', {
    ...params,
    paymentMethod,
  })
}

/** 查询订单状态（支付遮罩轮询；服务端会顺带主动查一次支付宝做兜底） */
export function fetchOrderStatus(orderNo: string) {
  return api<{ order: PaymentOrder }>('GET', `/api/payments/order/${encodeURIComponent(orderNo)}/status`)
}

// ===== 用户自助退款申请（个人资料页「申请退款」）=====
//
// 产品口径变更（2026-09-20 裁定）：现实中不可能一申请就秒退成功，自助入口只**落一条
// 待审申请并立即收回权益**，真打款由管理台「审核通过」那一刻触发。所以客户端
// 只有 `/refund-request` 这一个写入口，旧的即时退款 `/api/payments/refund` 不再被调用
// （函数名 requestRefund 沿用，调用点不必跟着改名）。

/** 订单上挂着的退款申请摘要（null = 从未申请过；清单只带在途的两态） */
export interface RefundRequestBriefOnOrder {
  id: string
  status: 'pending' | 'processing'
  requestedAt: string
}

/** GET /api/payments/refundable-orders 的单条订单（含不可退原因） */
export interface RefundableOrder {
  orderId: string
  orderNo: string
  /** 实付金额（升级单=折抵后价） */
  amount: number
  /** 套餐原价（升级单 > amount） */
  originalAmount: number
  /** 升级折抵的残值（不随退款恢复） */
  creditAmount: number
  currency: string
  paidAt: string | null
  status: 'paid' | 'refunded'
  refundable: boolean
  reasonCode: string | null
  refundRequest: RefundRequestBriefOnOrder | null
}

/**
 * 可退订单列表（最近 10 条已付/已退订单；refundable 判定在服务端，前端只转述）。
 * 天数一律取接口回传（windowDays / reviewBusinessDays 是后台可配置项），前端不得写死。
 */
export function fetchRefundableOrders() {
  return api<{
    orders: RefundableOrder[]
    windowDays: number
    reviewBusinessDays: number
  }>('GET', '/api/payments/refundable-orders')
}

/** POST /api/payments/refund-request 成功（201）返回的申请单 */
export interface RefundRequestCreated {
  id: string
  orderId: string
  orderNo: string
  amount: number
  currency: string
  status: 'pending'
  requestedAt: string
  reviewBusinessDays: number
  windowDays: number
}

/** GET /api/payments/refund-requests/mine 的申请记录 */
export interface MyRefundRequest {
  id: string
  orderNo: string
  amount: number
  currency: string
  status: 'pending' | 'processing' | 'approved' | 'rejected'
  requestedAt: string
  reviewedAt?: string | null
  reviewNote?: string | null
}

/**
 * 提交退款申请（服务端不调渠道，只落待审申请 + 立即收回权益）。
 * 拒绝时 error 为英文、code 在 data 里（409 REFUND_REQUEST_PENDING / REFUND_WINDOW_EXPIRED /
 * NOT_CURRENT_SUB_ORDER / ALREADY_REFUNDED / REFUND_STATE_CONFLICT，400 渠道与缺单号，
 * 503 渠道未配置 / 订阅关闭），调用方按 code 映射中文，如实展示。
 */
export function requestRefund(orderNo: string) {
  return api<{ request: RefundRequestCreated; message?: string }>('POST', '/api/payments/refund-request', {
    orderNo,
  })
}

/** 我的退款申请（最近 5 条倒序；个人资料页用它判断「审核中」提示行） */
export function fetchMyRefundRequests() {
  return api<{ requests: MyRefundRequest[] }>('GET', '/api/payments/refund-requests/mine')
}

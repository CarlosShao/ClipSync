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

// ===== 用户自助退款（个人资料页「申请退款」，服务端 payments.js 2026-09-19 放开属主）=====

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
}

/** 可退订单列表（最近 10 条已付/已退订单；refundable 判定在服务端，前端只转述） */
export function fetchRefundableOrders() {
  return api<{ orders: RefundableOrder[]; windowDays: number }>('GET', '/api/payments/refundable-orders')
}

/**
 * 发起真实退款（全额、支付宝原路退回、权益立即收回）。
 * 服务端拒绝时 error 为英文原因（超窗/非最近一笔等），调用方如实展示，勿包装成成功。
 */
export function requestRefund(orderNo: string) {
  return api<{ message: string; order: { orderNo: string; refundAmount: number } }>(
    'POST',
    '/api/payments/refund',
    { orderNo, reason: '用户自助退款' },
  )
}

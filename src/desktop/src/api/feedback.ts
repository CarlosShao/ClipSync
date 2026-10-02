// === 应用内反馈工单 API（设置 → 关于 ClipSync → 发送反馈）===
// 取代此前的「跳转 GitHub Issues」外链：桌面端把工单写进 POST /api/feedback，
// 由服务端落库（feedback_tickets）并尽力转发企业邮箱。
//
// 请求契约以 src/server/src/routes/feedback.js 为准：
//   body：{ title, category, content, contact?, appVersion?, platform? }
//   200 ：{ ok: true, id, status, createdAt, emailSent }
//   400 ：{ error, code }；401（未登录，由 authenticateToken 返回）
// 该端点是「需登录 + 真 CSRF」的写请求，鉴权头与 X-CSRF-Token 一律交给统一的
// api() 处理（client.ts 里那套：Bearer + CSRF + 幂等键 + 401 刷新），本文件不裸 fetch。

import { api } from './client'

/**
 * 分类白名单。
 * routes/feedback.js 的注释明确要求「与迁移 079 的 CHECK 约束、桌面端 FEEDBACK_CATEGORIES 三处一致」，
 * 因此这里保持与服务端同名的常量，供表单下拉直接消费（不另造一份标签表）。
 */
export const FEEDBACK_CATEGORIES = ['feature', 'bug', 'performance', 'ui', 'other'] as const

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

/** 分类 → i18n 文案 key（与服务端 feedbackMailer.js 的 CATEGORY_LABELS 语义一一对应） */
export const FEEDBACK_CATEGORY_LABEL_KEYS: Record<FeedbackCategory, string> = {
  feature: 'fb_cat_feature',
  bug: 'fb_cat_bug',
  performance: 'fb_cat_perf',
  ui: 'fb_cat_ui',
  other: 'fb_cat_other',
}

/** 与服务端一致的长度上限（本地只做前置提示，服务端仍会独立校验并可能返回 400） */
export const FEEDBACK_TITLE_MAX = 200
export const FEEDBACK_CONTENT_MAX = 5000
export const FEEDBACK_CONTACT_MAX = 200

export interface FeedbackPayload {
  title: string
  category: FeedbackCategory
  /** 详细描述，服务端名为 content */
  content: string
  /** 可选回访方式（邮箱/手机/微信均可，服务端不限格式只限长度） */
  contact?: string
  /** 客户端版本；取不到时传空串（服务端落 NULL），不编造 */
  appVersion?: string
  /** 平台标识（windows/macos/linux），与 configStore 设备注册的判定保持一致 */
  platform?: string
}

export interface FeedbackTicket {
  ok: boolean
  id: string
  status: string
  createdAt: string
  /** 是否真实投递到 SMTP（false 仅代表邮件未发出，工单已入库） */
  emailSent: boolean
}

/** POST /api/feedback — 提交一条应用内反馈工单 */
export function submitFeedback(payload: FeedbackPayload) {
  return api<FeedbackTicket>('POST', '/api/feedback', payload)
}

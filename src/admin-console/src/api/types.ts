/**
 * Admin Console 领域类型 —— 前后端共同契约（单一来源）
 *
 * 响应壳：{ code: 0, data: T, message?: string }
 * 错误壳：{ code: number, message: string }（HTTP 状态码照常 4xx/5xx）
 * 分页壳：data = { list: T[], total: number, page: number, pageSize: number }
 * 查询参数：?page=&pageSize=&q=&sort=
 *
 * 后端实现（src/server/src/routes/admin/*）的字段必须与本文件逐字段一致；
 * 字段名取自真实迁移（users / payment_orders / user_subscriptions / audit_logs / roles / permissions）。
 */

// ───────────────────────── 通用壳 ─────────────────────────

export interface ApiResp<T> {
  code: 0;
  data: T;
  message?: string;
}

export interface ApiErrorBody {
  code: number;
  message: string;
}

export interface PageData<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListParams {
  page: number;
  pageSize: number;
  q?: string;
  sort?: string;
}

// ───────────────────────── 用户域 ─────────────────────────

export type UserStatus = 'active' | 'disabled';
export type PlanKey = 'free' | 'pro' | 'enterprise';
/** user_subscriptions.status */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'expired' | 'trialing';
/** user_subscriptions.billing_cycle */
export type BillingCycle = 'monthly' | 'yearly';

export interface Subscription {
  plan: PlanKey;
  billingCycle: BillingCycle | null;
  status: SubscriptionStatus;
  /** YYYY-MM-DD */
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  trialDaysLeft?: number;
}

export interface AdminUser {
  id: string;
  /** 打码手机号，如 138****2765（明文仅后端可解） */
  phone: string;
  nickname: string;
  email?: string;
  isActive: boolean;
  status: UserStatus;
  subscription: Subscription;
  deviceCount: number;
  /** 累计消费（元） */
  totalSpent: number;
  orderCount: number;
  roleId: string | null;
  /** YYYY-MM-DD */
  createdAt: string;
  lastActiveAt?: string | null;
  lastActiveDesc?: string;
  riskFlag?: string | null;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  os?: string;
  status: 'online' | 'offline';
  lastActiveAt?: string | null;
}

export interface UserDetail {
  user: AdminUser;
  devices: Device[];
  recentAuditLogs: AuditLog[];
}

export interface UserListParams extends ListParams {
  plan?: PlanKey | 'all';
  status?: UserStatus | 'all';
  /** 注册时间范围 */
  registeredIn?: '7d' | '30d' | 'all';
}

export interface UpdateUserStatusPayload {
  status: UserStatus;
  /** 危险操作原因（写入审计日志），停用时必填 */
  reason?: string;
}

// ───────────────────────── 订单域 ─────────────────────────

/** payment_orders.status */
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';
export type PaymentChannel = 'wechat' | 'alipay' | 'stripe';

export interface Order {
  /** payment_orders.order_no，如 CS20260905204188 */
  orderNo: string;
  /** payment_orders.out_trade_no */
  outTradeNo: string;
  /** 第三方流水号 */
  transactionId: string | null;
  userId: string;
  /** 列表展示用打码标识（昵称或手机号） */
  userLabel: string;
  /** 展示文案，如 "Pro · 年付" */
  planLabel: string;
  channel: PaymentChannel;
  currency: string;
  /** 订单金额（元） */
  amount: number;
  /** 已退款金额（元） */
  refundAmount: number | null;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
}

export interface OrderListParams extends ListParams {
  status?: OrderStatus | 'all';
  channel?: PaymentChannel | 'all';
  dateFrom?: string;
  dateTo?: string;
}

export interface RefundPayload {
  /** 退款金额（元），不超过订单金额 */
  amount: number;
  /** 退款原因（必填，写入审计日志） */
  reason: string;
}

// ───────────────────────── 审计域 ─────────────────────────

export type AuditResult = 'success' | 'failed';

export interface AuditLog {
  id: string;
  operator: string;
  operatorRole?: 'super_admin' | 'admin' | 'user' | null;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  /** 详情摘要，如 amount=9.90, reason="用户重复支付" */
  details: string;
  ipAddress: string;
  userAgent?: string | null;
  status: AuditResult;
  /** 敏感操作（前端红底高亮） */
  sensitive: boolean;
  /** YYYY-MM-DD HH:mm:ss */
  createdAt: string;
}

export interface AuditLogListParams extends ListParams {
  action?: string;
  operator?: string;
  result?: AuditResult | 'all';
  ip?: string;
  dateFrom?: string;
  dateTo?: string;
}

// ─────────────────────── 角色权限域 ───────────────────────

export interface Role {
  id: string;
  roleKey: string;
  name: string;
  /** 级别：低级别不可管理高级别 */
  level: number;
  memberCount: number;
  isBuiltIn: boolean;
  isDefault?: boolean;
  description?: string;
  permissions: string[];
}

export type PermissionCategory = 'users_devices' | 'subscriptions_orders' | 'audit_security' | 'operations';

export interface Permission {
  permKey: string;
  name: string;
  category: PermissionCategory;
  description?: string;
  /** 仅 super_admin 可持有/管理 */
  superAdminOnly?: boolean;
}

// ─────────────────────── 配置与运营 ───────────────────────

export interface FeatureFlag {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface SystemConfig {
  key: string;
  name: string;
  value: string;
  description?: string;
  updatedAt?: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  audience: 'all' | 'pro_plus' | 'free';
  displayMode: 'once' | 'persistent';
  sentAt: string;
  deliveredCount?: number;
  clickedCount?: number;
}

export interface SendAnnouncementPayload {
  title: string;
  content: string;
  audience: Announcement['audience'];
  displayMode: Announcement['displayMode'];
}

// ───────────────────────── 看板聚合 ─────────────────────────

export interface DailyOrderStat {
  /** YYYY-MM-DD */
  date: string;
  /** 订单金额（元） */
  amount: number;
  /** 退款金额（元） */
  refund: number;
}

export interface PlanDistribution {
  plan: PlanKey;
  count: number;
}

export interface ChannelShare {
  channel: PaymentChannel;
  label: string;
  percent: number;
}

export type PendingItemType = 'payment' | 'subscription' | 'reconcile' | 'security';

export interface PendingItem {
  id: string;
  title: string;
  type: PendingItemType;
  target: string;
  occurredAt: string;
  actionLabel?: string;
  /** 点击跳转的路由 */
  actionTo?: string;
}

export interface OverviewKpis {
  totalUsers: number;
  weekNewUsers: number;
  weekGrowthRate: number;
  monthRevenue: number;
  revenueGrowthRate: number;
  refundRate: number;
  mrr: number;
  mrrYearlySharePercent: number;
  onlineDevices: number;
  devicesDelta: number;
  paidUsers: number;
  conversionRate: number;
  trialingUsers: number;
}

export interface OverviewData {
  /** 快照统计时间 */
  statsAt: string;
  kpis: OverviewKpis;
  orders14d: DailyOrderStat[];
  planDistribution: PlanDistribution[];
  channels: ChannelShare[];
  pendingItems: PendingItem[];
}

// ───────────────────────── 鉴权 ─────────────────────────

export interface LoginPayload {
  account: string;
  password: string;
  /** 6 位 TOTP 动态码 */
  totp: string;
}

export interface LoginResp {
  accessToken: string;
  refreshToken: string;
  account: string;
  nickname: string;
  /** 已知内置角色：super_admin / admin / user；自定义角色为 custom_* */
  roleKey: string;
  /** 权限键列表；super_admin 传 ['*'] */
  permissions: string[];
}

export interface RefreshPayload {
  refreshToken: string;
}

// ─────────────── T-A4 追加：订单查询扩展 + 对账报告（只增不改） ───────────────

/**
 * 订单状态筛选取值：原生 OrderStatus 之上扩展伪状态 refunding（退款处理中）。
 * 约定：已发起退款但资金尚未退回的订单 = status='refunded' 且 refundAmount=null；
 * 退款完成后 refundAmount 落为具体金额、进入「已退款」。
 * 后端 T-A3 实现 GET /orders 时需支持该取值。
 */
export type OrderStatusFilter = OrderStatus | 'all' | 'refunding';

/** 订单列表查询参数（status 含 refunding 伪状态） */
export interface OrderListQuery extends Omit<OrderListParams, 'status'> {
  status?: OrderStatusFilter;
}

/** 对账报告 · 单渠道行 */
export interface ReconciliationRow {
  channel: PaymentChannel;
  label: string;
  /** 已支付笔数（含事后退款订单） */
  paidCount: number;
  /** 成交额（元） */
  paidAmount: number;
  /** 退款额（元） */
  refundAmount: number;
}

/** 对账报告（GET /api/admin/reconciliation，日终对账快照） */
export interface ReconciliationReport {
  /** 快照生成时间，如 2026-09-05 02:00 */
  generatedAt: string;
  rows: ReconciliationRow[];
}

// ─────────────── T-A6 追加：审计筛选组 + 角色写操作（只增不改） ───────────────

/**
 * 审计动作筛选项（对照草图下拉）：
 * all=全部；auth=登录/登出（user.login* / user.logout*）；sensitive=敏感操作（前端判定规则）；
 * payment=支付相关（payment.* / admin.refund.*）；后端亦支持传具体 action 串做 includes 匹配。
 */
export type AuditActionFilter = 'all' | 'auth' | 'sensitive' | 'payment';

/** 审计操作者筛选项：end_user=终端用户（operatorRole=user，含打码手机号） */
export type AuditOperatorFilter = 'all' | 'Carlos' | 'Yuki' | 'end_user';

/** POST /api/admin/roles：创建自定义角色（roleKey 必须 custom_ 前缀，level 1–99） */
export interface CreateRolePayload {
  roleKey: string;
  name: string;
  level: number;
  description?: string;
}

/** PATCH /api/admin/roles/:id/permissions：整体保存角色权限键集合（写入审计） */
export interface UpdateRolePermissionsPayload {
  permissions: string[];
}

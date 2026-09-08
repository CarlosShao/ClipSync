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
/** users.registration_status：signup_waitlist 开关期间注册的用户为 waitlist（待管理员审批） */
export type RegistrationStatus = 'approved' | 'waitlist';
export type PlanKey = 'free' | 'pro' | 'enterprise';
/** user_subscriptions.status */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'expired' | 'trialing';
/** user_subscriptions.billing_cycle */
export type BillingCycle = 'monthly' | 'yearly';

export interface Subscription {
  plan: PlanKey;
  /** AF-10：订阅行 id（user_subscriptions.id）；无订阅行为 undefined */
  id?: string;
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
  registrationStatus: RegistrationStatus;
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
  status?: UserStatus | 'waitlist' | 'all';
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

export type PermissionCategory =
  | 'users_devices'
  | 'subscriptions_orders'
  | 'audit_security'
  | 'operations'
  /** RB-11：AI 工具能力组（ai.* 键，均非 superAdminOnly） */
  | 'ai';

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
  /** AN-09 消费方登记：null/缺省 = 暂无消费方（UI 打「未接入」角标，改了不生效） */
  consumer?: string | null;
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
  /** CO-35：真实已读触达数（admin_announcement_reads 回执聚合） */
  readCount?: number;
}

export interface SendAnnouncementPayload {
  title: string;
  content: string;
  audience: Announcement['audience'];
  displayMode: Announcement['displayMode'];
}

// ───────────────────────── 运维监控（CO-40/CO-41） ─────────────────────────

/** 单组件探针结果（db / redis；latencyMs 探测失败时为 null） */
export interface OpsProbe {
  ok: boolean;
  latencyMs: number | null;
}

/**
 * 应用层指标快照。核心三字段（requests/errors/p95）由 GET /api/admin/ops/overview 稳定下发；
 * 其余字段（p50/p99/wsConnections/uptimeSec/memory）视 metrics 采集器版本可选，渲染时须判空。
 */
export interface OpsMetrics {
  requests: number;
  errors: number;
  p95: number | null;
  p50?: number | null;
  p99?: number | null;
  wsConnections?: number | null;
  uptimeSec?: number | null;
  memory?: number | string | null;
}

/** GET /api/admin/ops/overview 响应（admin.ops.view 权限） */
export interface OpsOverview {
  /** db error → error；db ok 且 redis 不可用 → degraded；否则 ok */
  status: 'ok' | 'degraded' | 'error';
  version: string;
  /** process.uptime() 秒 */
  uptimeSec: number;
  db: OpsProbe;
  redis: OpsProbe;
  /** 进程内存（字节） */
  memory: { rss: number; heapUsed: number };
  metrics: OpsMetrics | null;
  /** AF-21：近 10 分钟趋势（服务端 30s 增量桶，最多 20 点；进程重启后为空数组，渲染须判空） */
  series?: OpsTrendPoint[];
  /** AF-30：Grafana 跳转地址（system_configs.grafana_url；空串 = 未配置，前端按钮置灰） */
  grafanaUrl?: string;
  /** CO-42：部署形态（后端探测；旧版本后端可能不返回，渲染须判空） */
  deployment?: OpsDeployment | null;
}

/** AF-21：趋势采样点（30s 窗口增量） */
export interface OpsTrendPoint {
  t: number;
  requests: number;
  errors: number;
}

/** CO-42：部署形态探测结果 */
export interface OpsDeployment {
  type: 'k8s' | 'docker-compose';
  /** k8s 副本数；探测不到为 null（docker-compose 无副本语义） */
  replicas?: number | null;
}

// ─────────────── CO-33/CO-41：备份概览 + 慢查询 ───────────────

/** 备份文件条目（GET /api/admin/ops/backups，备份目录扫描） */
export interface BackupFile {
  /** 文件名（含扩展名） */
  file: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 修改时间（ISO 字符串） */
  mtime: string;
  /** 备份类别（如 db / redis / uploads，由后端扫描目录划分） */
  kind: string;
}

/** 备份汇总行 */
export interface BackupsSummary {
  total: number;
  totalBytes: number;
  /** 最近一次备份时间（ISO 字符串；目录为空时为 null） */
  lastBackupAt: string | null;
}

/** GET /api/admin/ops/backups 响应（CO-33，admin.ops.view 权限） */
export interface OpsBackups {
  items: BackupFile[];
  summary: BackupsSummary;
}

/** 慢查询行（pg_stat_statements 聚合；query 服务端已截断至 200 字符） */
export interface SlowQueryRow {
  query: string;
  calls: number;
  /** 服务端格式化字符串，如 "12.34 ms" */
  totalExecTime: string;
  meanExecTime: string;
  rows: number;
  /** "99.12%" 或 "N/A" */
  hitPercent: string;
}

/** GET /api/admin/slow-queries 响应（admin.audit.view 权限） */
export interface SlowQueriesResp {
  slowQueries: SlowQueryRow[];
  poolStatus: {
    total: number;
    active: number;
    idle: number;
    idleInTransaction: number;
    poolSize: number;
    idlePool: number;
  } | null;
  /** 统计快照时间（ISO 字符串） */
  timestamp: string;
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

export type PendingItemType = 'payment' | 'subscription' | 'reconcile' | 'security' | 'approval';

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
  /** 真实后端登录（密码/验证码）暂不返回刷新令牌，401 时直接回登录页 */
  refreshToken: string | null;
  account: string;
  nickname: string;
  /** 已知内置角色：super_admin / admin / user；自定义角色为 custom_* */
  roleKey: string;
  /** 权限键列表；super_admin 传 ['*'] */
  permissions: string[];
}

/** GET /admin/whoami 响应（T-A1）——登录成功后取角色信息用 */
export interface WhoamiResp {
  userId: string;
  roleKey: string;
  roleLevel: number;
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

// ─────────────── T-A6 追加：设备管理 + 订阅管理（只增不改） ───────────────

/**
 * 管理端设备平台（页头平台分布徽章取 windows/macos/android/ios/linux 五类；
 * ipados/web 为扩展位；browser 为设备表 CHECK 约束的真实枚举值（迁移 001），
 * 与 web 同义——真实后端返回 browser，映射表两者都提供）。
 */
export type DevicePlatform =
  'windows' | 'macos' | 'android' | 'ios' | 'linux' | 'ipados' | 'web' | 'browser';

/** 设备形态 */
export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'browser';

/** 管理端设备行（GET /api/admin/devices；比用户抽屉的轻量 Device 多属主/版本字段） */
export interface AdminDevice {
  id: string;
  /** 设备名，如 DESKTOP-7A2 / Xiaomi 14 */
  name: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  /** 系统版本，如 Windows 11 / macOS 26 / Ubuntu 24.04 LTS */
  os: string;
  /** 客户端应用版本，如 1.4.2 */
  appVersion: string;
  ownerId: string;
  /** 属主昵称 */
  ownerNickname: string;
  /** 属主打码手机号 */
  ownerPhone: string;
  lastActiveAt: string | null;
  status: 'online' | 'offline';
}

export interface DeviceListParams extends ListParams {
  platform?: DevicePlatform | 'all';
  status?: 'online' | 'offline' | 'all';
}

/** GET /api/admin/devices/stats：设备页头统计 */
export interface DeviceStats {
  total: number;
  online: number;
  /** 平台分布（页头小徽章，count 之和 = total） */
  byPlatform: Array<{ platform: DevicePlatform; count: number }>;
}

/**
 * POST /api/admin/devices/:id/offline：远程下线（原因必填，写审计 admin.device.offline 敏感）。
 * 约定用 POST 而非 DELETE /devices/:id：下线为状态变更（设备记录保留），非删除资源。
 */
export interface DeviceOfflinePayload {
  reason: string;
}

/**
 * GET /api/admin/devices/:id/keys：设备公钥脱敏摘要（AF-43 / RB-02，admin.keys.view）。
 * 服务端只返回公钥 SHA-256 指纹，不含公钥原文或任何私钥。
 */
export interface DeviceKeysSummary {
  deviceId: string;
  hasPublicKey: boolean;
  /** public_key 的 SHA-256 前 16 位 hex；设备未上传公钥时为 null */
  fingerprint: string | null;
}

/** 管理端订阅行（GET /api/admin/subscriptions，与后端 mapSubscriptionRow 逐字段对齐） */
export interface AdminSubscription {
  id: string;
  userId: string;
  /** 用户摘要：昵称优先，否则打码手机号 */
  userLabel: string;
  planId: string;
  /** 套餐显示名（免费版/专业版/企业版） */
  planName: string;
  /** 套餐英文标识（Free/Pro/Enterprise） */
  planKey: string;
  billingCycle: BillingCycle | null;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  createdAt: string;
}

export interface SubscriptionListParams extends ListParams {
  plan?: PlanKey | 'all';
  status?: SubscriptionStatus | 'all';
}

/** GET /api/admin/subscriptions/stats：订阅页头统计 */
export interface SubscriptionStats {
  /** 生效中（status=active） */
  active: number;
  /** 试用中（status=trialing） */
  trialing: number;
  /** 本月到期：currentPeriodEnd 落在当前自然月（含 trialing/past_due 行） */
  expiringThisMonth: number;
}

/**
 * POST /api/admin/subscriptions/:id/grant：赠期 / 调整套餐（原因必填，写审计 admin.subscriptions.grant 敏感）。
 * 语义：plan ← planId；billingCycle ← monthly（赠期按月计）；currentPeriodEnd ← max(当前时间, 现周期止) + months；
 * status ← active。planId 仅接受 pro / enterprise（Free 无计费周期，不提供赠期）。
 */
export interface GrantSubscriptionPayload {
  planId: PlanKey;
  /** 延长月数 1–12 */
  months: number;
  reason: string;
}

// ─────────────── AN-01 追加：套餐与价格管理（只增不改） ───────────────

/**
 * 管理端套餐行（GET /api/admin/plans，与后端 mapPlanRow 逐字段对齐）。
 * 数值列（integer）在库中可为 NULL → 类型标 number | null，渲染须判空。
 * features 为 JSONB 对象：当前仅 ai_classify、team_management 在服务端有强制点。
 */
export interface AdminPlan {
  id: string;
  /** 套餐英文标识（Free / Pro / Enterprise，唯一键） */
  name: string;
  /** 套餐显示名（免费版 / 专业版 / 企业版） */
  displayName: string;
  description: string;
  priceMonthly: number | null;
  priceYearly: number | null;
  maxDevices: number | null;
  maxClipboardItems: number | null;
  maxFileSizeMb: number | null;
  maxStorageMb: number | null;
  /** 单次多文件数量上限（042 文件同步限额） */
  maxFilesPerClip: number | null;
  /** 文件条目保留天数（042 文件同步限额） */
  fileRetentionDays: number | null;
  features: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
}

/**
 * PATCH /api/admin/plans/:id 请求体：仅白名单字段，snake_case 与后端 FIELD_VALIDATORS 一致。
 * 只传出现变更的键；空 body 后端返回 400。
 */
export interface PlanPatchPayload {
  display_name?: string;
  description?: string | null;
  price_monthly?: number | null;
  price_yearly?: number | null;
  max_devices?: number;
  max_clipboard_items?: number;
  max_file_size_mb?: number;
  max_storage_mb?: number;
  max_files_per_clip?: number;
  file_retention_days?: number;
  features?: Record<string, unknown>;
  is_active?: boolean;
}

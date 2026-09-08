import { HttpResponse, delay, http } from 'msw';
import dayjs from 'dayjs';
import type {
  AdminDevice,
  AdminSubscription,
  Announcement,
  ApiResp,
  AuditLog,
  BackupFile,
  CreateRolePayload,
  DeviceStats,
  GrantSubscriptionPayload,
  LoginResp,
  Order,
  OverviewData,
  PageData,
  ReconciliationReport,
  Role,
  SlowQueriesResp,
  SubscriptionStats,
  UserDetail,
} from '@/api/types';
import { isSensitiveAction } from '@/pages/audit/sensitive';
import {
  mockAnnouncements,
  mockAuditLogs,
  mockConfigs,
  mockDevices,
  mockFlags,
  mockOrders,
  mockPermissions,
  mockRoles,
  mockSubscriptions,
  mockUserDevices,
  mockUsers,
} from '@/mocks/data';

/**
 * MSW handlers —— 覆盖 /api/auth/* 与 /api/admin/* 全量资源。
 * 数据形态与 api/types.ts 契约一致；行为对照视觉基线 admin-v2-light.html。
 */

const ok = <T>(data: T, message?: string): Response =>
  HttpResponse.json<ApiResp<T>>({ code: 0, data, ...(message ? { message } : {}) });

const fail = (status: number, code: number, message: string): Response =>
  HttpResponse.json<ApiErrorShape>({ code, message }, { status });

interface ApiErrorShape {
  code: number;
  message: string;
}

/** 演示 TOTP 动态码（对照草图 B） */
const VALID_TOTP = '482917';
const DEMO_ADMIN: LoginResp = {
  accessToken: 'mock-admin-access-token-20260905',
  refreshToken: 'mock-admin-refresh-token-20260905',
  account: 'carlos@clipstream.work',
  nickname: 'Carlos',
  roleKey: 'super_admin',
  permissions: ['*'],
};

function pageOf<T>(list: T[], page: number, pageSize: number, total?: number): PageData<T> {
  const start = (page - 1) * pageSize;
  return {
    list: list.slice(start, start + pageSize),
    total: total ?? list.length,
    page,
    pageSize,
  };
}

function numParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 写操作审计记录（unshift 到队首，敏感操作红底高亮） */
function pushAudit(
  action: string,
  resourceType: string,
  resourceId: string,
  details: string,
  sensitive = true,
): void {
  mockAuditLogs.unshift({
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    operator: 'Carlos',
    operatorRole: 'super_admin',
    userId: 'usr_carlos',
    action,
    resourceType,
    resourceId,
    details,
    ipAddress: '116.24.*.*',
    userAgent: 'ClipSync Admin',
    status: 'success',
    sensitive,
    createdAt: '2026-09-05 20:47:00',
  });
}

// ───────────────────────── 鉴权 ─────────────────────────
// T-A7 对齐真实契约：登录返回 { token, sessionId, user }，角色经 GET /admin/whoami 获取。

const DEMO_TOKEN = 'mock-admin-access-token-20260905';

function demoWhoami(): { userId: string; roleKey: string; roleLevel: number; permissions: string[] } {
  // RB-10 对齐真实契约：whoami 只返回 category='admin' 的权限键，super_admin 归一 ['*']
  return {
    userId: 'usr_carlos',
    roleKey: 'super_admin',
    roleLevel: 100,
    permissions: ['*'],
  };
}

const authHandlers = [
  http.post('/api/auth/login', async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as { email?: string; phone?: string; password?: string; totp?: string };
    const account = body.email ?? body.phone;
    if (!account || !body.password) {
      return fail(400, 40001, '请输入账号和密码');
    }
    // MSW 保留 TOTP 演练：填写时必须为 482917，留空放行（与真实链路的可选语义一致）
    if (body.totp && body.totp !== VALID_TOTP) {
      return fail(401, 40101, '两步验证码错误，请重新输入');
    }
    return ok(
      { token: DEMO_TOKEN, sessionId: 'mock-session', user: { id: 'usr_carlos', nickname: 'Carlos', email: account } },
      '登录成功',
    );
  }),

  http.post('/api/auth/send-code', async ({ request }) => {
    await delay(300);
    const body = (await request.json()) as { phone?: string };
    if (!body.phone || !/^\d{11}$/.test(body.phone)) {
      return fail(400, 40001, '请输入 11 位手机号');
    }
    return ok({ message: 'Verification code sent (MVP: 888888)' });
  }),

  http.post('/api/auth/verify-code', async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as { phone?: string; code?: string };
    if (!body.phone || !body.code) {
      return fail(400, 40001, '请输入手机号和验证码');
    }
    // 与真实 dev 后端一致的 MVP 固定码
    if (body.code !== '888888') {
      return fail(401, 40102, '验证码错误或已过期');
    }
    return ok({ token: DEMO_TOKEN, sessionId: 'mock-session', user: { id: 'usr_carlos', nickname: 'Carlos', phone: body.phone } });
  }),

  http.get('/api/admin/whoami', async () => {
    await delay(150);
    return ok(demoWhoami());
  }),

  http.post('/api/auth/refresh', async () => {
    await delay(120);
    return ok({ ...DEMO_ADMIN, accessToken: 'mock-admin-access-token-refreshed' });
  }),
];

// ───────────────────────── 看板聚合 ─────────────────────────

const overview: OverviewData = {
  statsAt: '2026-09-05 20:41',
  kpis: {
    totalUsers: 12847,
    weekNewUsers: 86,
    weekGrowthRate: 3.1,
    monthRevenue: 41286,
    revenueGrowthRate: 8.2,
    refundRate: 0.8,
    mrr: 12480,
    mrrYearlySharePercent: 41,
    onlineDevices: 348,
    devicesDelta: -12,
    paidUsers: 1243,
    conversionRate: 9.7,
    trialingUsers: 96,
  },
  orders14d: [
    // T-A4 修复：金额压回 ¥1,200–4,200 区间缓升走势（约 1800→3900），柱高与草图形态一致；
    // 其中 4 天含退款 ¥9.9–¥99（浅紫叠加只占柱底一小条）
    { date: '2026-08-23', amount: 1820, refund: 0 },
    { date: '2026-08-24', amount: 2050, refund: 0 },
    { date: '2026-08-25', amount: 1740, refund: 0 },
    { date: '2026-08-26', amount: 2280, refund: 39.6 },
    { date: '2026-08-27', amount: 2460, refund: 0 },
    { date: '2026-08-28', amount: 2210, refund: 0 },
    { date: '2026-08-29', amount: 2650, refund: 0 },
    { date: '2026-08-30', amount: 2480, refund: 9.9 },
    { date: '2026-08-31', amount: 2890, refund: 0 },
    { date: '2026-09-01', amount: 3120, refund: 0 },
    { date: '2026-09-02', amount: 2950, refund: 0 },
    { date: '2026-09-03', amount: 3460, refund: 99 },
    { date: '2026-09-04', amount: 3680, refund: 0 },
    { date: '2026-09-05', amount: 3920, refund: 19.8 },
  ],
  planDistribution: [
    { plan: 'free', count: 11604 },
    { plan: 'pro', count: 1052 },
    { plan: 'enterprise', count: 191 },
  ],
  channels: [
    { channel: 'wechat', label: '微信支付', percent: 64 },
    { channel: 'alipay', label: '支付宝', percent: 22 },
    { channel: 'stripe', label: 'Stripe', percent: 14 },
  ],
  pendingItems: [
    {
      id: 'pi_1',
      title: '退款申请待审核 × 2',
      type: 'payment',
      target: 'CS20260905172256 / CS202609041233',
      occurredAt: '2 小时前',
      actionLabel: '去处理',
      actionTo: '/orders',
    },
    {
      id: 'pi_2',
      title: '7 天试用即将到期用户 × 96',
      type: 'subscription',
      target: '试用转化待跟进',
      occurredAt: '每日 09:00 汇总',
      actionLabel: '查看名单',
      actionTo: '/users',
    },
    {
      id: 'pi_3',
      title: '对账差异 1 笔（Stripe）',
      type: 'reconcile',
      target: 'pi_3QkR7a… 金额差 ¥0.01',
      occurredAt: '今日 02:00',
      actionLabel: '查看详情',
      actionTo: '/orders',
    },
    {
      id: 'pi_4',
      title: '新设备异常登录 IP 群 × 1 用户',
      type: 'security',
      target: 'usr_2e91…（+86 159****8834）',
      occurredAt: '昨日 22:41',
      actionLabel: '审计日志',
      actionTo: '/audit',
    },
  ],
};

const overviewHandlers = [http.get('/api/admin/overview', async () => {
  await delay(200);
  return ok(overview);
})];

// ───────────────────────── 用户 ─────────────────────────

const usersHandlers = [
  http.get('/api/admin/users', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const plan = url.searchParams.get('plan');
    const status = url.searchParams.get('status');

    const filtered = mockUsers.filter((u) => {
      if (q && !u.nickname.includes(q) && !u.phone.includes(q) && !u.id.includes(q)) return false;
      if (plan && plan !== 'all' && u.subscription.plan !== plan) return false;
      if (status && status !== 'all' && u.status !== status) return false;
      return true;
    });

    // 无筛选时对齐草图：total = 12,847（第 1 页返回 8 条种子数据）
    const total = !q && (!plan || plan === 'all') && (!status || status === 'all') ? 12847 : filtered.length;
    return ok(pageOf(filtered, page, pageSize, total));
  }),

  http.get('/api/admin/users/:id', async ({ params }) => {
    await delay(150);
    const id = params['id'] as string;
    const user = mockUsers.find((u) => u.id === id);
    if (!user) return fail(404, 40404, '用户不存在');
    const devices = mockUserDevices[id] ?? [
      {
        id: 'dev_g1',
        name: `${user.nickname}-设备 1`,
        platform: 'Windows',
        os: 'Windows 11',
        status: 'online',
        lastActiveAt: user.lastActiveAt ?? null,
      },
      {
        id: 'dev_g2',
        name: `${user.nickname}-手机`,
        platform: 'Android',
        os: 'Android 15',
        status: 'offline',
        lastActiveAt: null,
      },
    ];
    const recentAuditLogs: AuditLog[] = mockAuditLogs
      .filter((a) => a.userId === id)
      .slice(0, 5);
    const detail: UserDetail = { user, devices, recentAuditLogs };
    return ok(detail);
  }),

  http.patch('/api/admin/users/:id/status', async ({ request, params }) => {
    await delay(300);
    const id = params['id'] as string;
    const body = (await request.json()) as { status?: string; reason?: string };
    const user = mockUsers.find((u) => u.id === id);
    if (!user) return fail(404, 40404, '用户不存在');
    if (body.status !== 'active' && body.status !== 'disabled') {
      return fail(400, 40002, 'status 取值不合法');
    }
    if (body.status === 'disabled' && !body.reason?.trim()) {
      return fail(400, 40003, '停用账号必须填写原因（写入审计日志）');
    }
    user.status = body.status;
    user.isActive = body.status === 'active';
    mockAuditLogs.unshift({
      id: `aud_${Date.now()}`,
      operator: 'Carlos',
      operatorRole: 'super_admin',
      userId: 'usr_carlos',
      action: body.status === 'disabled' ? 'user.deactivate' : 'user.activate',
      resourceType: 'user',
      resourceId: id,
      details: body.reason ? `reason="${body.reason}"` : '由管理员手动启用',
      ipAddress: '116.24.*.*',
      userAgent: 'ClipSync Admin',
      status: 'success',
      sensitive: body.status === 'disabled',
      createdAt: '2026-09-05 20:45:00',
    });
    return ok(user, body.status === 'disabled' ? '账号已停用' : '账号已启用');
  }),
];

// ───────────────────────── 订单 ─────────────────────────

/** 状态过滤：refunding 为伪状态 = 已发起退款但资金未退回（status='refunded' 且 refundAmount=null） */
function matchOrderStatus(order: Order, status: string): boolean {
  if (status === 'refunding') return order.status === 'refunded' && order.refundAmount === null;
  if (status === 'refunded') return order.status === 'refunded' && order.refundAmount !== null;
  return order.status === status;
}

const ordersHandlers = [
  http.get('/api/admin/orders', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const status = url.searchParams.get('status');
    const channel = url.searchParams.get('channel');
    const dateFrom = url.searchParams.get('dateFrom') ?? '';
    const dateTo = url.searchParams.get('dateTo') ?? '';

    const filtered = mockOrders.filter((o) => {
      if (
        q &&
        !o.orderNo.includes(q) &&
        !o.outTradeNo.includes(q) &&
        !(o.transactionId ?? '').includes(q)
      )
        return false;
      if (status && status !== 'all' && !matchOrderStatus(o, status)) return false;
      if (channel && channel !== 'all' && o.channel !== channel) return false;
      if (dateFrom && o.createdAt.slice(0, 10) < dateFrom) return false;
      if (dateTo && o.createdAt.slice(0, 10) > dateTo) return false;
      return true;
    });

    const total = !q && (!status || status === 'all') && (!channel || channel === 'all') ? 128 : filtered.length;
    return ok(pageOf(filtered, page, pageSize, total));
  }),

  http.get('/api/admin/orders/:orderNo', async ({ params }) => {
    await delay(120);
    const orderNo = params['orderNo'] as string;
    const order = mockOrders.find((o) => o.orderNo === orderNo);
    if (!order) return fail(404, 40404, '订单不存在');
    return ok(order);
  }),

  http.post('/api/admin/orders/:orderNo/refund', async ({ request, params }) => {
    await delay(400);
    const orderNo = params['orderNo'] as string;
    const order = mockOrders.find((o) => o.orderNo === orderNo);
    if (!order) return fail(404, 40404, '订单不存在');
    if (order.status !== 'paid') return fail(400, 40005, '仅已支付订单可退款');
    const body = (await request.json()) as { amount?: number; reason?: string };
    if (!body.reason?.trim()) return fail(400, 40003, '退款原因必填（写入审计日志）');
    const amount = Number(body.amount ?? order.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > order.amount) {
      return fail(400, 40006, '退款金额不合法');
    }
    order.status = 'refunded';
    order.refundAmount = amount;
    pushAudit(
      'admin.refund.execute',
      'payment_order',
      orderNo,
      `amount=${amount.toFixed(2)}, reason="${body.reason.trim()}"`,
    );
    return ok(order, '退款已提交');
  }),

  // 对账报告（日终快照，数据量级对照草图：本月 128 笔 · 成交 ¥41,286）
  http.get('/api/admin/reconciliation', async () => {
    await delay(200);
    const report: ReconciliationReport = {
      generatedAt: '2026-09-05 02:00',
      rows: [
        { channel: 'wechat', label: '微信支付', paidCount: 86, paidAmount: 28410.0, refundAmount: 119.6 },
        { channel: 'alipay', label: '支付宝', paidCount: 28, paidAmount: 9754.0, refundAmount: 0 },
        { channel: 'stripe', label: 'Stripe', paidCount: 14, paidAmount: 3122.0, refundAmount: 99.0 },
      ],
    };
    return ok(report);
  }),
];

// ───────────────────────── 审计 ─────────────────────────

/** 动作筛选：all=全部；auth=登录/登出；sensitive=敏感操作；payment=支付相关；其余按 includes 匹配具体 action */
function matchAuditAction(log: AuditLog, action: string): boolean {
  if (!action || action === 'all') return true;
  if (action === 'sensitive') return isSensitiveAction(log.action);
  if (action === 'auth') {
    return log.action.startsWith('user.login') || log.action.startsWith('user.logout');
  }
  if (action === 'payment') {
    return log.action.startsWith('payment.') || log.action.startsWith('admin.refund');
  }
  return log.action.includes(action);
}

/** 操作者筛选：end_user=终端用户（operatorRole=user）；其余按操作者名精确匹配 */
function matchAuditOperator(log: AuditLog, operator: string): boolean {
  if (!operator || operator === 'all') return true;
  if (operator === 'end_user') return log.operatorRole === 'user';
  return log.operator === operator;
}

const auditHandlers = [
  http.get('/api/admin/audit-logs', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const action = url.searchParams.get('action')?.trim() ?? '';
    const operator = url.searchParams.get('operator')?.trim() ?? '';
    const result = url.searchParams.get('result');
    const ip = url.searchParams.get('ip')?.trim() ?? '';
    const dateFrom = url.searchParams.get('dateFrom') ?? '';
    const dateTo = url.searchParams.get('dateTo') ?? '';

    const filtered = mockAuditLogs.filter((a) => {
      if (!matchAuditAction(a, action)) return false;
      if (!matchAuditOperator(a, operator)) return false;
      if (result && result !== 'all' && a.status !== result) return false;
      if (ip && !a.ipAddress.includes(ip)) return false;
      if (dateFrom && a.createdAt.slice(0, 10) < dateFrom) return false;
      if (dateTo && a.createdAt.slice(0, 10) > dateTo) return false;
      return true;
    });

    // 无任何筛选时对齐草图：total = 2,431,088（保留 1 年量级）
    const noFilter =
      !action && !operator && (!result || result === 'all') && !ip && !dateFrom && !dateTo;
    return ok(pageOf(filtered, page, pageSize, noFilter ? 2431088 : filtered.length));
  }),
];

// ─────────────────────── 角色与权限 ───────────────────────

const roleHandlers = [
  http.get('/api/admin/roles', async () => {
    await delay(150);
    return ok(mockRoles);
  }),
  http.get('/api/admin/permissions', async () => {
    await delay(120);
    return ok(mockPermissions);
  }),

  // 保存角色权限集合：super_admin 不可改（触发器保证超管唯一）；写审计 admin.roles.update（敏感）
  http.patch('/api/admin/roles/:id/permissions', async ({ request, params }) => {
    await delay(300);
    const id = params['id'] as string;
    const role = mockRoles.find((r) => r.id === id);
    if (!role) return fail(404, 40404, '角色不存在');
    if (role.roleKey === 'super_admin' || role.level >= 100) {
      return fail(403, 40301, '超级管理员权限不可修改（数据库触发器保证超管唯一）');
    }
    const body = (await request.json()) as { permissions?: unknown };
    if (
      !Array.isArray(body.permissions) ||
      body.permissions.some((key) => typeof key !== 'string')
    ) {
      return fail(400, 40002, 'permissions 必须为字符串数组');
    }
    const permissionSet = new Set(mockPermissions.map((p) => p.permKey));
    const unknown = (body.permissions as string[]).filter((key) => !permissionSet.has(key));
    if (unknown.length > 0) {
      return fail(400, 40007, `未知权限键：${unknown.join(', ')}`);
    }
    const before = role.permissions;
    const added = (body.permissions as string[]).filter((key) => !before.includes(key));
    const removed = before.filter((key) => !(body.permissions as string[]).includes(key));
    role.permissions = body.permissions as string[];
    pushAudit(
      'admin.roles.update',
      'role',
      role.roleKey,
      `role="${role.roleKey}", added=[${added.join('|')}], removed=[${removed.join('|')}]`,
    );
    return ok(role, '权限已保存并写入审计日志');
  }),

  // 创建自定义角色：role_key 必须 custom_ 前缀；级别 1–99（超管 level 100 不可创建）
  http.post('/api/admin/roles', async ({ request }) => {
    await delay(300);
    const body = (await request.json()) as Partial<CreateRolePayload>;
    if (!body.roleKey?.trim() || !body.name?.trim()) {
      return fail(400, 40002, '角色标识与名称不能为空');
    }
    if (!/^custom_[a-z0-9_]+$/.test(body.roleKey.trim())) {
      return fail(400, 40007, '角色标识必须以 custom_ 开头，仅含小写字母 / 数字 / 下划线');
    }
    if (mockRoles.some((r) => r.roleKey === body.roleKey?.trim())) {
      return fail(400, 40008, `角色标识 ${body.roleKey.trim()} 已存在`);
    }
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 1 || level >= 100) {
      return fail(400, 40009, '级别须为 1–99 的整数（超级管理员 level 100 由系统保留）');
    }
    const created: Role = {
      id: `role_${body.roleKey.trim()}`,
      roleKey: body.roleKey.trim(),
      name: body.name.trim(),
      level,
      memberCount: 0,
      isBuiltIn: false,
      description: body.description?.trim() || '自定义角色，可分配',
      permissions: [],
    };
    mockRoles.push(created);
    pushAudit(
      'admin.roles.create',
      'role',
      created.roleKey,
      `role_key="${created.roleKey}", name="${created.name}", level=${level}`,
    );
    return ok(created, '角色已创建');
  }),
];

// ─────────────────────── 配置 / 开关 / 公告 ───────────────────────

const configHandlers = [
  http.get('/api/admin/configs', async () => {
    await delay(120);
    return ok(mockConfigs);
  }),

  // 逐项 PATCH：maintenance_mode 必须带 reason（写入审计）；
  // CO-11/CO-41/CO-30：rate_limit_disabled 生产拒绝、log_level 白名单、smtp_pass 脱敏回显
  http.patch('/api/admin/configs/:key', async ({ request, params }) => {
    await delay(200);
    const key = params['key'] as string;
    const body = (await request.json()) as { value?: string; reason?: string };
    const config = mockConfigs.find((c) => c.key === key);
    if (!config) return fail(404, 40404, '配置项不存在');
    if (!body.value) return fail(400, 40002, 'value 不能为空');
    if (key === 'maintenance_mode' && !body.reason?.trim()) {
      return fail(400, 40003, '维护模式切换必须填写原因（写入审计日志）');
    }
    if (key === 'rate_limit_disabled' && body.value === 'true' && process.env.NODE_ENV === 'production') {
      return fail(400, 40002, '生产环境禁止关闭限流');
    }
    if (key === 'log_level' && !['debug', 'info', 'warn', 'error'].includes(body.value)) {
      return fail(400, 40002, 'log_level 仅允许 debug / info / warn / error');
    }
    // smtp_pass 写入加密存储，读取路径只回显配置状态（与 mapConfigRow 契约一致）
    config.value = key === 'smtp_pass' ? '已配置' : body.value;
    config.updatedAt = '2026-09-05 20:47';
    const details = body.reason?.trim()
      ? `value="${key === 'smtp_pass' ? '***' : body.value}", reason="${body.reason.trim()}"`
      : `value="${key === 'smtp_pass' ? '***' : body.value}"`;
    pushAudit('admin.config.update', 'system_config', key, details);
    return ok(config, key === 'maintenance_mode' ? '维护模式已更新' : '配置已更新并写入审计');
  }),

  http.get('/api/admin/flags', async () => {
    await delay(120);
    return ok(mockFlags);
  }),

  http.patch('/api/admin/flags/:key', async ({ request, params }) => {
    await delay(200);
    const key = params['key'] as string;
    const body = (await request.json()) as { enabled?: boolean };
    const flag = mockFlags.find((f) => f.key === key);
    if (!flag) return fail(404, 40404, '功能开关不存在');
    if (typeof body.enabled !== 'boolean') return fail(400, 40002, 'enabled 必须为布尔值');
    flag.enabled = body.enabled;
    pushAudit('admin.flag.update', 'feature_flag', key, `enabled=${body.enabled}`);
    return ok(flag, '开关已切换并写入审计');
  }),

  http.get('/api/admin/announcements', async () => {
    await delay(120);
    return ok(mockAnnouncements);
  }),

  http.post('/api/admin/announcements', async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as Partial<Announcement>;
    if (!body.title?.trim() || !body.content?.trim()) {
      return fail(400, 40002, '公告标题与内容不能为空');
    }
    const created: Announcement = {
      id: `ann_${Date.now()}`,
      title: body.title,
      content: body.content,
      audience: body.audience ?? 'all',
      displayMode: body.displayMode ?? 'once',
      sentAt: '2026-09-05 20:47',
      deliveredCount: 12102,
      readCount: 0,
      clickedCount: 0,
    };
    mockAnnouncements.unshift(created);
    pushAudit(
      'admin.announcement.send',
      'announcement',
      created.id,
      `title="${created.title}", audience=${created.audience}, display=${created.displayMode}`,
      true,
    );
    return ok(created, '公告已下发');
  }),

  // CO-30：SMTP 测试邮件。未配置 SMTP（smtp_host 为空或 smtp_pass 未配置）→ 409 错误壳 code=4090；
  // 收件人含 "fail" 模拟发送失败（5xx）；成功返回 messageId
  http.post('/api/admin/configs/smtp/test', async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as { to?: string };
    const smtpHost = mockConfigs.find((c) => c.key === 'smtp_host')?.value ?? '';
    const smtpPass = mockConfigs.find((c) => c.key === 'smtp_pass')?.value ?? '';
    if (!smtpHost.trim() || smtpPass === '未配置') {
      return fail(409, 4090, 'SMTP 尚未配置，请先在系统参数中填写 SMTP 服务器与授权码');
    }
    if (body.to?.includes('fail')) {
      return fail(500, 5001, 'SMTP 服务器连接超时，请检查端口与授权码');
    }
    const to = body.to?.trim() || 'admin@clipstream.work';
    return ok({ messageId: `<${Date.now()}@clipstream.work>` }, `测试邮件已发送至 ${to}`);
  }),
];

// ─────────────── CO-40/CO-41：运维监控 ───────────────

/** 运维概览 mock（admin.ops.view 权限）：健康探针 + 版本/运行时长 + 内存 + 请求指标 */
const opsHandlers = [
  http.get('/api/admin/ops/overview', async () => {
    await delay(150);
    return ok({
      status: 'ok',
      version: '0.2.0',
      uptimeSec: 3 * 86_400 + 7 * 3_600 + 42 * 60,
      db: { ok: true, latencyMs: 2 },
      redis: { ok: true, latencyMs: 1 },
      memory: { rss: 186_000_000, heapUsed: 92_000_000 },
      metrics: {
        requests: 128_402,
        errors: 371,
        p50: 12,
        p95: 86,
        p99: 154,
        wsConnections: 1_284,
        uptimeSec: 3 * 86_400 + 7 * 3_600 + 42 * 60,
        memory: '186MB',
      },
      // CO-42：部署形态（与 monitoring 栈 docker-compose 部署一致）
      deployment: { type: 'docker-compose', replicas: null },
    });
  }),

  // CO-33：备份文件概览（items 为目录扫描最近文件，summary 为全量汇总）
  http.get('/api/admin/ops/backups', async () => {
    await delay(150);
    const items: BackupFile[] = [
      { file: 'clipsync_db_20260905_0200.sql.gz', sizeBytes: 48_311_296, mtime: '2026-09-05T02:00:00+08:00', kind: 'db' },
      { file: 'uploads_20260905_0300.tar.gz', sizeBytes: 1_073_741_824, mtime: '2026-09-05T03:00:00+08:00', kind: 'uploads' },
      { file: 'redis_dump_20260905_0200.rdb', sizeBytes: 6_291_456, mtime: '2026-09-05T02:05:00+08:00', kind: 'redis' },
      { file: 'clipsync_db_20260904_0200.sql.gz', sizeBytes: 47_882_240, mtime: '2026-09-04T02:00:00+08:00', kind: 'db' },
      { file: 'clipsync_db_20260903_0200.sql.gz', sizeBytes: 47_185_920, mtime: '2026-09-03T02:00:00+08:00', kind: 'db' },
    ];
    return ok({
      items,
      summary: {
        total: 5,
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        lastBackupAt: '2026-09-05T03:00:00+08:00',
      },
    });
  }),

  // CO-41：慢查询 TOP（admin.audit.view 权限；行结构与 src/server/src/utils/query-monitor.js 逐字段一致）
  http.get('/api/admin/slow-queries', async () => {
    await delay(150);
    const data: SlowQueriesResp = {
      slowQueries: [
        {
          query: 'SELECT * FROM payment_orders WHERE user_id = $1 AND status IN (...) ORDER BY created_at DESC',
          calls: 1284,
          totalExecTime: '15678.90 ms',
          meanExecTime: '12.21 ms',
          rows: 42,
          hitPercent: '99.12%',
        },
        {
          query: 'UPDATE user_subscriptions SET status = $1, auto_renew = $2 WHERE id = $3',
          calls: 86,
          totalExecTime: '9420.00 ms',
          meanExecTime: '109.53 ms',
          rows: 1,
          hitPercent: '98.40%',
        },
      ],
      poolStatus: { total: 12, active: 2, idle: 9, idleInTransaction: 1, poolSize: 10, idlePool: 8 },
      timestamp: '2026-09-05T20:47:00.000Z',
    };
    return ok(data);
  }),
];

// ─────────────── T-A6 追加：设备管理 ───────────────

function collectDeviceStats(): DeviceStats {
  const counts = new Map<string, number>();
  for (const device of mockDevices) {
    counts.set(device.platform, (counts.get(device.platform) ?? 0) + 1);
  }
  return {
    total: mockDevices.length,
    online: mockDevices.filter((d) => d.status === 'online').length,
    byPlatform: [...counts.entries()].map(([platform, count]) => ({
      platform: platform as AdminDevice['platform'],
      count,
    })),
  };
}

const devicesHandlers = [
  http.get('/api/admin/devices/stats', async () => {
    await delay(120);
    return ok(collectDeviceStats());
  }),

  http.get('/api/admin/devices', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const platform = url.searchParams.get('platform');
    const status = url.searchParams.get('status');

    const filtered = mockDevices.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q.toLowerCase()) && !d.ownerNickname.includes(q) && !d.ownerPhone.includes(q) && !d.ownerId.includes(q)) {
        return false;
      }
      if (platform && platform !== 'all' && d.platform !== platform) return false;
      if (status && status !== 'all' && d.status !== status) return false;
      return true;
    });

    return ok(pageOf(filtered, page, pageSize));
  }),

  // 远程下线：仅在线设备可下线；原因必填，写审计 admin.device.offline（敏感）
  http.post('/api/admin/devices/:id/offline', async ({ request, params }) => {
    await delay(300);
    const id = params['id'] as string;
    const device = mockDevices.find((d) => d.id === id);
    if (!device) return fail(404, 40404, '设备不存在');
    if (device.status !== 'online') return fail(400, 40005, '仅在线设备可执行远程下线');
    const body = (await request.json()) as { reason?: string };
    if (!body.reason?.trim()) return fail(400, 40003, '远程下线必须填写原因（写入审计日志）');
    device.status = 'offline';
    device.lastActiveAt = '2026-09-05 20:47';
    pushAudit(
      'admin.device.offline',
      'device',
      device.id,
      `device="${device.name}", owner="${device.ownerNickname}", reason="${body.reason.trim()}"`,
    );
    return ok(device, '设备已远程下线');
  }),
];

// ─────────────── T-A6 追加：订阅管理 ───────────────

/** 「本月」以 mock 时间锚（2026-09）计，与种子数据的周期止日期保持同一宇宙 */
const MOCK_CURRENT_MONTH = '2026-09';

function collectSubscriptionStats(): SubscriptionStats {
  return {
    active: mockSubscriptions.filter((s) => s.status === 'active').length,
    trialing: mockSubscriptions.filter((s) => s.status === 'trialing').length,
    expiringThisMonth: mockSubscriptions.filter((s) =>
      Boolean(s.currentPeriodEnd?.startsWith(MOCK_CURRENT_MONTH)),
    ).length,
  };
}

/** 赠期落账：周期止 = max(当前时间, 现周期止) + months 个月（dayjs 日历月） */
function grantInPlace(sub: AdminSubscription, payload: GrantSubscriptionPayload): AdminSubscription {
  const now = dayjs();
  const current = sub.currentPeriodEnd ? dayjs(sub.currentPeriodEnd) : null;
  const base = current !== null && current.isAfter(now) ? current : now;
  sub.planKey = payload.planId === 'enterprise' ? 'Enterprise' : 'Pro';
  sub.planName = payload.planId === 'enterprise' ? '企业版' : '专业版';
  sub.billingCycle = 'monthly';
  sub.status = 'active';
  sub.currentPeriodEnd = base.add(payload.months, 'month').format('YYYY-MM-DD');
  // 同步 mockUsers 里的订阅摘要，保持用户页/订阅页数据一致
  const user = mockUsers.find((u) => u.id === sub.userId);
  if (user) {
    user.subscription.plan = payload.planId;
    user.subscription.billingCycle = sub.billingCycle;
    user.subscription.status = sub.status;
    user.subscription.currentPeriodEnd = sub.currentPeriodEnd;
    user.subscription.autoRenew = sub.autoRenew;
  }
  return sub;
}

const subscriptionsHandlers = [
  http.get('/api/admin/subscriptions/stats', async () => {
    await delay(120);
    return ok(collectSubscriptionStats());
  }),

  http.get('/api/admin/subscriptions', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const plan = url.searchParams.get('plan');
    const status = url.searchParams.get('status');

    const filtered = mockSubscriptions.filter((s) => {
      if (q && !s.userLabel.includes(q) && !s.userId.includes(q)) return false;
      if (plan && plan !== 'all' && s.planKey.toLowerCase() !== plan) return false;
      if (status && status !== 'all' && s.status !== status) return false;
      return true;
    });

    return ok(pageOf(filtered, page, pageSize));
  }),

  // 赠期 / 调整套餐：planId 仅接受 pro/enterprise；月数 1–12；原因必填并写审计（敏感）
  http.post('/api/admin/subscriptions/:id/grant', async ({ request, params }) => {
    await delay(300);
    const id = params['id'] as string;
    const sub = mockSubscriptions.find((s) => s.id === id);
    if (!sub) return fail(404, 40404, '订阅不存在');
    const body = (await request.json()) as Partial<GrantSubscriptionPayload>;
    if (body.planId !== 'pro' && body.planId !== 'enterprise') {
      return fail(400, 40002, '目标套餐仅支持 Pro / Enterprise（Free 无计费周期，不提供赠期）');
    }
    const months = Number(body.months);
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      return fail(400, 40002, '延长月数须为 1–12 的整数');
    }
    if (!body.reason?.trim()) return fail(400, 40003, '赠期原因必填（写入审计日志）');
    grantInPlace(sub, body as GrantSubscriptionPayload);
    pushAudit(
      'admin.subscriptions.grant',
      'user_subscription',
      sub.id,
      `user="${sub.userLabel}", plan=${sub.planKey}, months=${months}, reason="${body.reason.trim()}"`,
    );
    return ok(sub, `已为 ${sub.userLabel} 赠期 ${months} 个月`);
  }),
];

export const handlers = [
  ...authHandlers,
  ...overviewHandlers,
  ...usersHandlers,
  ...ordersHandlers,
  ...auditHandlers,
  ...roleHandlers,
  ...configHandlers,
  ...opsHandlers,
  ...devicesHandlers,
  ...subscriptionsHandlers,
];

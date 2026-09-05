import { HttpResponse, delay, http } from 'msw';
import type {
  Announcement,
  ApiResp,
  AuditLog,
  LoginResp,
  OverviewData,
  PageData,
  UserDetail,
} from '@/api/types';
import {
  mockAnnouncements,
  mockAuditLogs,
  mockConfigs,
  mockFlags,
  mockOrders,
  mockPermissions,
  mockRoles,
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

// ───────────────────────── 鉴权 ─────────────────────────

const authHandlers = [
  http.post('/api/auth/login', async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as { account?: string; password?: string; totp?: string };
    if (!body.account || !body.password) {
      return fail(400, 40001, '请输入账号和密码');
    }
    if (!body.totp || body.totp !== VALID_TOTP) {
      return fail(401, 40101, '两步验证码错误，请重新输入');
    }
    return ok(DEMO_ADMIN, '登录成功');
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
    { date: '2026-08-23', amount: 2600, refund: 80 },
    { date: '2026-08-24', amount: 3200, refund: 0 },
    { date: '2026-08-25', amount: 2300, refund: 0 },
    { date: '2026-08-26', amount: 3800, refund: 120 },
    { date: '2026-08-27', amount: 3000, refund: 0 },
    { date: '2026-08-28', amount: 4400, refund: 0 },
    { date: '2026-08-29', amount: 3500, refund: 0 },
    { date: '2026-08-30', amount: 5100, refund: 0 },
    { date: '2026-08-31', amount: 4200, refund: 0 },
    { date: '2026-09-01', amount: 5700, refund: 90 },
    { date: '2026-09-02', amount: 4800, refund: 0 },
    { date: '2026-09-03', amount: 6300, refund: 0 },
    { date: '2026-09-04', amount: 5500, refund: 110 },
    { date: '2026-09-05', amount: 7100, refund: 0 },
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
      sensitive: true,
      createdAt: '2026-09-05 20:45:00',
    });
    return ok(user, body.status === 'disabled' ? '账号已停用' : '账号已启用');
  }),
];

// ───────────────────────── 订单 ─────────────────────────

const ordersHandlers = [
  http.get('/api/admin/orders', async ({ request }) => {
    await delay(200);
    const url = new URL(request.url);
    const page = numParam(url, 'page', 1);
    const pageSize = numParam(url, 'pageSize', 10);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const status = url.searchParams.get('status');
    const channel = url.searchParams.get('channel');

    const filtered = mockOrders.filter((o) => {
      if (
        q &&
        !o.orderNo.includes(q) &&
        !o.outTradeNo.includes(q) &&
        !(o.transactionId ?? '').includes(q)
      )
        return false;
      if (status && status !== 'all' && o.status !== status) return false;
      if (channel && channel !== 'all' && o.channel !== channel) return false;
      return true;
    });

    const total = !q && (!status || status === 'all') && (!channel || channel === 'all') ? 128 : filtered.length;
    return ok(pageOf(filtered, page, pageSize, total));
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
    mockAuditLogs.unshift({
      id: `aud_${Date.now()}`,
      operator: 'Carlos',
      operatorRole: 'super_admin',
      userId: 'usr_carlos',
      action: 'admin.refund.execute',
      resourceType: 'payment_order',
      resourceId: orderNo,
      details: `amount=${amount.toFixed(2)}, reason="${body.reason}"`,
      ipAddress: '116.24.*.*',
      userAgent: 'ClipSync Admin',
      status: 'success',
      sensitive: true,
      createdAt: '2026-09-05 20:46:00',
    });
    return ok(order, '退款已提交');
  }),
];

// ───────────────────────── 审计 ─────────────────────────

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

    const filtered = mockAuditLogs.filter((a) => {
      if (action && action !== 'all' && !a.action.includes(action)) return false;
      if (operator && operator !== 'all' && !a.operator.includes(operator)) return false;
      if (result && result !== 'all' && a.status !== result) return false;
      if (ip && !a.ipAddress.includes(ip)) return false;
      return true;
    });

    const noFilter = !action && !operator && (!result || result === 'all') && !ip;
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
];

// ─────────────────────── 配置 / 开关 / 公告 ───────────────────────

const configHandlers = [
  http.get('/api/admin/configs', async () => {
    await delay(120);
    return ok(mockConfigs);
  }),

  http.patch('/api/admin/configs', async ({ request }) => {
    await delay(200);
    const body = (await request.json()) as { key?: string; value?: string };
    const config = mockConfigs.find((c) => c.key === body.key);
    if (!config) return fail(404, 40404, '配置项不存在');
    if (!body.value) return fail(400, 40002, 'value 不能为空');
    config.value = body.value;
    config.updatedAt = '2026-09-05 20:46';
    return ok(config, '配置已更新并写入审计');
  }),

  http.get('/api/admin/flags', async () => {
    await delay(120);
    return ok(mockFlags);
  }),

  http.patch('/api/admin/flags', async ({ request }) => {
    await delay(200);
    const body = (await request.json()) as { key?: string; enabled?: boolean };
    const flag = mockFlags.find((f) => f.key === body.key);
    if (!flag) return fail(404, 40404, '功能开关不存在');
    if (typeof body.enabled !== 'boolean') return fail(400, 40002, 'enabled 必须为布尔值');
    flag.enabled = body.enabled;
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
      sentAt: '2026-09-05 20:46',
      deliveredCount: 12102,
      clickedCount: 0,
    };
    mockAnnouncements.unshift(created);
    return ok(created, '公告已下发');
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
];

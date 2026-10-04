/**
 * Admin Console 数据看板聚合 API 单测（Admin Console · T-A1.5 补票）
 *
 * 覆盖（routes/admin/overview.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET /overview 返回 OverviewData 完整字段形态（statsAt/kpis/orders14d/planDistribution/channels/pendingItems）
 *  - kpis 13 项字段齐全且聚合口径可复算（转化率/周环比/退款率/MRR 年付占比/设备 delta）
 *  - orders14d 生成 SQL 使用 generate_series 补零 + 退款口径取 metadata.refund_amount
 *  - planDistribution / channels 固定三行（无数据补 0，percent 归一化）
 *  - 权限：requireRole(50) 门槛 —— admin 放行、普通 user 403
 *
 * 全离线：vi.mock db/pool + middleware/auth，pool.query 以 SQL 片段特征分发 mock 结果
 * （与 orders.test.js 同风格；构造行覆盖各聚合子查询）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => {
    if (authState.user) {
      req.user = { ...authState.user };
      req.userId = authState.user.userId;
    }
    next();
  }),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

// ── 夹具：各聚合子查询的构造行（量级对照 mocks/handlers.ts overview 宇宙） ──

const KPI_ROWS = {
  users: { total_users: 12847, week_new_users: 86, prev_week_new_users: 50 },
  revenue: {
    month_revenue: 41286,
    prev_month_revenue: 38160,
    paid_30d: 41286,
    refund_30d: 330.29,
  },
  mrr: { mrr_total: 12480.5, mrr_yearly_part: 5116.8 },
  devices: { online_devices: 348, online_prev_day: 360 },
  paid: { paid_users: 1243, trialing_users: 96 },
};

/** 近 14 天构造行（2026-08-23 → 2026-09-05，金额缓升 + 4 天含退款） */
function makeDailyRows() {
  const amounts = [1820, 2050, 1740, 2280, 2460, 2210, 2650, 2480, 2890, 3120, 2950, 3460, 3680, 3920];
  const refunds = [0, 0, 0, 39.6, 0, 0, 0, 9.9, 0, 0, 0, 99, 0, 19.8];
  return amounts.map((amount, i) => {
    const d = new Date(Date.UTC(2026, 7, 23) + i * 86400000);
    return {
      date: d.toISOString().slice(0, 10),
      amount,
      refund: refunds[i],
    };
  });
}

const PLAN_ROWS = [
  { plan: 'free', count: 11604 },
  { plan: 'pro', count: 1052 },
  { plan: 'enterprise', count: 191 },
];

const CHANNEL_ROWS = [
  { channel: 'wechat', cnt: 86 },
  { channel: 'alipay', cnt: 28 },
  { channel: 'stripe', cnt: 14 },
];

/**
 * 按 overview.js 各子查询的特征片段分发 mock 行；
 * overrides 按 { users, revenue, mrr, devices, paid, daily, plans, channels,
 *                waitlist, refunding, channelPaid, stalePending } 覆盖。
 */
function setupOverviewMocks(overrides = {}) {
  const rows = {
    users: KPI_ROWS.users,
    revenue: KPI_ROWS.revenue,
    mrr: KPI_ROWS.mrr,
    devices: KPI_ROWS.devices,
    paid: KPI_ROWS.paid,
    daily: makeDailyRows(),
    plans: PLAN_ROWS,
    channels: CHANNEL_ROWS,
    // 四类待办默认空 —— 新增分支不得命中上面的既有特征串，否则既有用例的
    // pendingItems === [] 断言会跟着变
    waitlist: [],
    refunding: [],
    channelPaid: [],
    stalePending: [],
    ...overrides,
  };
  const wrap = (row) => ({ rows: Array.isArray(row) ? row : [row], rowCount: Array.isArray(row) ? row.length : 1 });
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('week_new_users')) return wrap(rows.users);
    if (sql.includes('month_revenue')) return wrap(rows.revenue);
    if (sql.includes('mrr_total')) return wrap(rows.mrr);
    if (sql.includes('online_devices')) return wrap(rows.devices);
    if (sql.includes('paid_users')) return wrap(rows.paid);
    if (sql.includes('generate_series')) return wrap(rows.daily);
    if (sql.includes("ELSE 'free'")) return wrap(rows.plans);
    if (sql.includes('AS cnt')) return wrap(rows.channels);
    if (sql.includes("registration_status = 'pending'")) return wrap(rows.waitlist);
    if (sql.includes("metadata->>'refund_amount' IS NULL")) return wrap(rows.refunding);
    // 9.3 / 9.4 是两条不同 SQL：前者用 = 'true'，后者用 COALESCE(...) <> 'true'
    if (sql.includes("metadata->>'channel_reports_paid' = 'true'")) return wrap(rows.channelPaid);
    if (sql.includes("COALESCE(metadata->>'channel_reports_paid', 'false') <> 'true'")) {
      return wrap(rows.stalePending);
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

describe('GET /api/admin/overview —— 看板聚合', () => {
  it('返回 OverviewData 全部顶层字段，形态与前端契约逐字段一致', async () => {
    setupOverviewMocks();

    const res = await request(buildApp()).get('/api/admin/overview');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;

    expect(data.statsAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // kpis 13 项字段齐全
    expect(Object.keys(data.kpis).sort()).toEqual(
      [
        'conversionRate',
        'devicesDelta',
        'monthRevenue',
        'mrr',
        'mrrYearlySharePercent',
        'onlineDevices',
        'paidUsers',
        'refundRate',
        'revenueGrowthRate',
        'totalUsers',
        'trialingUsers',
        'weekGrowthRate',
        'weekNewUsers',
      ].sort()
    );

    // orders14d：14 天每日 { date, amount, refund }
    expect(data.orders14d).toHaveLength(14);
    for (const day of data.orders14d) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.amount).toBe('number');
      expect(typeof day.refund).toBe('number');
    }
    expect(data.orders14d[0]).toEqual({ date: '2026-08-23', amount: 1820, refund: 0 });
    expect(data.orders14d[13]).toEqual({ date: '2026-09-05', amount: 3920, refund: 19.8 });

    // planDistribution / channels 固定三行
    expect(data.planDistribution).toEqual([
      { plan: 'free', count: 11604 },
      { plan: 'pro', count: 1052 },
      { plan: 'enterprise', count: 191 },
    ]);
    expect(data.channels).toEqual([
      { channel: 'wechat', label: '微信支付', percent: 67 },
      { channel: 'alipay', label: '支付宝', percent: 22 },
      { channel: 'stripe', label: 'Stripe', percent: 11 },
    ]);

    // 待处理事项：真实待办逻辑后续迭代，先返回空数组
    expect(data.pendingItems).toEqual([]);
  });

  it('KPI 聚合口径可复算（转化率/周环比/月环比/退款率/MRR 年付占比/设备 delta）', async () => {
    setupOverviewMocks();

    const res = await request(buildApp()).get('/api/admin/overview');
    const k = res.body.data.kpis;

    expect(k.totalUsers).toBe(12847);
    expect(k.weekNewUsers).toBe(86);
    // (86 - 50) / 50 * 100 = 72
    expect(k.weekGrowthRate).toBe(72);
    expect(k.monthRevenue).toBe(41286);
    // (41286 - 38160) / 38160 * 100 ≈ 8.2
    expect(k.revenueGrowthRate).toBe(8.2);
    // 330.29 / 41286 * 100 ≈ 0.8
    expect(k.refundRate).toBe(0.8);
    expect(k.mrr).toBe(12480.5);
    // 5116.8 / 12480.5 ≈ 41%
    expect(k.mrrYearlySharePercent).toBe(41);
    expect(k.onlineDevices).toBe(348);
    // 348 - 360 = -12（无历史快照表：以 24~48h 前活跃数为基线）
    expect(k.devicesDelta).toBe(-12);
    expect(k.paidUsers).toBe(1243);
    // 1243 / 12847 * 100 ≈ 9.7
    expect(k.conversionRate).toBe(9.7);
    expect(k.trialingUsers).toBe(96);
  });

  it('orders14d 使用 generate_series 补零（近 14 天窗口），退款口径取 metadata.refund_amount', async () => {
    setupOverviewMocks();

    await request(buildApp()).get('/api/admin/overview');

    const [dailySql] = pool.query.mock.calls.find(([s]) => s.includes('generate_series'));
    expect(dailySql).toContain("CURRENT_DATE - INTERVAL '13 days'");
    expect(dailySql).toContain("CURRENT_DATE, INTERVAL '1 day'");
    expect(dailySql).toContain("metadata->>'refund_amount'");
    expect(dailySql).toContain("po.status IN ('paid', 'refunded')");

    const [planSql] = pool.query.mock.calls.find(([s]) => s.includes("ELSE 'free'"));
    expect(planSql).toContain('current_subscription_id');

    const [channelSql] = pool.query.mock.calls.find(([s]) => s.includes('AS cnt'));
    expect(channelSql).toContain("INTERVAL '30 days'");
    expect(channelSql).toContain("po.status IN ('paid', 'refunded')");
  });

  it('空库兜底：全部聚合无数据时返回 0 值 KPI 与空分布（不抛错）', async () => {
    setupOverviewMocks({
      users: { total_users: 0, week_new_users: 0, prev_week_new_users: 0 },
      revenue: { month_revenue: 0, prev_month_revenue: 0, paid_30d: 0, refund_30d: 0 },
      mrr: { mrr_total: 0, mrr_yearly_part: 0 },
      devices: { online_devices: 0, online_prev_day: 0 },
      paid: { paid_users: 0, trialing_users: 0 },
      daily: [],
      plans: [],
      channels: [],
    });

    const res = await request(buildApp()).get('/api/admin/overview');

    expect(res.status).toBe(200);
    expect(res.body.data.kpis).toMatchObject({
      totalUsers: 0,
      weekGrowthRate: 0,
      conversionRate: 0,
      refundRate: 0,
      mrr: 0,
      mrrYearlySharePercent: 0,
      devicesDelta: 0,
    });
    expect(res.body.data.orders14d).toHaveLength(0);
    expect(res.body.data.planDistribution).toEqual([
      { plan: 'free', count: 0 },
      { plan: 'pro', count: 0 },
      { plan: 'enterprise', count: 0 },
    ]);
    expect(res.body.data.channels).toEqual([
      { channel: 'wechat', label: '微信支付', percent: 0 },
      { channel: 'alipay', label: '支付宝', percent: 0 },
      { channel: 'stripe', label: 'Stripe', percent: 0 },
    ]);
  });

  it('待办跳转带订单号：7 天窗口外的目标单也能被定位（异常到账/退款处理中/超 24h 待支付）', async () => {
    setupOverviewMocks({
      waitlist: [{ id: 'u-1', label: '135****0772', created_at: new Date('2026-09-30T01:02:00Z') }],
      refunding: [{ order_no: 'ORD-REFUNDING', amount: 9.9, updated_at: new Date('2026-09-30T01:02:00Z') }],
      channelPaid: [{ order_no: 'ORD-CHANNEL-PAID', amount: 99, updated_at: new Date('2026-10-01T03:04:00Z') }],
      stalePending: [{ order_no: 'ORD-STALE', amount: 19.9, created_at: new Date('2026-09-01T00:00:00Z') }],
    });

    const res = await request(buildApp()).get('/api/admin/overview');
    const items = res.body.data.pendingItems;
    const byTitle = (title) => items.find((i) => i.title === title);

    // 订单页默认只看近 7 天：待办若不带上单号，超窗口的单点进去根本看不到
    expect(byTitle('异常到账：渠道已付款但订单未履约').actionTo).toBe(
      '/orders?status=pending&q=ORD-CHANNEL-PAID'
    );
    expect(byTitle('退款处理中').actionTo).toBe('/orders?status=refunding&q=ORD-REFUNDING');
    expect(byTitle('待支付订单超 24 小时').actionTo).toBe('/orders?status=pending&q=ORD-STALE');
    // 用户页没有时间窗口，保持原样不带 q
    expect(byTitle('用户等待审核').actionTo).toBe('/users?status=waitlist');

    // 异常到账必须从「待支付超 24 小时」里排除，否则同一单以误导性标题重复出现
    const [staleSql] = pool.query.mock.calls.find(([s]) =>
      s.includes("COALESCE(metadata->>'channel_reports_paid'")
    );
    expect(staleSql).toContain("<> 'true'");
  });

  it('权限：requireRole(50) 门槛 —— admin 放行，普通 user 返回 403 { code: 4030 }', async () => {
    setupOverviewMocks();
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const ok = await request(buildApp()).get('/api/admin/overview');
    expect(ok.status).toBe(200);

    authState.user = { userId: 'u-normal', roleKey: 'user', roleLevel: 10, isAdmin: false };
    const denied = await request(buildApp()).get('/api/admin/overview');
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ code: 4030, message: '权限不足' });
  });
});

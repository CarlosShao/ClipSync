import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { setupServer } from 'msw/node';
import dayjs from 'dayjs';
import { handlers } from '@/mocks/handlers';
import { mockAuditLogs, mockDevices, mockOrders, mockSubscriptions } from '@/mocks/data';
import type {
  AdminDevice,
  AdminSubscription,
  ApiErrorBody,
  ApiResp,
  DeviceStats,
  PageData,
  SubscriptionStats,
} from '@/api/types';

/**
 * T-A6 设备/订阅页 mock API 行为测试：
 * 设备列表筛选/统计/远程下线（原因必填+审计）与订阅列表筛选/统计/赠期（校验+审计）。
 */

// handlers 中的相对路径（'/api/admin/...'）在浏览器由 location.origin 解析；
// node 环境无 location，需在 handlers 模块求值前补齐（等价浏览器 baseURI）。
vi.hoisted(() => {
  (globalThis as unknown as { location: URL }).location = new URL('http://localhost');
});

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type Resp<T> = { status: number; body: ApiResp<T> | ApiErrorBody };

const get = async <T>(path: string): Promise<Resp<T>> => {
  const resp = await fetch(`http://localhost${path}`);
  return { status: resp.status, body: (await resp.json()) as ApiResp<T> | ApiErrorBody };
};

const post = async <T>(path: string, body: unknown): Promise<Resp<T>> => {
  const resp = await fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: (await resp.json()) as ApiResp<T> | ApiErrorBody };
};

/** 断言成功壳并返回 data（错误壳则让测试失败并带出错误信息） */
function expectOk<T>(resp: Resp<T>): ApiResp<T> {
  if (!('data' in resp.body)) {
    throw new Error(`期望成功响应，实际错误壳：${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

/** 断言错误壳并返回 { code, message } */
function expectFail<T>(resp: Resp<T>): ApiErrorBody {
  if ('data' in resp.body) {
    throw new Error(`期望错误响应，实际成功壳：${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

describe('GET /api/admin/devices（设备页契约）', () => {
  test('种子 ≥12 台、覆盖 5 平台、含在线与离线', async () => {
    const { data } = expectOk(await get<PageData<AdminDevice>>('/api/admin/devices?page=1&pageSize=50'));
    expect(data.total).toBeGreaterThanOrEqual(12);
    const platforms = new Set(data.list.map((d) => d.platform));
    for (const p of ['windows', 'macos', 'android', 'ios', 'linux']) {
      expect(platforms.has(p as AdminDevice['platform'])).toBe(true);
    }
    expect(data.list.some((d) => d.status === 'online')).toBe(true);
    expect(data.list.some((d) => d.status === 'offline')).toBe(true);
    for (const device of data.list) {
      expect(device.ownerPhone).toContain('*');
      expect(device.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test('平台 + 状态组合筛选与关键词搜索（设备名/属主）生效', async () => {
    const byPlatform = expectOk(
      await get<PageData<AdminDevice>>('/api/admin/devices?platform=macos&pageSize=50'),
    ).data;
    expect(byPlatform.total).toBeGreaterThan(0);
    for (const device of byPlatform.list) expect(device.platform).toBe('macos');

    const byStatus = expectOk(
      await get<PageData<AdminDevice>>('/api/admin/devices?status=online&platform=windows&pageSize=50'),
    ).data;
    for (const device of byStatus.list) {
      expect(device.platform).toBe('windows');
      expect(device.status).toBe('online');
    }

    const byName = expectOk(await get<PageData<AdminDevice>>('/api/admin/devices?q=Xiaomi')).data;
    expect(byName.total).toBe(1);
    expect(byName.list[0]?.name).toBe('Xiaomi 14');

    const byOwner = expectOk(await get<PageData<AdminDevice>>('/api/admin/devices?q=Sylvia')).data;
    expect(byOwner.total).toBeGreaterThan(0);
    for (const device of byOwner.list) expect(device.ownerNickname).toBe('Sylvia W.');
  });
});

describe('GET /api/admin/devices/stats + 远程下线', () => {
  test('统计：平台计数之和 = total，online ≤ total', async () => {
    const { data } = expectOk(await get<DeviceStats>('/api/admin/devices/stats'));
    const platformSum = data.byPlatform.reduce((sum, p) => sum + p.count, 0);
    expect(platformSum).toBe(data.total);
    expect(data.online).toBeLessThanOrEqual(data.total);
  });

  test('远程下线成功：置离线 + 写审计 admin.device.offline（敏感）', async () => {
    const online = mockDevices.find((d) => d.status === 'online');
    expect(online).toBeDefined();
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<AdminDevice>(`/api/admin/devices/${online?.id}/offline`, { reason: '疑似被盗号（测试）' }),
    );
    expect(data.status).toBe('offline');
    expect(mockDevices.find((d) => d.id === online?.id)?.status).toBe('offline');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.device.offline');
    expect(mockAuditLogs[0]?.sensitive).toBe(true);
    expect(mockAuditLogs[0]?.details).toContain('reason="疑似被盗号（测试）"');
  });

  test('离线设备重复下线返回 400；缺原因返回 400', async () => {
    const offline = mockDevices.find((d) => d.status === 'offline');
    const repeat = await post<AdminDevice>(`/api/admin/devices/${offline?.id}/offline`, {
      reason: '重复下线',
    });
    expect(repeat.status).toBe(400);
    expect(expectFail(repeat).code).toBe(40005);

    const online = mockDevices.find((d) => d.status === 'online');
    const noReason = await post<AdminDevice>(`/api/admin/devices/${online?.id}/offline`, {});
    expect(noReason.status).toBe(400);
    expect(expectFail(noReason).code).toBe(40003);
  });
});

describe('GET /api/admin/subscriptions（订阅页契约）', () => {
  test('种子 ≥10 条，状态混合，手机号打码', async () => {
    const { data } = expectOk(
      await get<PageData<AdminSubscription>>('/api/admin/subscriptions?page=1&pageSize=50'),
    );
    expect(data.total).toBeGreaterThanOrEqual(10);
    const statuses = new Set(data.list.map((s) => s.status));
    expect(statuses.has('active')).toBe(true);
    expect(statuses.has('trialing')).toBe(true);
    expect(statuses.has('past_due')).toBe(true);
    expect(statuses.has('canceled')).toBe(true);
    for (const sub of data.list) {
      expect(sub.userLabel).toBeTruthy();
    }
  });

  test('状态与套餐筛选生效', async () => {
    const trialing = expectOk(
      await get<PageData<AdminSubscription>>('/api/admin/subscriptions?status=trialing&pageSize=50'),
    ).data;
    expect(trialing.total).toBeGreaterThanOrEqual(1);
    for (const sub of trialing.list) expect(sub.status).toBe('trialing');

    const proActive = expectOk(
      await get<PageData<AdminSubscription>>('/api/admin/subscriptions?plan=pro&status=active&pageSize=50'),
    ).data;
    for (const sub of proActive.list) {
      expect(sub.planKey.toLowerCase()).toBe('pro');
      expect(sub.status).toBe('active');
    }

    const byLabel = expectOk(
      await get<PageData<AdminSubscription>>('/api/admin/subscriptions?q=刘晓蕾'),
    ).data;
    expect(byLabel.total).toBe(1);
    expect(byLabel.list[0]?.userLabel).toBe('刘晓蕾');
  });
});

describe('GET /api/admin/subscriptions/stats + 赠期', () => {
  test('统计：活跃/试用/本月到期与种子数据一致', async () => {
    const { data } = expectOk(await get<SubscriptionStats>('/api/admin/subscriptions/stats'));
    expect(data.active).toBe(mockSubscriptions.filter((s) => s.status === 'active').length);
    expect(data.trialing).toBe(mockSubscriptions.filter((s) => s.status === 'trialing').length);
    expect(
      data.expiringThisMonth,
    ).toBe(mockSubscriptions.filter((s) => s.currentPeriodEnd?.startsWith('2026-09')).length);
    expect(data.active).toBe(5);
    expect(data.trialing).toBe(2);
  });

  test('赠期成功：套餐/周期/状态落账 + 同步用户摘要 + 写审计 admin.subscriptions.grant（敏感）', async () => {
    // 选现周期止远在未来（2026-12-08）的订阅：base=现周期止，结果可确定性断言
    const target = mockSubscriptions.find((s) => s.id === 'sub_03');
    expect(target?.currentPeriodEnd).toBe('2026-12-08');
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<AdminSubscription>('/api/admin/subscriptions/sub_03/grant', {
        planId: 'enterprise',
        months: 3,
        reason: '大客户补偿（测试）',
      }),
    );
    expect(data.planKey.toLowerCase()).toBe('enterprise');
    expect(data.status).toBe('active');
    expect(data.billingCycle).toBe('monthly');
    expect(data.currentPeriodEnd).toBe('2027-03-08');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.subscriptions.grant');
    expect(mockAuditLogs[0]?.sensitive).toBe(true);
    expect(mockAuditLogs[0]?.details).toContain('months=3');
  });

  test('赠期校验：planId=free / 月数越界 / 缺原因均返回 400', async () => {
    const freePlan = await post<AdminSubscription>('/api/admin/subscriptions/sub_01/grant', {
      planId: 'free',
      months: 1,
      reason: 'x',
    });
    expect(freePlan.status).toBe(400);
    expect(expectFail(freePlan).code).toBe(40002);

    const badMonths = await post<AdminSubscription>('/api/admin/subscriptions/sub_01/grant', {
      planId: 'pro',
      months: 13,
      reason: 'x',
    });
    expect(badMonths.status).toBe(400);

    const noReason = await post<AdminSubscription>('/api/admin/subscriptions/sub_01/grant', {
      planId: 'pro',
      months: 1,
    });
    expect(noReason.status).toBe(400);
    expect(expectFail(noReason).code).toBe(40003);
  });
});

/**
 * 收回权益（2026-10-05 新增端点的 mock 行为）。
 *
 * 这个 handler 必须存在，原因不只是"mock 里按钮能用"：MSW 用的是
 * `onUnhandledRequest: 'bypass'`，**没有 handler 的请求会真的打到 vite proxy 的目标**，
 * 而本机联调时那个目标是生产 —— 等于"标着 MOCK 数据的界面上点了会真写生产"。
 *
 * 种子数据刻意覆盖两条分支，好让本机也能看到保护闸：
 *   sub_01 的用户有已付订单 ⇒ 必须被拒；sub_11 / sub_12 的用户没有任何订单 ⇒ 可收回。
 */
describe('POST /api/admin/subscriptions/:id/revoke（收回权益）', () => {
  test('★有已付订单 → 409 且订阅状态不变、不写审计（保护闸）', async () => {
    const sub = mockSubscriptions.find((s) => s.id === 'sub_01')!;
    // 前提自证：这条订阅的用户确实有已付订单，否则本用例测的不是保护闸
    const paidCount = mockOrders.filter(
      (o) => o.userId === sub.userId && o.status === 'paid',
    ).length;
    expect(paidCount).toBeGreaterThan(0);

    const statusBefore = sub.status;
    const auditBefore = mockAuditLogs.length;

    const resp = await post<AdminSubscription>('/api/admin/subscriptions/sub_01/revoke', {
      reason: '误发赠期，尝试收回',
    });

    expect(resp.status).toBe(409);
    const err = expectFail(resp);
    expect(err.message).toContain('已支付订单');
    // 必须把人引导到退款，而不是让人以为是参数错
    expect(err.message).toContain('退款');
    // 核心反例：不能"先撤了再说"
    expect(mockSubscriptions.find((s) => s.id === 'sub_01')!.status).toBe(statusBefore);
    expect(mockAuditLogs.length).toBe(auditBefore);
  });

  test('无已付订单 + immediate（默认）→ 置 canceled 且写审计 admin.subscriptions.revoke', async () => {
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<AdminSubscription & { revokedMode: string }>(
        '/api/admin/subscriptions/sub_11/revoke',
        { reason: '误发赠期' },
      ),
    );

    expect(data.revokedMode).toBe('immediate');
    expect(mockSubscriptions.find((s) => s.id === 'sub_11')!.status).toBe('canceled');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.subscriptions.revoke');
    expect(mockAuditLogs[0]?.details).toContain('mode=immediate');
    // 审计里要能看出"没没收付费权益"
    expect(mockAuditLogs[0]?.details).toContain('paidOrders=0');
  });

  test('period_end → 200 但**不置 canceled**（权益保留到到期）', async () => {
    const { data } = expectOk(
      await post<AdminSubscription & { revokedMode: string }>(
        '/api/admin/subscriptions/sub_12/revoke',
        { reason: '到期后不再续', mode: 'period_end' },
      ),
    );
    expect(data.revokedMode).toBe('period_end');
    const sub = mockSubscriptions.find((s) => s.id === 'sub_12')!;
    expect(sub.status).toBe('active');
    expect(sub.autoRenew).toBe(false);
  });

  test('缺原因 / 原因超长 / mode 非法 → 400；已终止的订阅 → 409', async () => {
    expect((await post('/api/admin/subscriptions/sub_11/revoke', {})).status).toBe(400);
    expect(
      (await post('/api/admin/subscriptions/sub_11/revoke', { reason: 'x'.repeat(201) })).status,
    ).toBe(400);
    expect(
      (await post('/api/admin/subscriptions/sub_11/revoke', { reason: 'ok', mode: 'whenever' }))
        .status,
    ).toBe(400);

    // sub_10 种子里就是 canceled
    const terminated = await post('/api/admin/subscriptions/sub_10/revoke', { reason: 'ok' });
    expect(terminated.status).toBe(409);
    expect(expectFail(terminated).code).toBe(40904);

    const notFound = await post('/api/admin/subscriptions/sub_nope/revoke', { reason: 'ok' });
    expect(notFound.status).toBe(404);
  });

  /**
   * mode=shorten_to_paid_end（2026-10-05）：只收回「多给的那段」。
   *
   * 注意：本文件前面的「赠期」用例已经动过 sub_03（把它改成 monthly），所以这里
   * **显式设置** billingCycle 与周期起止，让用例与执行顺序无关；日期也都相对"现在"算，
   * 避免随真实时钟漂移而翻车。
   */
  test('收窄到付费终点：到期日改为「周期开始 + 已付订单数 × 周期」，订阅仍 active', async () => {
    const sub = mockSubscriptions.find((s) => s.id === 'sub_03')!;
    const now = dayjs();
    sub.billingCycle = 'yearly';
    sub.currentPeriodStart = now.subtract(5, 'day').format('YYYY-MM-DD');
    sub.currentPeriodEnd = now.add(800, 'day').format('YYYY-MM-DD');
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<AdminSubscription & { paidOrders: number; shortenedTo: string }>(
        '/api/admin/subscriptions/sub_03/revoke',
        { reason: '误赠一年，收窄回付费终点', mode: 'shorten_to_paid_end' },
      ),
    );

    // 周期是 yearly ⇒ 付费终点 = 开始 + 1 年
    expect(data.paidOrders).toBe(1);
    expect(data.shortenedTo).toBe(now.subtract(5, 'day').add(1, 'year').format('YYYY-MM-DD'));
    // ★仍是 active（用户付过钱的那段还在）
    expect(sub.status).toBe('active');
    expect(sub.autoRenew).toBe(false);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    // 审计用独立 action，别和"收回"混在一起
    expect(mockAuditLogs[0]?.action).toBe('admin.subscriptions.shorten');
  });

  test('收窄到付费终点：无已付订单 → 409 且提示改用「立即收回」', async () => {
    const sub = mockSubscriptions.find((s) => s.id === 'sub_09')!; // 该用户没有任何订单
    const noPaid = mockOrders.filter((o) => o.userId === sub.userId && o.status === 'paid').length;
    expect(noPaid).toBe(0); // 前提自证

    const resp = await post('/api/admin/subscriptions/sub_09/revoke', {
      reason: 'x',
      mode: 'shorten_to_paid_end',
    });

    expect(resp.status).toBe(409);
    expect(expectFail(resp).message).toContain('立即收回');
    expect(mockSubscriptions.find((s) => s.id === 'sub_09')!.status).not.toBe('canceled');
  });
});

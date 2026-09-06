import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from '@/mocks/handlers';
import { mockAuditLogs, mockOrders } from '@/mocks/data';
import type {
  Announcement,
  ApiErrorBody,
  ApiResp,
  FeatureFlag,
  Order,
  PageData,
  ReconciliationReport,
  SystemConfig,
} from '@/api/types';

/**
 * T-A4 mock API 行为测试：订单筛选/详情/退款/对账 + 开关/配置/公告写路径。
 * 直接驱动 handlers（msw/node），校验契约壳 { code, data } 与写操作副作用。
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

const patch = async <T>(path: string, body: unknown): Promise<Resp<T>> => {
  const resp = await fetch(`http://localhost${path}`, {
    method: 'PATCH',
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

describe('GET /api/admin/orders（订单页契约）', () => {
  test('全部 Tab：无筛选 total=128（对照草图），第 1 页返回种子数据', async () => {
    const resp = await get<PageData<Order>>('/api/admin/orders?page=1&pageSize=1&status=all');
    expect(resp.status).toBe(200);
    const { data } = expectOk(resp);
    expect(data.total).toBe(128);
    expect(data.list.length).toBe(1);
  });

  test('状态 Tabs：refunding 伪状态命中退款处理中（refunded 且 refundAmount=null）', async () => {
    const { data } = expectOk(
      await get<PageData<Order>>('/api/admin/orders?page=1&pageSize=50&status=refunding'),
    );
    expect(data.total).toBe(2);
    for (const order of data.list) {
      expect(order.status).toBe('refunded');
      expect(order.refundAmount).toBeNull();
    }
  });

  test('已退款 Tab：只含已落退款金额的订单', async () => {
    const { data } = expectOk(
      await get<PageData<Order>>('/api/admin/orders?page=1&pageSize=50&status=refunded'),
    );
    expect(data.total).toBeGreaterThanOrEqual(1);
    for (const order of data.list) {
      expect(order.status).toBe('refunded');
      expect(order.refundAmount).not.toBeNull();
    }
  });

  test('渠道 + 时间筛选生效', async () => {
    const { data } = expectOk(
      await get<PageData<Order>>(
        '/api/admin/orders?page=1&pageSize=50&channel=stripe&dateFrom=2026-09-03',
      ),
    );
    expect(data.list.length).toBeGreaterThan(0);
    for (const order of data.list) {
      expect(order.channel).toBe('stripe');
      expect(order.createdAt.slice(0, 10) >= '2026-09-03').toBe(true);
    }
  });

  test('订单号搜索命中', async () => {
    const { data } = expectOk(await get<PageData<Order>>('/api/admin/orders?q=CS20260905204188'));
    expect(data.total).toBe(1);
    expect(data.list[0]?.orderNo).toBe('CS20260905204188');
  });
});

describe('GET /api/admin/reconciliation（对账报告）', () => {
  test('三渠道汇总，合计对齐草图量级（128 笔 / ¥41,286）', async () => {
    const { data } = expectOk(await get<ReconciliationReport>('/api/admin/reconciliation'));
    expect(data.rows).toHaveLength(3);
    const totalPaid = data.rows.reduce((sum, row) => sum + row.paidCount, 0);
    const totalAmount = data.rows.reduce((sum, row) => sum + row.paidAmount, 0);
    expect(totalPaid).toBe(128);
    expect(totalAmount).toBe(41286);
  });
});

describe('订单详情与退款', () => {
  test('GET /orders/:orderNo 返回全字段', async () => {
    const { data } = expectOk(await get<Order>('/api/admin/orders/CS20260905161093'));
    expect(data.status).toBe('paid');
    expect(data.outTradeNo).toBeTruthy();
  });

  test('退款成功：状态变已退款、refundAmount 落账、写审计', async () => {
    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await post<Order>('/api/admin/orders/CS20260905161093/refund', {
        amount: 9.9,
        reason: '用户重复支付（测试）',
      }),
    );
    expect(data.status).toBe('refunded');
    expect(data.refundAmount).toBe(9.9);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.refund.execute');
    expect(mockOrders.find((o) => o.orderNo === 'CS20260905161093')?.status).toBe('refunded');
  });

  test('退款原因必填：缺原因返回 400 错误壳', async () => {
    const resp = await post<Order>('/api/admin/orders/CS20260905204188/refund', { amount: 9.9 });
    expect(resp.status).toBe(400);
    expect(expectFail(resp).code).toBe(40003);
  });
});

describe('功能开关与系统参数（设置页契约）', () => {
  test('GET /flags 返回 5 个开关', async () => {
    const { data } = expectOk(await get<FeatureFlag[]>('/api/admin/flags'));
    expect(data).toHaveLength(5);
    expect(data[0]).toMatchObject({ key: 'enable_subscription', enabled: true });
  });

  test('PATCH /flags/:key 切换开关并写审计', async () => {
    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await patch<FeatureFlag>('/api/admin/flags/enable_ai_agent', { enabled: false }),
    );
    expect(data.enabled).toBe(false);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.resourceId).toBe('enable_ai_agent');
  });

  test('GET /configs 含系统参数四项 + maintenance_mode', async () => {
    const { data } = expectOk(await get<SystemConfig[]>('/api/admin/configs'));
    const keys = data.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'ai_max_tokens',
        'ai_default_provider',
        'session_timeout_minutes',
        'audit_log_retention_days',
        'maintenance_mode',
      ]),
    );
  });

  test('PATCH /configs/:key 逐项更新；maintenance_mode 缺原因返回 400', async () => {
    const updated = expectOk(
      await patch<SystemConfig>('/api/admin/configs/ai_max_tokens', { value: '8192' }),
    );
    expect(updated.data.value).toBe('8192');

    const missingReason = await patch<SystemConfig>('/api/admin/configs/maintenance_mode', {
      value: 'on',
    });
    expect(missingReason.status).toBe(400);
    expect(expectFail(missingReason).code).toBe(40003);

    const okResp = expectOk(
      await patch<SystemConfig>('/api/admin/configs/maintenance_mode', {
        value: 'on',
        reason: '数据库升级演练（测试）',
      }),
    );
    expect(okResp.data.value).toBe('on');
  });
});

describe('公告下发', () => {
  test('POST /announcements 创建记录（unshift 至最近发送）', async () => {
    const { data } = expectOk(
      await post<Announcement>('/api/admin/announcements', {
        title: '维护通知（测试）',
        content: '今晚 02:00–02:15 将进行数据库升级。',
        audience: 'all',
        displayMode: 'once',
      }),
    );
    expect(data.deliveredCount ?? 0).toBeGreaterThan(0);
  });

  test('标题/内容为空返回 400 错误壳', async () => {
    const resp = await post<Announcement>('/api/admin/announcements', {
      title: '  ',
      content: 'x',
    });
    expect(resp.status).toBe(400);
    expect(expectFail(resp).code).toBe(40002);
  });
});

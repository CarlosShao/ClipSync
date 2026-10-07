import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from '@/mocks/handlers';
import {
  mockAnnouncements,
  mockAuditLogs,
  mockOrders,
  mockPlans,
  mockRoles,
  mockSubscriptions,
  mockUsers,
} from '@/mocks/data';
import type {
  AdminPlan,
  Announcement,
  ApiErrorBody,
  ApiResp,
  AuditLog,
  FeatureFlag,
  OpsBackups,
  OpsOverview,
  Order,
  PageData,
  Permission,
  ReconciliationReport,
  Role,
  SlowQueriesResp,
  SystemConfig,
  OpsActionResult,
  OpsActionKey,
  OpsAlerts,
  OpsCleanupResult,
  OpsStorage,
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
  test('GET /flags 返回 6 个开关（含 051 enable_signup 注册总开关）', async () => {
    const { data } = expectOk(await get<FeatureFlag[]>('/api/admin/flags'));
    expect(data).toHaveLength(6);
    expect(data[0]).toMatchObject({ key: 'enable_subscription', enabled: true });
    const signup = data.find((f) => f.key === 'enable_signup');
    expect(signup).toMatchObject({ name: '注册总开关', enabled: true });
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

  test('GET /configs 含系统参数 + 050 新键（限流/日志/SMTP/菜单覆盖）', async () => {
    const { data } = expectOk(await get<SystemConfig[]>('/api/admin/configs'));
    const keys = data.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'ai_max_tokens',
        'ai_default_provider',
        'session_timeout_minutes',
        'audit_log_retention_days',
        'maintenance_mode',
        // CO-11 限流 5 键
        'rate_limit_api_per_min',
        'rate_limit_send_code_per_hour',
        'rate_limit_login_failed_per_15min',
        'rate_limit_upload_per_min',
        'rate_limit_disabled',
        // CO-41 日志级别
        'log_level',
        // CO-30 SMTP 键组
        'smtp_host',
        'smtp_port',
        'smtp_user',
        'smtp_pass',
        'smtp_from',
        'smtp_secure',
        // 菜单覆盖
        'menu_overrides',
      ]),
    );
    const smtpPass = data.find((c) => c.key === 'smtp_pass');
    expect(smtpPass?.value).toBe('未配置');

    // AN-09：消费方登记随配置下发；无消费方的键 consumer 为 null（UI 打「未接入」角标）
    // AN-03：ai_max_tokens 已接线（buildUpstreamChat 经 aiRuntimeConfig 统一钳制），consumer 为消费方说明
    const aiMaxTokens = data.find((c) => c.key === 'ai_max_tokens');
    expect(aiMaxTokens?.consumer).toContain('aiRuntimeConfig.js');
    const rateLimit = data.find((c) => c.key === 'rate_limit_api_per_min');
    expect(rateLimit?.consumer).toContain('rateLimiter.js');
    const smtpHost = data.find((c) => c.key === 'smtp_host');
    expect(smtpHost?.consumer).toContain('email.js');
    // 全量条目必须带 consumer 字段（null 或非空字符串，不接受 undefined/空串）
    for (const item of data) {
      expect(
        item.consumer === null || (typeof item.consumer === 'string' && item.consumer !== ''),
      ).toBe(true);
    }
  });

  test('PATCH /configs/:key 逐项更新；maintenance_mode 缺原因返回 400；log_level 白名单校验', async () => {
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

    // CO-41：log_level 仅允许 debug/info/warn/error
    const badLevel = await patch<SystemConfig>('/api/admin/configs/log_level', { value: 'verbose' });
    expect(badLevel.status).toBe(400);
    expect(expectFail(badLevel).code).toBe(40002);

    // CO-30：smtp_pass 写入后回显脱敏状态而非明文
    const passResp = expectOk(
      await patch<SystemConfig>('/api/admin/configs/smtp_pass', { value: 'super-secret' }),
    );
    expect(passResp.data.value).toBe('已配置');
  });

  test('PATCH /configs/rate_limit_disabled 生产环境写 true 返回 400（CO-11）', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const resp = await patch<SystemConfig>('/api/admin/configs/rate_limit_disabled', {
        value: 'true',
      });
      expect(resp.status).toBe(400);
      expect(expectFail(resp).code).toBe(40002);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe('公告下发', () => {
  test('GET /announcements 历史行含真实已读触达 read_count（CO-35）', async () => {
    const { data } = expectOk(await get<Announcement[]>('/api/admin/announcements'));
    expect(data.length).toBeGreaterThan(0);
    for (const item of data) {
      expect(typeof item.readCount).toBe('number');
      expect(item.readCount ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  test('POST /announcements 创建记录（unshift 至最近发送，readCount 从 0 起计）', async () => {
    const { data } = expectOk(
      await post<Announcement>('/api/admin/announcements', {
        title: '维护通知（测试）',
        content: '今晚 02:00–02:15 将进行数据库升级。',
        audience: 'all',
        displayMode: 'once',
      }),
    );
    expect(data.deliveredCount ?? 0).toBeGreaterThan(0);
    expect(data.readCount).toBe(0);
  });

  test('标题/内容为空返回 400 错误壳', async () => {
    const resp = await post<Announcement>('/api/admin/announcements', {
      title: '  ',
      content: 'x',
    });
    expect(resp.status).toBe(400);
    expect(expectFail(resp).code).toBe(40002);
  });

  test('★撤回公告：写入 withdrawnAt + 审计留下发/点击数据；重复撤回 409', async () => {
    const item = mockAnnouncements[0]!;
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<Announcement>(`/api/admin/announcements/${item.id}/withdraw`, {
        reason: '价格写错了',
      }),
    );

    expect(data.withdrawnAt).toBeTruthy();
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.announce.withdraw');
    // 软撤回的意义：统计仍在（硬删会连带删掉它们）
    expect(mockAuditLogs[0]?.details).toContain('delivered=');
    expect(mockAuditLogs[0]?.details).toContain('价格写错了');

    const again = await post(`/api/admin/announcements/${item.id}/withdraw`, { reason: 'x' });
    expect(again.status).toBe(409);
    expect(expectFail(again).message).toContain('无需重复');
  });

  test('撤回：缺原因 → 400；公告不存在 → 404', async () => {
    const item = mockAnnouncements[0]!;
    expect((await post(`/api/admin/announcements/${item.id}/withdraw`, {})).status).toBe(400);
    expect(
      (await post('/api/admin/announcements/ann_nope/withdraw', { reason: 'x' })).status,
    ).toBe(404);
  });
});

describe('GET /api/admin/audit-logs（审计页契约 T-A6）', () => {
  test('种子数据 ≥20 条、敏感 ≥6 条、操作者含 Carlos/Yuki/终端手机号', async () => {
    const { data } = expectOk(await get<PageData<AuditLog>>('/api/admin/audit-logs?page=1&pageSize=50'));
    expect(mockAuditLogs.length).toBeGreaterThanOrEqual(20);
    const all = mockAuditLogs;
    expect(all.filter((a) => a.sensitive).length).toBeGreaterThanOrEqual(6);
    expect(all.some((a) => a.operator === 'Carlos')).toBe(true);
    expect(all.some((a) => a.operator === 'Yuki')).toBe(true);
    expect(all.some((a) => a.operatorRole === 'user')).toBe(true);
    for (const log of all) {
      expect(typeof log.details).toBe('string');
      expect(log.details.length).toBeGreaterThan(0);
    }
    expect(data.total).toBeGreaterThan(0);
  });

  test('无筛选 total=2431088（对照草图量级）', async () => {
    const { data } = expectOk(await get<PageData<AuditLog>>('/api/admin/audit-logs?page=1&pageSize=1'));
    expect(data.total).toBe(2431088);
  });

  test('动作组筛选：auth 命中登录/登出，sensitive 全部满足敏感判定，payment 命中支付相关', async () => {
    const auth = expectOk(await get<PageData<AuditLog>>('/api/admin/audit-logs?action=auth&pageSize=50')).data;
    expect(auth.list.length).toBeGreaterThan(0);
    for (const log of auth.list) {
      expect(log.action.startsWith('user.login') || log.action.startsWith('user.logout')).toBe(true);
    }

    const sensitive = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?action=sensitive&pageSize=50'),
    ).data;
    expect(sensitive.list.length).toBeGreaterThanOrEqual(6);
    for (const log of sensitive.list) {
      const isSensitive = log.action.startsWith('admin.') || ['user.deactivate', 'role.assign', 'user.delete'].includes(log.action);
      expect(isSensitive).toBe(true);
    }

    const payment = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?action=payment&pageSize=50'),
    ).data;
    expect(payment.list.length).toBeGreaterThan(0);
    for (const log of payment.list) {
      expect(log.action.startsWith('payment.') || log.action.startsWith('admin.refund')).toBe(true);
    }
  });

  test('操作者筛选：end_user 仅终端用户，Carlos/Yuki 精确命中', async () => {
    const endUser = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?operator=end_user&pageSize=50'),
    ).data;
    expect(endUser.list.length).toBeGreaterThan(0);
    for (const log of endUser.list) expect(log.operatorRole).toBe('user');

    const carlos = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?operator=Carlos&pageSize=50'),
    ).data;
    expect(carlos.list.length).toBeGreaterThan(0);
    for (const log of carlos.list) expect(log.operator).toBe('Carlos');

    const yuki = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?operator=Yuki&pageSize=50'),
    ).data;
    expect(yuki.list.length).toBeGreaterThan(0);
    for (const log of yuki.list) expect(log.operator).toBe('Yuki');
  });

  test('AN-11：actorLevel 筛选仅命中对应级别操作者', async () => {
    const superAdmin = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?actorLevel=super_admin&pageSize=50'),
    ).data;
    expect(superAdmin.list.length).toBeGreaterThan(0);
    for (const log of superAdmin.list) expect(log.operatorRole).toBe('super_admin');

    const admin = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?actorLevel=admin&pageSize=50'),
    ).data;
    for (const log of admin.list) expect(log.operatorRole).toBe('admin');

    const user = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?actorLevel=user&pageSize=50'),
    ).data;
    for (const log of user.list) expect(log.operatorRole).toBe('user');
  });

  test('结果 / IP / 日期范围筛选生效', async () => {
    const failed = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?result=failed&pageSize=50'),
    ).data;
    expect(failed.list.length).toBeGreaterThan(0);
    for (const log of failed.list) expect(log.status).toBe('failed');

    const byIp = expectOk(
      await get<PageData<AuditLog>>('/api/admin/audit-logs?ip=116.24&pageSize=50'),
    ).data;
    for (const log of byIp.list) expect(log.ipAddress).toContain('116.24');

    const ranged = expectOk(
      await get<PageData<AuditLog>>(
        '/api/admin/audit-logs?dateFrom=2026-08-19&dateTo=2026-08-20&pageSize=50',
      ),
    ).data;
    expect(ranged.total).toBe(2);
    for (const log of ranged.list) {
      expect(log.createdAt.slice(0, 10) >= '2026-08-19').toBe(true);
      expect(log.createdAt.slice(0, 10) <= '2026-08-20').toBe(true);
    }
  });
});

describe('AN-12 /api/admin/sessions（管理员会话契约）', () => {
  test('列表仅含管理角色活跃会话，支持 q 过滤', async () => {
    const { data } = expectOk(
      await get<PageData<{ id: string; roleKey: string | null; nickname: string }>>('/api/admin/sessions?page=1&pageSize=10'),
    );
    expect(data.list.length).toBeGreaterThan(0);
    for (const s of data.list) {
      expect(['super_admin', 'admin']).toContain(s.roleKey);
    }

    const filtered = expectOk(
      await get<PageData<{ id: string; nickname: string }>>('/api/admin/sessions?q=Yuki&pageSize=10'),
    ).data;
    expect(filtered.list.length).toBeGreaterThan(0);
    for (const s of filtered.list) expect(s.nickname).toBe('Yuki');
  });

  test('单会话下线：缺 reason 400；带 reason 成功且列表移除；重复下线 404', async () => {
    const noReason = expectFail(
      await post('/api/admin/sessions/ses_20260905_1436_yuki/revoke', {}),
    );
    expect(noReason.code).toBe(4000);

    const okResp = expectOk<{ id: string; revoked: boolean }>(
      await post('/api/admin/sessions/ses_20260905_1436_yuki/revoke', { reason: '离职交接，回收登录态' }),
    );
    expect(okResp.data.revoked).toBe(true);

    const repeat = expectFail(
      await post('/api/admin/sessions/ses_20260905_1436_yuki/revoke', { reason: '重复下线' }),
    );
    expect(repeat.code).toBe(40404);
  });
});

describe('GET /api/admin/ops/overview（运维监控页契约 CO-40）', () => {
  test('返回状态/版本/运行时长/探针/内存/指标聚合', async () => {
    const { data } = expectOk(await get<OpsOverview>('/api/admin/ops/overview'));
    expect(['ok', 'degraded', 'error']).toContain(data.status);
    expect(typeof data.version).toBe('string');
    expect(data.uptimeSec).toBeGreaterThan(0);
    expect(data.db.ok).toBe(true);
    expect(data.redis.ok).toBe(true);
    expect(data.memory.rss).toBeGreaterThan(0);
    expect(data.metrics).not.toBeNull();
    expect(data.metrics!.requests).toBeGreaterThan(0);
    expect(data.metrics!.errors).toBeGreaterThanOrEqual(0);
    expect(data.metrics!.p95).toBeGreaterThan(0);
  });

  test('CO-42：含 deployment 部署形态（k8s / docker-compose）', async () => {
    const { data } = expectOk(await get<OpsOverview>('/api/admin/ops/overview'));
    expect(data.deployment).toBeDefined();
    expect(['k8s', 'docker-compose']).toContain(data.deployment!.type);
  });
});

describe('CO-33/CO-41：备份概览与慢查询', () => {
  test('GET /ops/backups 返回 items + summary（份数/总大小/最近备份时间）', async () => {
    const { data } = expectOk(await get<OpsBackups>('/api/admin/ops/backups'));
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.summary.total).toBe(data.items.length);
    expect(data.summary.totalBytes).toBe(data.items.reduce((sum, item) => sum + item.sizeBytes, 0));
    expect(data.summary.lastBackupAt).toBeTruthy();
    for (const item of data.items) {
      expect(item.file).toBeTruthy();
      expect(item.sizeBytes).toBeGreaterThan(0);
      expect(['db', 'redis', 'uploads']).toContain(item.kind);
    }
  });

  test('GET /slow-queries 返回慢查询行 + 连接池状态（admin.audit.view 域）', async () => {
    const { data } = expectOk(await get<SlowQueriesResp>('/api/admin/slow-queries'));
    expect(data.slowQueries.length).toBeGreaterThan(0);
    for (const row of data.slowQueries) {
      expect(row.query).toBeTruthy();
      expect(row.meanExecTime).toContain('ms');
      expect(row.calls).toBeGreaterThan(0);
    }
    expect(data.poolStatus).not.toBeNull();
    expect(typeof data.timestamp).toBe('string');
  });
});

describe('AN-06/AN-15/AN-08：运维动作区、活跃告警与存储用量', () => {
  test('AN-15：GET /ops/alerts 返回活跃告警 + grafanaUrl', async () => {
    const { data } = expectOk(await get<OpsAlerts>('/api/admin/ops/alerts'));
    expect(data.unavailable).toBe(false);
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(['firing', 'pending']).toContain(item.state);
      expect(item.name).toBeTruthy();
      expect(['critical', 'warning', 'info']).toContain(item.severity);
    }
    expect(data.grafanaUrl).toBeTruthy();
  });

  test('AN-06：POST /ops/actions 缺原因返回 400 错误壳', async () => {
    const resp = await post<OpsActionResult>('/api/admin/ops/actions', { action: 'clear_cache' });
    expect(resp.status).toBe(400);
    expect(expectFail(resp).code).toBe(40003);
  });

  test('AN-06：POST /ops/actions 未知动作返回 400；全员下线写审计', async () => {
    const bad = await post<OpsActionResult>('/api/admin/ops/actions', {
      action: 'reboot_server',
      reason: '边界外动作（测试）',
    });
    expect(bad.status).toBe(400);
    expect(expectFail(bad).code).toBe(4000);

    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await post<OpsActionResult>('/api/admin/ops/actions', {
        action: 'force_logout_all' satisfies OpsActionKey,
        reason: '安全事件演练（测试）',
      }),
    );
    expect(data.revokedSessions).toBeGreaterThan(0);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.ops.action');
  });

  test('AN-06：POST /ops/actions trigger_backup 返回备份文件与保留策略结果', async () => {
    const { data } = expectOk(
      await post<OpsActionResult>('/api/admin/ops/actions', {
        action: 'trigger_backup',
        reason: '发布前手动备份（测试）',
      }),
    );
    expect(data.file).toContain('clipsync_manual_');
    expect(data.sizeBytes).toBeGreaterThan(0);
    expect(data.retentionDays).toBeGreaterThan(0);
  });

  test('AN-08：GET /ops/storage 返回总量 / 按表体积 / 用户 TOP', async () => {
    const { data } = expectOk(await get<OpsStorage>('/api/admin/ops/storage'));
    expect(data.totals.itemCount).toBeGreaterThan(0);
    expect(data.totals.dbBytes).toBeGreaterThan(0);
    expect(data.tables.length).toBeGreaterThan(0);
    for (const t of data.tables) {
      expect(t.table).toBeTruthy();
      expect(t.totalBytes).toBeGreaterThan(0);
    }
    expect(data.topUsers.length).toBeGreaterThan(0);
    // TopN 交叉口径：各用户 totalBytes 之和不大于全局总字节
    const sumTop = data.topUsers.reduce((s, u) => s + u.totalBytes, 0);
    expect(sumTop).toBeLessThanOrEqual(data.totals.totalBytes);
  });

  test('AN-08：POST /ops/cleanup 缺原因 400；带原因返回清理统计并写审计', async () => {
    const bad = await post<OpsCleanupResult>('/api/admin/ops/cleanup', {});
    expect(bad.status).toBe(400);
    expect(expectFail(bad).code).toBe(40003);

    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await post<OpsCleanupResult>('/api/admin/ops/cleanup', { reason: '例行清理（测试）' }),
    );
    expect(data.expired.expiredItems).toBeGreaterThanOrEqual(0);
    expect(data.fileRetention).not.toBeNull();
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.ops.storage.cleanup');
  });
});

describe('POST /api/admin/configs/smtp/test（CO-30 SMTP 测试邮件）', () => {
  test('未配置 SMTP 返回 409/4090 错误壳', async () => {
    const resp = await post<{ messageId: string }>('/api/admin/configs/smtp/test', {
      to: 'carlos@clipchain.top',
    });
    expect(resp.status).toBe(409);
    expect(expectFail(resp).code).toBe(4090);
  });

  test('配置 smtp_host + smtp_pass 后发送成功返回 messageId', async () => {
    await patch('/api/admin/configs/smtp_host', { value: 'smtp.clipchain.top' });
    await patch('/api/admin/configs/smtp_pass', { value: 'mock-auth-code' });
    const resp = await post<{ messageId: string }>('/api/admin/configs/smtp/test', {});
    expect(resp.status).toBe(200);
    expect(expectOk(resp).data.messageId).toContain('@clipchain.top');
  });

  test('发送失败（收件人含 fail）返回 5xx 错误壳', async () => {
    const resp = await post<{ messageId: string }>('/api/admin/configs/smtp/test', {
      to: 'fail@clipchain.top',
    });
    expect(resp.status).toBe(500);
    expect(expectFail(resp).code).toBe(5001);
  });
});

describe('POST /api/admin/configs/sms/test（A4 测试短信）', () => {
  test('未配置短信返回 409/4090 错误壳', async () => {
    const resp = await post<{ phone: string }>('/api/admin/configs/sms/test', {
      phone: '13800138000',
    });
    expect(resp.status).toBe(409);
    expect(expectFail(resp).code).toBe(4090);
  });

  test('配置 provider=aliyun + AccessKeySecret 后发送成功返回 provider', async () => {
    await patch('/api/admin/configs/sms_provider', { value: 'aliyun' });
    await patch('/api/admin/configs/sms_access_key_secret', { value: 'mock-secret' });
    const resp = await post<{ phone: string; provider: string }>('/api/admin/configs/sms/test', {
      phone: '13800138000',
    });
    expect(resp.status).toBe(200);
    expect(expectOk(resp).data.provider).toBe('aliyun');
  });

  test('发送失败（手机号含 fail）返回 5xx 错误壳', async () => {
    const resp = await post<{ phone: string }>('/api/admin/configs/sms/test', {
      phone: '13800138000fail',
    });
    expect(resp.status).toBe(500);
    expect(expectFail(resp).code).toBe(5000);
  });
});

describe('角色权限写路径（T-A6）', () => {
  test('GET /roles 返回 4 角色（含权限集合与人数），GET /permissions 返回 31 项目录（RB-06/RB-11 扩充 + 065/AN-04 release 键）', async () => {
    const roles = expectOk(await get<Role[]>('/api/admin/roles')).data;
    expect(roles).toHaveLength(4);
    const superAdmin = roles.find((r) => r.roleKey === 'super_admin');
    expect(superAdmin?.permissions.length).toBe(31);

    const permissions = expectOk(await get<Permission[]>('/api/admin/permissions')).data;
    expect(permissions).toHaveLength(31);

    // RB-06：读侧 view 键 7 项 + admin.ops.view 均在目录内
    const permKeys = permissions.map((p) => p.permKey);
    expect(permKeys).toEqual(
      expect.arrayContaining([
        'admin.devices.view',
        'admin.orders.view',
        'admin.subscriptions.view',
        'admin.plans.view',
        'admin.roles.view',
        'admin.configs.view',
        'admin.announce.view',
        'admin.ops.view',
      ]),
    );
    expect(permissions.find((p) => p.permKey === 'admin.ops.view')?.superAdminOnly).toBe(true);

    // RB-11：AI 组 9 键，category='ai' 且均非 superAdminOnly
    const aiPerms = permissions.filter((p) => p.category === 'ai');
    expect(aiPerms).toHaveLength(9);
    for (const perm of aiPerms) expect(perm.superAdminOnly).toBe(false);
    expect(permKeys).toEqual(
      expect.arrayContaining([
        'ai.manage_users',
        'ai.manage_devices',
        'ai.manage_system',
        'ai.view_security_data',
        'ai.view_deployment',
        'ai.view_source_code',
        'ai.view_database_schema',
        'ai.access_other_user_data',
        'ai.explain_internal',
      ]),
    );

    // 内置 admin 角色：全部 view 键 + ai.manage_devices（049/052/053 授予策略镜像）
    const adminRole = roles.find((r) => r.roleKey === 'admin');
    expect(adminRole?.permissions).toContain('admin.devices.view');
    expect(adminRole?.permissions).toContain('ai.manage_devices');
    expect(adminRole?.permissions).not.toContain('admin.ops.view');
    expect(adminRole?.permissions.filter((k) => k.startsWith('ai.'))).toEqual(['ai.manage_devices']);
  });

  test('PATCH /roles/:id/permissions 更新内存并写审计（admin.roles.update 敏感）', async () => {
    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await patch<Role>('/api/admin/roles/role_custom_support/permissions', {
        permissions: ['admin.users.view', 'admin.users.manage', 'admin.audit.view'],
      }),
    );
    expect(data.permissions).toEqual(['admin.users.view', 'admin.users.manage', 'admin.audit.view']);
    expect(mockRoles.find((r) => r.id === 'role_custom_support')?.permissions).toContain(
      'admin.users.manage',
    );
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.roles.update');
    expect(mockAuditLogs[0]?.sensitive).toBe(true);
  });

  test('PATCH 超管角色返回 403 错误壳；未知权限键返回 400', async () => {
    const forbidden = await patch<Role>('/api/admin/roles/role_super_admin/permissions', {
      permissions: [],
    });
    expect(forbidden.status).toBe(403);
    expect(expectFail(forbidden).code).toBe(40301);

    const unknownKey = await patch<Role>('/api/admin/roles/role_admin/permissions', {
      permissions: ['admin.not.exist'],
    });
    expect(unknownKey.status).toBe(400);
    expect(expectFail(unknownKey).code).toBe(40007);
  });

  test('POST /roles 校验 custom_ 前缀与级别；合法创建 memberCount=0 并写审计', async () => {
    const badPrefix = await post<Role>('/api/admin/roles', {
      roleKey: 'support',
      name: '客服',
      level: 30,
    });
    expect(badPrefix.status).toBe(400);
    expect(expectFail(badPrefix).code).toBe(40007);

    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await post<Role>('/api/admin/roles', {
        roleKey: 'custom_ops',
        name: '运营专员',
        level: 20,
        description: '运营支持',
      }),
    );
    expect(data.roleKey).toBe('custom_ops');
    expect(data.memberCount).toBe(0);
    expect(data.permissions).toEqual([]);
    expect(mockRoles.some((r) => r.roleKey === 'custom_ops')).toBe(true);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.roles.create');
  });
});

describe('GET /api/admin/plans（套餐与价格页契约 AN-01）', () => {
  test('返回 3 档套餐，042 方案 B 限额数值逐字段对齐（Free 20MB/200MB/3/3天 …）', async () => {
    const resp = await get<{ list: AdminPlan[] }>('/api/admin/plans');
    expect(resp.status).toBe(200);
    const { data } = expectOk(resp);
    expect(data.list).toHaveLength(3);

    const free = data.list.find((p) => p.name === 'Free');
    expect(free).toMatchObject({
      id: 'plan_free_mock',
      displayName: '免费版',
      maxFileSizeMb: 20,
      maxStorageMb: 200,
      maxFilesPerClip: 3,
      fileRetentionDays: 3,
      isActive: true,
    });

    const pro = data.list.find((p) => p.name === 'Pro');
    expect(pro).toMatchObject({
      priceMonthly: 9.9,
      priceYearly: 99,
      maxFileSizeMb: 128,
      maxStorageMb: 20480,
      maxFilesPerClip: 10,
      fileRetentionDays: 30,
    });
    expect(pro?.features).toEqual({ ai_classify: true });

    const enterprise = data.list.find((p) => p.name === 'Enterprise');
    expect(enterprise).toMatchObject({
      maxFileSizeMb: 512,
      maxStorageMb: 204800,
      maxFilesPerClip: 50,
      fileRetentionDays: 90,
    });
    expect(enterprise?.features).toEqual({ ai_classify: true, team_management: true });

    // id 与 mockSubscriptions 的 planId 引用一致
    const planIds = data.list.map((p) => p.id);
    for (const planId of planIds) {
      expect(mockSubscriptions.some((s) => s.planId === planId)).toBe(true);
    }
  });

  test('PATCH /plans/:id 更新内存并写审计；features 非法 JSON 返回 400', async () => {
    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await patch<AdminPlan>('/api/admin/plans/plan_free_mock', {
        max_file_size_mb: 25,
        max_files_per_clip: 5,
      }),
    );
    expect(data.maxFileSizeMb).toBe(25);
    expect(data.maxFilesPerClip).toBe(5);
    expect(mockPlans.find((p) => p.id === 'plan_free_mock')?.maxFileSizeMb).toBe(25);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.plans.update');
    expect(mockAuditLogs[0]?.resourceType).toBe('subscription_plan');

    const badFeatures = await patch<AdminPlan>('/api/admin/plans/plan_free_mock', {
      features: [1, 2],
    });
    expect(badFeatures.status).toBe(400);

    const notFound = await patch<AdminPlan>('/api/admin/plans/plan_none_mock', {
      max_file_size_mb: 1,
    });
    expect(notFound.status).toBe(404);
  });
});

/**
 * 用户级运营动作的 mock 行为（2026-10-05 补）。
 *
 * 这三个端点此前**没有 handler**，而 MSW 是 `onUnhandledRequest: 'bypass'` ——
 * 没 handler 的请求会真的打到 vite proxy 的目标（本机联调时是**生产**）。
 * 所以补 handler 不只是"让 mock 里按钮能用"，更是**挡住 mock 模式下的真实写入**。
 */
describe('POST /api/admin/users/:id/notify（定向通知）', () => {
  const activeUser = mockUsers.find((u) => u.status === 'active')!;

  test('落库 + 写审计 admin.user.notify + 如实回报在线设备数', async () => {
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<{ notificationType: string; onlineDevices: number }>(
        `/api/admin/users/${activeUser.id}/notify`,
        { title: '关于你的赠期', body: '你获赠的一个月专业版已到账。' },
      ),
    );

    expect(data.notificationType).toBe('admin_message');
    expect(typeof data.onlineDevices).toBe('number');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.notify');
    expect(mockAuditLogs[0]?.details).toContain('关于你的赠期');
  });

  test('四类白名单都接受；非法类型 → 400', async () => {
    for (const type of [
      'admin_message',
      'subscription_notice',
      'device_notice',
      'security_notice',
    ]) {
      const resp = await post(`/api/admin/users/${activeUser.id}/notify`, {
        title: 't',
        body: 'b',
        notificationType: type,
      });
      expect(resp.status, type).toBe(200);
    }
    const bad = await post(`/api/admin/users/${activeUser.id}/notify`, {
      title: 't',
      body: 'b',
      notificationType: 'whatever',
    });
    expect(bad.status).toBe(400);
  });

  test('缺标题/正文、超长 → 400；用户不存在 → 404', async () => {
    expect((await post(`/api/admin/users/${activeUser.id}/notify`, { body: 'b' })).status).toBe(
      400,
    );
    expect((await post(`/api/admin/users/${activeUser.id}/notify`, { title: 't' })).status).toBe(
      400,
    );
    expect(
      (await post(`/api/admin/users/${activeUser.id}/notify`, { title: 'x'.repeat(101), body: 'b' }))
        .status,
    ).toBe(400);
    expect(
      (await post(`/api/admin/users/${activeUser.id}/notify`, { title: 't', body: 'x'.repeat(501) }))
        .status,
    ).toBe(400);
    expect((await post('/api/admin/users/usr_nope/notify', { title: 't', body: 'b' })).status).toBe(
      404,
    );
  });
});

describe('PATCH /api/admin/users/:id/role（分配角色，端点早有、此前无 UI）', () => {
  const target = mockUsers.find((u) => u.roleId !== 'role_super_admin')!;
  const adminRole = mockRoles.find((r) => r.roleKey === 'admin')!;
  const superRole = mockRoles.find((r) => r.roleKey === 'super_admin')!;

  test('更新 roleId 并写审计 role.assign', async () => {
    const auditBefore = mockAuditLogs.length;
    const { data } = expectOk(
      await patch<{ roleId: string }>(`/api/admin/users/${target.id}/role`, {
        roleId: adminRole.id,
        reason: '接管客服',
      }),
    );
    expect(data.roleId).toBe(adminRole.id);
    expect(mockUsers.find((u) => u.id === target.id)!.roleId).toBe(adminRole.id);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('role.assign');
  });

  test('超管角色不可授予 → 403；缺 roleId → 400；角色不存在 → 404', async () => {
    const superResp = await patch(`/api/admin/users/${target.id}/role`, { roleId: superRole.id });
    expect(superResp.status).toBe(403);

    expect((await patch(`/api/admin/users/${target.id}/role`, {})).status).toBe(400);
    expect((await patch(`/api/admin/users/${target.id}/role`, { roleId: 'role_nope' })).status).toBe(
      404,
    );
  });
});

describe('POST /api/admin/users/:id/reset-2fa（重置两步验证，端点早有、此前无 UI）', () => {
  test('重置并写审计 admin.user.reset_2fa；用户不存在 → 404', async () => {
    const user = mockUsers[0]!;
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<{ twoFactorEnabled: boolean }>(`/api/admin/users/${user.id}/reset-2fa`, {}),
    );
    expect(data.twoFactorEnabled).toBe(false);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.reset_2fa');

    expect((await post('/api/admin/users/usr_nope/reset-2fa', {})).status).toBe(404);
  });
});

describe('POST /api/admin/users/:id/trial（人工开通/重置试用）', () => {
  test('★免费用户可开通：套餐变为所选套餐、状态 trialing，审计留痕绕过了终身一次闸', async () => {
    const freeUsers = mockUsers.filter((u) => (u.subscription?.plan ?? 'free') === 'free');
    const target = freeUsers[freeUsers.length - 1]!; // 取最后一个，尽量不干扰其它用例
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<{ subscription: { plan: string; status: string } }>(
        `/api/admin/users/${target.id}/trial`,
        { reason: '试用期内故障补偿', days: 7, planId: 'pro' },
      ),
    );

    expect(data.subscription.plan).toBe('pro');
    expect(data.subscription.status).toBe('trialing');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.subscriptions.trial');
    // ★刻意绕过产品规则必须留痕
    expect(mockAuditLogs[0]?.details).toContain('bypassedLifetimeGate=true');
  });

  test('★已有生效中订阅（付费）→ 409，且套餐不变', async () => {
    const paidUser = mockUsers.find((u) => (u.subscription?.plan ?? 'free') !== 'free')!;
    const planBefore = paidUser.subscription.plan;

    const resp = await post(`/api/admin/users/${paidUser.id}/trial`, {
      reason: '想再给一次',
      days: 7,
      planId: 'pro',
    });

    expect(resp.status).toBe(409);
    expect(expectFail(resp).message).toContain('赠期');
    expect(paidUser.subscription.plan).toBe(planBefore);
  });

  test('校验：缺原因 / 天数越界 / 选免费版 / 用户不存在', async () => {
    const free = mockUsers.find((u) => (u.subscription?.plan ?? 'free') === 'free')!;
    expect((await post(`/api/admin/users/${free.id}/trial`, { days: 7 })).status).toBe(400);
    expect(
      (await post(`/api/admin/users/${free.id}/trial`, { reason: 'x', days: 0 })).status,
    ).toBe(400);
    expect(
      (await post(`/api/admin/users/${free.id}/trial`, { reason: 'x', days: 31 })).status,
    ).toBe(400);
    expect(
      (await post(`/api/admin/users/${free.id}/trial`, { reason: 'x', days: 7, planId: 'free' }))
        .status,
    ).toBe(400);
    expect((await post('/api/admin/users/usr_nope/trial', { reason: 'x' })).status).toBe(404);
  });
});

describe('POST /api/admin/users/merge（合并重复账号）', () => {
  test('★两步确认：第一次 409 告知条数（什么都不做），带条数才真合并', async () => {
    // 挑一对"都不付费"的账号，避开订阅冲突分支
    const free = mockUsers.filter((u) => (u.subscription?.plan ?? 'free') === 'free');
    const canonical = free[0]!;
    const duplicate = free[1]!;
    const dupNickBefore = duplicate.nickname;
    const auditBefore = mockAuditLogs.length;

    const first = await post('/api/admin/users/merge', {
      canonicalUserId: canonical.id,
      duplicateUserId: duplicate.id,
      reason: '同人两号',
    });
    expect(first.status).toBe(409);
    expect(expectFail(first).message).toContain('3 条');
    // ★必须带 reason：客户端按它识别"内容计数闸"并切到第二步；缺了 mock 模式下第二步走不出来
    expect(expectFail(first).reason).toBe('CLIP_COUNT_MISMATCH');
    // 什么都没发生
    expect(duplicate.nickname).toBe(dupNickBefore);
    expect(mockAuditLogs.length).toBe(auditBefore);

    const second = await post<{ merged: { movedClips: number } }>('/api/admin/users/merge', {
      canonicalUserId: canonical.id,
      duplicateUserId: duplicate.id,
      confirmMovedClips: 3,
      reason: '同人两号',
    });
    expect(second.status).toBe(200);
    expect(expectOk(second).data.merged.movedClips).toBe(3);
    // 被合并方退役
    expect(duplicate.nickname).toContain('_merged');
    expect(duplicate.isActive).toBe(false);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.merge');
    expect(mockAuditLogs[0]?.details).toContain('movedClips=3');
  });

  test('校验：同一个账号 / 缺 id / 缺原因 → 400；账号不存在 → 404', async () => {
    const a = mockUsers[0]!;
    expect(
      (
        await post('/api/admin/users/merge', {
          canonicalUserId: a.id,
          duplicateUserId: a.id,
          reason: 'x',
        })
      ).status,
    ).toBe(400);
    expect((await post('/api/admin/users/merge', { canonicalUserId: a.id, reason: 'x' })).status).toBe(
      400,
    );
    expect(
      (
        await post('/api/admin/users/merge', {
          canonicalUserId: a.id,
          duplicateUserId: mockUsers[1]!.id,
          confirmMovedClips: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/api/admin/users/merge', {
          canonicalUserId: a.id,
          duplicateUserId: 'usr_nope',
          reason: 'x',
        })
      ).status,
    ).toBe(404);
  });
});

describe('PATCH /api/admin/users/:id/profile（违规昵称/头像处置）', () => {
  test('改昵称：更新内存 + 审计记改动前后', async () => {
    const user = mockUsers[0]!;
    const from = user.nickname;
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await patch<{ nickname: string }>(`/api/admin/users/${user.id}/profile`, {
        nickname: '合规昵称',
        reason: '昵称违规',
      }),
    );

    expect(data.nickname).toBe('合规昵称');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.profile_moderation');
    expect(mockAuditLogs[0]?.details).toContain(from);
    expect(mockAuditLogs[0]?.details).toContain('合规昵称');
  });

  test('校验：一项不给 → 400；空昵称 → 400（给出中性替代名建议）；javascript: 头像 → 400', async () => {
    const id = mockUsers[0]!.id;
    expect((await patch(`/api/admin/users/${id}/profile`, { reason: 'x' })).status).toBe(400);

    const empty = await patch(`/api/admin/users/${id}/profile`, { nickname: '  ', reason: 'x' });
    expect(empty.status).toBe(400);
    expect(expectFail(empty).message).toContain('用户4821');

    expect(
      (
        await patch(`/api/admin/users/${id}/profile`, {
          avatarUrl: 'javascript:alert(1)',
          reason: 'x',
        })
      ).status,
    ).toBe(400);
    expect((await patch('/api/admin/users/usr_nope/profile', { nickname: 'x', reason: 'y' })).status).toBe(
      404,
    );
  });
});

describe('POST /api/admin/users/:id/limits（单用户配额覆盖）', () => {
  test('设置覆盖：写内存 + 审计记改动前后；null 表示该项不限', async () => {
    const user = mockUsers[0]!;
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<{ limitOverrides: Record<string, number | null> }>(
        `/api/admin/users/${user.id}/limits`,
        { reason: '客诉补偿', overrides: { max_storage_mb: 51200, file_retention_days: null } },
      ),
    );

    expect(data.limitOverrides).toEqual({ max_storage_mb: 51200, file_retention_days: null });
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.limits_override');
    expect(mockAuditLogs[0]?.details).toContain('客诉补偿');
  });

  test('★未知键 → 400；clear:true → 清空；clear 与 overrides 互斥', async () => {
    const id = mockUsers[0]!.id;
    const bad = await post(`/api/admin/users/${id}/limits`, {
      reason: 'x',
      overrides: { max_devices: 99 },
    });
    expect(bad.status).toBe(400);
    expect(expectFail(bad).message).toContain('max_devices');

    expect(
      (
        await post(`/api/admin/users/${id}/limits`, {
          reason: 'x',
          clear: true,
          overrides: { max_storage_mb: 1 },
        })
      ).status,
    ).toBe(400);

    const cleared = expectOk(
      await post<{ limitOverrides: unknown }>(`/api/admin/users/${id}/limits`, {
        reason: '补偿结束',
        clear: true,
      }),
    );
    expect(cleared.data.limitOverrides).toBeNull();
  });
});

describe('POST /api/admin/users/:id/reset-password（代重置密码）', () => {
  test('返回一次性临时密码 + 写审计（且审计里不含密码）', async () => {
    const user = mockUsers[0]!;
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await post<{ temporaryPassword: string; sessionsRevoked: number }>(
        `/api/admin/users/${user.id}/reset-password`,
        { reason: '手机丢失' },
      ),
    );

    // 格式与真实一致（8 字符 base64url），便于验收时对照
    expect(data.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(data.sessionsRevoked).toBeGreaterThan(0);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.reset_password');
    // ★审计绝不能成为凭据的第二份副本
    expect(mockAuditLogs[0]?.details).not.toContain(data.temporaryPassword);
    expect(mockAuditLogs[0]?.details).toContain('手机丢失');
  });

  test('缺原因 → 400；用户不存在 → 404', async () => {
    const user = mockUsers[0]!;
    expect((await post(`/api/admin/users/${user.id}/reset-password`, {})).status).toBe(400);
    expect(
      (await post(`/api/admin/users/${user.id}/reset-password`, { reason: '  ' })).status,
    ).toBe(400);
    expect(
      (await post('/api/admin/users/usr_nope/reset-password', { reason: 'x' })).status,
    ).toBe(404);
  });
});

describe('POST /api/admin/users/:id/rebind（换绑登录标识）', () => {
  test('换绑手机号：更新展示值 + 写审计（打码，不含明文）', async () => {
    // 用一个独立用户，避免污染其它用例依赖的种子行
    const user = mockUsers.find((u) => u.id !== mockUsers[0]!.id) ?? mockUsers[0]!;
    const auditBefore = mockAuditLogs.length;
    const NEW_PHONE = '13900000009';

    const { data } = expectOk(
      await post<{ phone: string }>(`/api/admin/users/${user.id}/rebind`, {
        phone: NEW_PHONE,
        reason: '用户换号',
      }),
    );

    // mock 的用户对象里手机号本来就是打码值，换绑后也应保持打码
    expect(data.phone).toContain('****');
    expect(data.phone).not.toBe(NEW_PHONE);
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.user.rebind');
    expect(mockAuditLogs[0]?.details).not.toContain(NEW_PHONE);
    expect(mockAuditLogs[0]?.details).toContain('用户换号');
  });

  test('校验：都缺 → 400；手机号/邮箱格式非法 → 400；缺原因 → 400；用户不存在 → 404', async () => {
    const id = mockUsers[0]!.id;
    expect((await post(`/api/admin/users/${id}/rebind`, { reason: 'x' })).status).toBe(400);
    expect(
      (await post(`/api/admin/users/${id}/rebind`, { phone: '123', reason: 'x' })).status,
    ).toBe(400);
    expect(
      (await post(`/api/admin/users/${id}/rebind`, { email: 'nope', reason: 'x' })).status,
    ).toBe(400);
    expect(
      (await post(`/api/admin/users/${id}/rebind`, { phone: '13900000009' })).status,
    ).toBe(400);
    expect(
      (await post('/api/admin/users/usr_nope/rebind', { phone: '13900000009', reason: 'x' })).status,
    ).toBe(404);
  });
});

describe('POST /api/admin/orders/:orderNo/fulfill（人工补履约）', () => {
  const paidOrder = mockOrders.find((o) => o.status === 'paid')!;
  const pendingOrder = mockOrders.find((o) => o.status === 'pending');

  test('★mock 里永不真的履约：待支付单返回 409「渠道未确认到账」（不能凭空开权益）', async () => {
    if (!pendingOrder) throw new Error('mock 数据缺少 pending 订单，无法验证该路径');
    const auditBefore = mockAuditLogs.length;

    const resp = await post(`/api/admin/orders/${pendingOrder.orderNo}/fulfill`, {
      reason: '用户说付了',
    });

    expect(resp.status).toBe(409);
    const err = expectFail(resp);
    expect(err.message).toContain('未支付');
    // 没有任何审计 —— 因为什么都没做
    expect(mockAuditLogs.length).toBe(auditBefore);
  });

  test('已支付单 → 409 已履约；缺原因 → 400；订单不存在 → 404', async () => {
    expect(
      (await post(`/api/admin/orders/${paidOrder.orderNo}/fulfill`, { reason: 'x' })).status,
    ).toBe(409);
    if (pendingOrder) {
      expect(
        (await post(`/api/admin/orders/${pendingOrder.orderNo}/fulfill`, {})).status,
      ).toBe(400);
    }
    expect((await post('/api/admin/orders/ORD_nope/fulfill', { reason: 'x' })).status).toBe(404);
  });
});

describe('补录开票信息（GET / PATCH /api/admin/orders/:orderNo/invoice）', () => {
  const paidOrder = mockOrders.find((o) => o.status === 'paid')!;

  test('★已支付订单有票、抬头/税号初始为空（正是真实库的样子：履约链路不写这两列）', async () => {
    const { data } = expectOk(
      await get<{ hasInvoice: boolean; invoice: { invoiceNo: string; title: string | null } | null }>(
        `/api/admin/orders/${paidOrder.orderNo}/invoice`,
      ),
    );
    expect(data.hasInvoice).toBe(true);
    expect(data.invoice?.title).toBeNull();
  });

  test('★补录后能被回读（抬头+税号），并写审计', async () => {
    const auditBefore = mockAuditLogs.length;

    const { data } = expectOk(
      await patch<{ invoice: { title: string; taxNo: string } }>(
        `/api/admin/orders/${paidOrder.orderNo}/invoice`,
        { title: '某某科技有限公司', taxNo: '91310000MA1K3XYZ12', reason: '用户索要发票' },
      ),
    );
    expect(data.invoice.title).toBe('某某科技有限公司');
    expect(data.invoice.taxNo).toBe('91310000MA1K3XYZ12');
    expect(mockAuditLogs.length).toBe(auditBefore + 1);
    expect(mockAuditLogs[0]?.action).toBe('admin.invoice.update');

    // 再查一次：值已落库（回读）
    const again = expectOk(
      await get<{ invoice: { title: string } }>(`/api/admin/orders/${paidOrder.orderNo}/invoice`),
    );
    expect(again.data.invoice.title).toBe('某某科技有限公司');
  });

  test('校验：两项都不给 → 400；税号非法 → 400；缺原因 → 400；无票订单 → 404', async () => {
    const noInvoice = mockOrders.find((o) => o.status === 'pending' || o.status === 'cancelled');
    const o = paidOrder.orderNo;
    expect((await patch(`/api/admin/orders/${o}/invoice`, { reason: 'x' })).status).toBe(400);
    expect(
      (await patch(`/api/admin/orders/${o}/invoice`, { taxNo: '9131 0000', reason: 'x' })).status,
    ).toBe(400);
    expect((await patch(`/api/admin/orders/${o}/invoice`, { title: '抬头' })).status).toBe(400);
    if (noInvoice) {
      expect(
        (await patch(`/api/admin/orders/${noInvoice.orderNo}/invoice`, { title: '抬头', reason: 'x' }))
          .status,
      ).toBe(404);
    }
  });
});

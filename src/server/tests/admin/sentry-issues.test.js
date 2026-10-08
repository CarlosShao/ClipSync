import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET /api/admin/configs/sentry/issues —— 在后台内读 Sentry 错误列表（迁移 087）
 *
 * 背景：DSN 是**只写**凭据（只够上报），要在后台里看错误列表必须用 API Token。
 * 本文件钉住路由契约与"各类缺凭证场景给可执行提示、不假装能查"。
 * 全离线：mock pool + auth + utils/sentry.js（不出网）。
 */

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

const sentryStub = vi.hoisted(() => ({
  fetchSentryIssues: vi.fn(),
  initSentry: vi.fn(async () => false),
  invalidateSentryConfigCache: vi.fn(),
  invalidateSentryApiTokenCache: vi.fn(),
  captureError: vi.fn(() => false),
  flushSentry: vi.fn(async () => {}),
  isSentryEnabled: vi.fn(() => false),
}));

vi.mock('../../src/utils/sentry.js', () => sentryStub);

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const SAMPLE = {
  ok: true,
  orgId: '4507123456',
  projectId: '4507123456',
  records: [
    {
      id: '123',
      shortId: 'CLIPSYNC-1',
      title: 'TypeError: cannot read properties of undefined',
      culprit: 'src/routes/orders.js in handler',
      level: 'error',
      count: 7,
      userCount: 3,
      firstSeen: '2026-10-07T10:00:00Z',
      lastSeen: '2026-10-07T14:00:00Z',
      permalink: 'https://sentry.io/organizations/acme/issues/123/',
      status: 'unresolved',
    },
  ],
};

beforeEach(() => {
  clearPermCache();
  pool.query.mockReset();
  sentryStub.fetchSentryIssues.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.configs.view' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe('GET /api/admin/configs/sentry/issues', () => {
  it('正常：透出 issue 列表（含 permalink，供点进 Sentry 详情）', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue(SAMPLE);

    const res = await request(buildApp()).get('/api/admin/configs/sentry/issues');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.orgId).toBe('4507123456');
    expect(res.body.data.records[0]).toMatchObject({
      shortId: 'CLIPSYNC-1',
      level: 'error',
      count: 7,
      permalink: 'https://sentry.io/organizations/acme/issues/123/',
    });
    // 默认只看未解决 + 默认 limit 20
    expect(sentryStub.fetchSentryIssues).toHaveBeenCalledWith({ limit: 20, query: 'is:unresolved' });
  });

  it('透传 limit / query（自定义筛选）', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue({ ...SAMPLE, records: [] });

    const res = await request(buildApp()).get(
      '/api/admin/configs/sentry/issues?limit=5&query=' + encodeURIComponent('level:error is:unresolved')
    );

    expect(res.status).toBe(200);
    expect(sentryStub.fetchSentryIssues).toHaveBeenCalledWith({ limit: 5, query: 'level:error is:unresolved' });
  });

  it('只有 DSN 没有 Token ⇒ 409 且说清"DSN 只能上报、读列表要 Token"', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue({ ok: false, reason: 'no_api_token' });

    const res = await request(buildApp()).get('/api/admin/configs/sentry/issues');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(4090);
    expect(res.body.message).toContain('API Token');
    expect(res.body.message).toContain('只能上报');
  });

  it('未启用错误追踪 ⇒ 409 提示先配 DSN', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue({ ok: false, reason: 'not_configured' });

    const res = await request(buildApp()).get('/api/admin/configs/sentry/issues');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('未配置 Sentry DSN');
  });

  it('自托管 DSN 形状不支持 ⇒ 409 明确说不支持（不假装能查）', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue({
      ok: false,
      reason: 'unsupported_dsn',
      detail: '当前 DSN 不是 sentry.io 形状（自托管需另配 org/project），暂不支持在后台内查询',
    });

    const res = await request(buildApp()).get('/api/admin/configs/sentry/issues');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('不是 sentry.io 形状');
  });

  it('Token 被拒 ⇒ 409 且给出 scope 检查提示', async () => {
    sentryStub.fetchSentryIssues.mockResolvedValue({ ok: false, reason: 'token_rejected', detail: 'HTTP 401' });

    const res = await request(buildApp()).get('/api/admin/configs/sentry/issues');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('project:read');
  });
});

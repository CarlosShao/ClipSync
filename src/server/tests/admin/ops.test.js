/**
 * Admin Console · 运维监控 —— 支付宝渠道凭据自检（GET /api/admin/ops/alipay-status）
 *
 * 覆盖（routes/admin/ops.js，含 /api/admin 完整中间件链）：
 *  - 凭据未配置 → { ok:false, problems } 且明确点出缺哪一项
 *  - **公钥误填成「应用公钥」** → ok:false 并在 problems 里点明
 *    （最隐蔽也最致命的一种：回调验签 100% 失败 → 用户付了真钱、订阅永远不开；
 *      此前这条结论只在进程启动时打日志，运营在后台看不到）
 *  - 公钥确实是「支付宝公钥」（与我们的应用私钥不成对）→ ok:true、problems 为空
 *  - 权限：admin.ops.view（052 迁移已有的**只读**运维权限点，非写权限 admin.configs.manage）
 *  - 只读：除权限校验外不查库、不写库；响应里绝不含任何密钥值
 *
 * 全离线：vi.mock db/pool + middleware/auth；requirePerm 的权限查询按 SQL 特征放行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

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
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

/** requirePerm 的权限查询按 SQL 特征（perm_key）放行；其余查询一律空结果 */
function setupPermMock({ granted = true } = {}) {
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const hit = granted && params?.[1] === 'admin.ops.view';
      return hit
        ? { rows: [{ perm_key: 'admin.ops.view' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

// 应用私钥/应用公钥（**成对**）与「支付宝公钥」（与前者不成对，就是真实场景的等价物）
const { privateKey: APP_PRIV, publicKey: APP_PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const { publicKey: REAL_ALIPAY_PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];
const savedEnv = {};

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('GET /api/admin/ops/alipay-status —— 渠道凭据自检', () => {
  it('凭据未配置 → ok:false + problems 逐项点明（不抛错、不 500）', async () => {
    setupPermMock();
    for (const k of ENV_KEYS) delete process.env[k];

    const res = await request(buildApp()).get('/api/admin/ops/alipay-status');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.problems).toContain('ALIPAY_APP_ID 未配置');
    expect(res.body.data.problems).toContain('ALIPAY_PRIVATE_KEY 未配置');
  });

  it('公钥误填成「应用公钥」→ ok:false 且 problems 点明（这是会让回调验签 100% 失败的那种配置）', async () => {
    setupPermMock();
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = APP_PRIV;
    process.env.ALIPAY_PUBLIC_KEY = APP_PUB; // ← 与上面的应用私钥成对 = 填错了

    const res = await request(buildApp()).get('/api/admin/ops/alipay-status');

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.problems.some((p) => p.includes('应用公钥'))).toBe(true);
  });

  it('配置正确（公钥与私钥不成对 = 真的是支付宝公钥）→ ok:true、problems 为空', async () => {
    setupPermMock();
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = APP_PRIV;
    process.env.ALIPAY_PUBLIC_KEY = REAL_ALIPAY_PUB;

    const res = await request(buildApp()).get('/api/admin/ops/alipay-status');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, problems: [] });
  });

  it('只读：除权限校验外不查库；响应绝不回显密钥值', async () => {
    setupPermMock();
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = APP_PRIV;
    process.env.ALIPAY_PUBLIC_KEY = APP_PUB;

    const res = await request(buildApp()).get('/api/admin/ops/alipay-status');

    expect(res.status).toBe(200);
    const calls = pool.query.mock.calls.map(([sql]) => sql);
    expect(calls.every((sql) => sql.includes('perm_key'))).toBe(true); // 没有任何业务查询
    expect(calls.some((sql) => /UPDATE|INSERT|DELETE/i.test(sql))).toBe(false);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(body).not.toContain('BEGIN PUBLIC KEY');
    // 私钥体首行片段（去掉 PEM 头之后的前 32 个字符）
    const privBody = APP_PRIV.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').slice(0, 32);
    expect(privBody.length).toBe(32);
    expect(body).not.toContain(privBody);
  });

  it('无 admin.ops.view 权限 → 403 { code: 4030 }，连自检都不跑', async () => {
    setupPermMock({ granted: false });
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = APP_PRIV;
    process.env.ALIPAY_PUBLIC_KEY = APP_PUB;

    const res = await request(buildApp()).get('/api/admin/ops/alipay-status');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.ops.view' });
  });
});

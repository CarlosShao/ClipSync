/**
 * Admin Console 设备管理 APIs 单测（Admin Console · T-A1.5 补票）
 *
 * 覆盖（routes/admin/devices.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET  /devices/stats   页头统计 { total, online, byPlatform }
 *  - GET  /devices         分页壳 + AdminDevice 行映射 + 筛选（q/platform/status）
 *  - POST /devices/:id/offline  远程下线（仅在线可下线、原因必填、写审计 admin.device.offline）
 *
 * 全离线：vi.mock db/pool + middleware/auth（authenticateToken 按用例注入身份），
 * pool.query 以 SQL 片段特征分发 mock 结果（与 orders.test.js 同风格）。
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
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

// ── 夹具：DEVICE_SELECT 输出形态的设备行 ──
const DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';

function makeDeviceRow(overrides = {}) {
  return {
    id: DEVICE_ID,
    device_name: 'DESKTOP-7A2',
    device_type: 'desktop',
    platform: 'windows',
    platform_version: '11',
    app_version: '1.4.2',
    is_online: true,
    last_seen_at: new Date('2026-09-05T12:33:00Z'),
    owner_id: OWNER_ID,
    owner_nickname: '林清和',
    owner_phone: '13812342765',
    ...overrides,
  };
}

describe('GET /api/admin/devices —— 设备分页列表', () => {
  it('返回分页壳 { list, total, page, pageSize }，行字段符合 AdminDevice 契约', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.devices.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 2 }], rowCount: 1 };
      if (sql.includes('device_name')) {
        return {
          rows: [
            makeDeviceRow(),
            makeDeviceRow({
              id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2',
              device_name: 'Xiaomi 14',
              device_type: 'mobile',
              platform: 'android',
              platform_version: '15',
              is_online: false,
              last_seen_at: null,
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/devices?page=1&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ total: 2, page: 1, pageSize: 10 });
    expect(res.body.data.list).toHaveLength(2);

    expect(res.body.data.list[0]).toEqual({
      id: DEVICE_ID,
      name: 'DESKTOP-7A2',
      platform: 'windows',
      kind: 'desktop',
      os: '11',
      appVersion: '1.4.2',
      ownerId: OWNER_ID,
      ownerNickname: '林清和',
      ownerPhone: '138****2765',
      lastActiveAt: '2026-09-05 12:33',
      status: 'online',
    });
    expect(res.body.data.list[1].status).toBe('offline');
    expect(res.body.data.list[1].lastActiveAt).toBeNull();

    const [lastSql, lastParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastSql).toContain('ORDER BY d.last_seen_at DESC NULLS LAST');
    expect(lastParams.slice(-2)).toEqual([10, 0]);
  });

  it('q 关键词：设备名/属主昵称 ILIKE；纯数字关键词追加属主手机号后 4 位', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.devices.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      if (sql.includes('device_name')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await request(buildApp()).get('/api/admin/devices?q=Xiaomi');
    let [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('d.device_name ILIKE $1');
    expect(sql).toContain('u.nickname ILIKE $1');
    expect(sql).not.toContain('RIGHT(u.phone');
    expect(params[0]).toBe('%Xiaomi%');

    await request(buildApp()).get('/api/admin/devices?q=8834');
    [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('RIGHT(u.phone, 4) = $2');
    expect(params[1]).toBe('8834');
  });

  it('platform/status 筛选分别落到 d.platform / d.is_online；非法 status 返回 400', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.devices.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      if (sql.includes('device_name')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/devices?platform=windows&status=online');
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('d.platform = $1');
    expect(params[0]).toBe('windows');
    expect(sql).toContain('d.is_online = TRUE');

    const res2 = await request(buildApp()).get('/api/admin/devices?status=bogus');
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe(4000);
  });
});

describe('GET /api/admin/devices/stats —— 页头统计', () => {
  it('返回 { total, online, byPlatform }，平台分布计数为数值', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.devices.view' }], rowCount: 1 };
      if (sql.includes('FILTER (WHERE is_online)')) {
        return { rows: [{ total: 14, online: 8 }], rowCount: 1 };
      }
      if (sql.includes('GROUP BY platform')) {
        return {
          rows: [
            { platform: 'windows', count: 4 },
            { platform: 'macos', count: 5 },
            { platform: 'android', count: 3 },
            { platform: 'linux', count: 1 },
            { platform: 'ios', count: 1 },
          ],
          rowCount: 5,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/devices/stats');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({
      total: 14,
      online: 8,
      byPlatform: [
        { platform: 'windows', count: 4 },
        { platform: 'macos', count: 5 },
        { platform: 'android', count: 3 },
        { platform: 'linux', count: 1 },
        { platform: 'ios', count: 1 },
      ],
    });
  });

  it('无 admin.devices.view 权限返回 403 { code: 4030 }（RB-06）', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // 权限点未授予
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/devices/stats');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.devices.view' });
  });
});

describe('POST /api/admin/devices/:id/offline —— 远程下线', () => {
  function mockOfflineFlow(deviceRow, captured) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.devices.manage' }], rowCount: 1 };
      if (sql.includes('FROM devices d')) {
        return { rows: deviceRow ? [deviceRow] : [], rowCount: deviceRow ? 1 : 0 };
      }
      if (sql.includes('UPDATE devices')) {
        captured.update = { sql, params };
        // 模拟 DB 更新生效（下线后回读同一行）
        if (deviceRow) deviceRow.is_online = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('在线设备下线成功：is_online=false + last_seen_at=NOW() + 审计 admin.device.offline（敏感）', async () => {
    const captured = {};
    const row = makeDeviceRow();
    mockOfflineFlow(row, captured);

    const res = await request(buildApp())
      .post(`/api/admin/devices/${DEVICE_ID}/offline`)
      .send({ reason: '疑似丢失设备' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('设备已远程下线');
    expect(res.body.data.status).toBe('offline');

    expect(captured.update.sql).toContain('is_online = FALSE');
    expect(captured.update.sql).toContain('last_seen_at = NOW()');
    expect(captured.update.params).toEqual([DEVICE_ID]);

    expect(captured.audit.params[1]).toBe('admin.device.offline');
    expect(captured.audit.params[2]).toBe('device');
    expect(captured.audit.params[3]).toBe(DEVICE_ID);
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({
      device: 'DESKTOP-7A2',
      owner: '林清和',
      reason: '疑似丢失设备',
    });
  });

  it('离线设备重复下线返回 400 { code: 40005 }', async () => {
    const captured = {};
    mockOfflineFlow(makeDeviceRow({ is_online: false }), captured);

    const res = await request(buildApp())
      .post(`/api/admin/devices/${DEVICE_ID}/offline`)
      .send({ reason: '重复下线' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40005);
    expect(captured.update).toBeUndefined();
  });

  it('缺原因返回 400 { code: 4000 }，不产生任何写操作', async () => {
    const captured = {};
    mockOfflineFlow(makeDeviceRow(), captured);

    const res = await request(buildApp())
      .post(`/api/admin/devices/${DEVICE_ID}/offline`)
      .send({ reason: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.update).toBeUndefined();
  });

  it('设备不存在返回 404 { code: 40404 }', async () => {
    const captured = {};
    mockOfflineFlow(null, captured);

    const res = await request(buildApp())
      .post(`/api/admin/devices/${DEVICE_ID}/offline`)
      .send({ reason: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '设备不存在' });
  });

  it('无 admin.devices.manage 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .post(`/api/admin/devices/${DEVICE_ID}/offline`)
      .send({ reason: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.devices.manage' });
  });
});

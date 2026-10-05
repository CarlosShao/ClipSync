/**
 * 强制解绑设备单测（DELETE /api/admin/devices/:id，2026-10-05 新增）
 *
 * 为什么这个端点不能是"朴素 DELETE"：生产库实测（2026-10-05）——
 *   clipboard_items.source_device_id → devices(id) **ON DELETE CASCADE**
 * 也就是说删掉一行设备，会**连带删除该设备产生的全部剪贴板内容**（不可恢复）。
 * 用户侧自助解绑（routes/device.js）一直就是这个语义且不提示；管理台不能也这样。
 *
 * 所以本文件钉的核心判据只有一条，但它是这个端点的全部意义：
 *   ★条数 > 0 时**必须把条数回传确认**，否则 409 且**一个写操作都不发生**；
 *     条数对不上（预览 3 条、执行时 5 条）同样拒 —— 既防"随手毁内容"，
 *     也防"按旧计数删"的竞态。
 *
 * 其次钉住：与用户侧同一套收尾（广播 device_removed + 强制断开 WS，否则已解绑设备
 * 仍留在连接表里继续偷听 —— 2026-10-04 审计 S1-4）；越级防护；审计记被删条数。
 *
 * 全离线：pool 与 ws/server.js 都被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));
const wsMock = vi.hoisted(() => ({
  broadcastToUser: vi.fn(),
  forceDisconnectDevice: vi.fn(() => true),
  sendNotification: vi.fn(async () => ({ ok: true })),
}));

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

// 只替换这三个函数，其余（含连接表实现）保持真实
vi.mock('../../src/ws/server.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    broadcastToUser: wsMock.broadcastToUser,
    forceDisconnectDevice: wsMock.forceDisconnectDevice,
    sendNotification: wsMock.sendNotification,
  };
});

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

const DEVICE_ID = 'd1000000-0000-4000-8000-00000000000d';
const OWNER_ID = 'u1000000-0000-4000-8000-000000000001';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  wsMock.broadcastToUser.mockClear();
  wsMock.forceDisconnectDevice.mockClear();
  wsMock.sendNotification.mockClear();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  deviceExists = true,
  itemCount = 0,
  ownerLevel = 10,
  grantedPerms = ['admin.devices.manage'],
  deleteReturnsRow = true,
} = {}) {
  const calls = { countQueried: false, delete: null };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM devices d')) {
      return {
        rows: deviceExists
          ? [
              {
                id: DEVICE_ID,
                device_name: 'Desktop',
                device_type: 'desktop',
                platform: 'windows',
                platform_version: 'Windows 11',
                app_version: '1.2.3',
                is_online: true,
                last_seen_at: new Date('2026-10-05T10:00:00Z'),
                owner_id: OWNER_ID,
                owner_nickname: '未付款测试用户',
                owner_phone: '13800000002',
                owner_role_level: ownerLevel,
              },
            ]
          : [],
        rowCount: deviceExists ? 1 : 0,
      };
    }
    if (sql.includes('FROM clipboard_items')) {
      calls.countQueried = true;
      return { rows: [{ n: itemCount }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM devices')) {
      calls.delete = { sql, params };
      return { rows: deleteReturnsRow ? [{ id: DEVICE_ID }] : [], rowCount: deleteReturnsRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

const unbind = (body, id = DEVICE_ID) =>
  request(buildApp()).delete(`/api/admin/devices/${id}`).send(body);

describe('解绑设备 · ★内容保护闸（本端点的全部意义）', () => {
  it('★有内容但没回传条数 → 409 且一个写操作都不发生', async () => {
    const calls = mockPath({ itemCount: 5 });

    const res = await unbind({ reason: '设备丢失' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('CONTENT_WILL_BE_DELETED');
    expect(res.body.itemCount).toBe(5);
    expect(res.body.message).toContain('5 条');
    // 引导到"只想下线、保留内容"的那条路
    expect(res.body.message).toContain('远程下线');
    // 核心反例：不能先删了再说
    expect(calls.delete).toBeNull();
    expect(wsMock.broadcastToUser).not.toHaveBeenCalled();
    expect(findAuditCall('admin.device.unbind')).toBeUndefined();
  });

  it('★条数对不上（预览 3 条、执行时 5 条）→ 409，不按旧计数删', async () => {
    const calls = mockPath({ itemCount: 5 });

    const res = await unbind({ reason: 'x', confirmItemCount: 3 });

    expect(res.status).toBe(409);
    expect(res.body.itemCount).toBe(5);
    expect(calls.delete).toBeNull();
  });

  it('★回传条数正确 → 执行删除 + 广播 device_removed + 强制断开 WS + 审计记被删条数', async () => {
    const calls = mockPath({ itemCount: 5 });

    const res = await unbind({ reason: '设备丢失', confirmItemCount: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.removedItems).toBe(5);
    expect(res.body.message).toContain('5 条');
    expect(calls.delete.params).toEqual([DEVICE_ID]);

    // 与用户侧 DELETE /api/devices/:deviceId 同一套收尾
    expect(wsMock.broadcastToUser).toHaveBeenCalledWith(OWNER_ID, {
      type: 'device_removed',
      deviceId: DEVICE_ID,
    });
    expect(wsMock.forceDisconnectDevice).toHaveBeenCalledWith(
      OWNER_ID,
      DEVICE_ID,
      'device_unbound_by_admin'
    );

    const audit = findAuditCall('admin.device.unbind');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('removedItems');
    expect(payload).toContain('5');
    expect(payload).toContain('设备丢失');

    // 通知属主
    expect(wsMock.sendNotification).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ notificationType: 'device_notice' })
    );
  });

  it('无内容的设备：不需要确认即可解绑（条数为 0 时不该逼人填个 0）', async () => {
    const calls = mockPath({ itemCount: 0 });

    const res = await unbind({ reason: '闲置设备' });

    expect(res.status).toBe(200);
    expect(res.body.data.removedItems).toBe(0);
    expect(calls.delete).not.toBeNull();
  });
});

describe('解绑设备 · 保护闸与校验', () => {
  it('★越级防护：设备属主等级不低于操作者 → 403，且不计数、不删除', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const calls = mockPath({ ownerLevel: 50, itemCount: 3 });

    const res = await unbind({ reason: '越权尝试', confirmItemCount: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(calls.countQueried).toBe(false);
    expect(calls.delete).toBeNull();
  });

  it('设备不存在 → 404；ID 非法 → 400；缺原因 / 原因超长 → 400', async () => {
    mockPath({ deviceExists: false });
    expect((await unbind({ reason: 'x' })).status).toBe(404);

    mockPath();
    expect((await unbind({ reason: 'x' }, 'not-a-uuid')).status).toBe(400);
    expect((await unbind({})).status).toBe(400);
    expect((await unbind({ reason: '  ' })).status).toBe(400);
    expect((await unbind({ reason: 'x'.repeat(201) })).status).toBe(400);
  });

  it('并发已被删除（DELETE 返回 0 行）→ 404，不谎报成功', async () => {
    mockPath({ itemCount: 0, deleteReturnsRow: false });
    const res = await unbind({ reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('无 admin.devices.manage 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.devices.view'] });
    const res = await unbind({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

/**
 * Admin Console · 对单个用户定向通知单测（POST /api/admin/users/:id/notify）
 *
 * 这是 2026-10-05 补的入口：管理台此前只有「公告下发」，而公告受众只有
 * all / pro_plus / free 三个**群体** —— 想只告知一个人只能改库插 notification_history。
 * 通道本身早就有（ws/server.js 的 sendNotification = WS 实时推 + 落 notification_history）。
 *
 * 两个刻意设计要钉住：
 *  ① notificationType 由服务端白名单给出 —— 四个取值都落在客户端已有的分类映射上
 *   （useNotifications.typeToCategory 按 includes 匹配、未知类型兜底 'update'），
 *   所以**不需要客户端改代码**，老版本也能正确归类。非法值必须拒。
 *  ② 不检查 notification_preferences —— 用户关掉某类"推送偏好"不该屏蔽管理员/客服
 *   的直接告知。这条要是被后人"顺手补上"，私信就会静默丢失。
 *
 * 全离线：vi.mock db/pool + middleware/auth。
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

const TARGET_ID = 'd1000000-0000-4000-8000-00000000000d';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/**
 * 放行权限 + 目标用户存在。
 *
 * 权限 mock **按请求的 permKey 判定**（而不是"看到 perm_key 就给行"）——
 * 后者会让任何权限都放行，等于把「这个端点到底要求哪个权限」这条判据作废。
 * 这样写同时钉住：本端点要求的是 admin.announce.send，而不是 users.manage。
 */
function mockPath({ userExists = true, grantedPerms = ['admin.announce.send'] } = {}) {
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('WHERE u.id::text = $1')) {
      return {
        rows: userExists ? [{ id: TARGET_ID, nickname: '未付款测试用户' }] : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

function notify(body, id = TARGET_ID) {
  return request(buildApp()).post(`/api/admin/users/${id}/notify`).send(body);
}

describe('notify · 正常下发', () => {
  it('落 notification_history + 写审计 + 返回在线设备数（并如实说明触达情况）', async () => {
    mockPath();

    const res = await notify({ title: '关于你的赠期', body: '你获赠的一个月 Pro 已到账。' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.userId).toBe(TARGET_ID);
    expect(res.body.data.notificationType).toBe('admin_message');
    // 测试环境没有 WS 连接 ⇒ 0，且文案必须如实说明"对方当前看不到实时推送"
    expect(res.body.data.onlineDevices).toBe(0);
    expect(res.body.message).toContain('无在线设备');

    const persisted = pool.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notification_history')
    );
    expect(persisted).toBeTruthy();
    const flat = JSON.stringify(persisted[1]);
    expect(flat).toContain('关于你的赠期');
    expect(flat).toContain('admin_message');

    const audit = findAuditCall('admin.user.notify');
    expect(audit).toBeTruthy();
    expect(audit[1][0]).toBe('u-super');
  });

  it('白名单四类都接受，且都映射到客户端**已有**的分类（不需要客户端改代码）', async () => {
    for (const type of [
      'admin_message',
      'subscription_notice',
      'device_notice',
      'security_notice',
    ]) {
      mockPath();
      const res = await notify({ title: 't', body: 'b', notificationType: type });
      expect(res.status, type).toBe(200);
      expect(res.body.data.notificationType).toBe(type);
    }
  });

  it('不检查通知偏好：用户关掉某类推送也不该屏蔽管理员的直接告知', async () => {
    mockPath();
    await notify({ title: 't', body: 'b' });

    // 只要没有去读 notification_preferences 就说明这条口径没被"顺手补上"
    const touchedPrefs = pool.query.mock.calls.some(([sql]) =>
      sql.includes('notification_preferences')
    );
    expect(touchedPrefs).toBe(false);
  });

  it('审计只留正文预览（前 200 字），不把整篇塞进审计表', async () => {
    mockPath();
    const long = 'x'.repeat(500);
    await notify({ title: 't', body: long });

    const audit = findAuditCall('admin.user.notify');
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).toContain('bodyPreview');
    expect(payload).not.toContain('x'.repeat(201));
  });
});

describe('notify · 入参校验', () => {
  it('缺标题或正文 → 400', async () => {
    mockPath();
    expect((await notify({ body: 'b' })).status).toBe(400);
    expect((await notify({ title: 't' })).status).toBe(400);
    expect((await notify({ title: '  ', body: '  ' })).status).toBe(400);
  });

  it('标题超 100 字 / 正文超 500 字 → 400', async () => {
    mockPath();
    expect((await notify({ title: 'x'.repeat(101), body: 'b' })).status).toBe(400);
    expect((await notify({ title: 't', body: 'x'.repeat(501) })).status).toBe(400);
  });

  it('notificationType 不在白名单 → 400（不允许运营自由填，否则客户端分类会漂）', async () => {
    mockPath();
    const res = await notify({ title: 't', body: 'b', notificationType: 'whatever_i_want' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('notificationType');
  });

  it('用户不存在 → 404', async () => {
    mockPath({ userExists: false });
    const res = await notify({ title: 't', body: 'b' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40404);
  });

  it('用户 ID 非法 → 400', async () => {
    mockPath();
    const res = await notify({ title: 't', body: 'b' }, 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('无 admin.announce.send 权限 → 403（这是"对外触达"能力，不该被 users.manage 顶替）', async () => {
    // 只给 users.manage：若本端点错误地要求了 users.manage，这条就会 200 而失败
    mockPath({ grantedPerms: ['admin.users.manage'] });
    const res = await notify({ title: 't', body: 'b' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

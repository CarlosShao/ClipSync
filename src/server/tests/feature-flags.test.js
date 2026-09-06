import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { invalidateFlagsCache } from '../src/utils/featureFlags.js';

/**
 * 功能开关服务端强制生效（feature_flags → requireFlag / 注册待审 / 管理端写库）
 * 覆盖：AI 关闭 403 / 分享创建 403 / 2FA 绑定 403 / 开关持久化 / 注册进待审 + 登录拦截 + 审批放行。
 *
 * 混合模式（与 admin/*.test.js 同风格）：authenticateToken 打桩注入身份（test 环境真实链路
 * 会被固定 level=10 测试用户替换，无法进管理端），但 requirePerm 的权限点、开关读写、
 * 注册/登录流程全部走真库（clipsync_test）。
 */

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => {
    if (authState.user) {
      req.user = { ...authState.user };
      req.userId = authState.user.userId;
    }
    next();
  }),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

const ADMIN_PHONE = '13505110772'; // 028 种子内置超管
const WAITLIST_PHONE = '13800990002';

let app;
let adminId;
let waitlistUserId;

/** 直接写库切开关并失效缓存（等价管理端 PATCH 的持久化效果） */
async function setFlag(key, enabled) {
  await pool.query(
    'UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE flag_key = $1',
    [key, enabled]
  );
  invalidateFlagsCache();
}

/** 验证码登录（test 环境 MVP 固定码 888888）；新手机号即自动注册（需带 ToS 同意） */
async function codeLogin(phone) {
  await request(app).post('/api/auth/send-code').send({ phone });
  return request(app)
    .post('/api/auth/verify-code')
    .send({ phone, code: '888888', accept_tos: true, accept_privacy: true });
}

beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = mod.app;

  // 测试库超管幂等准备：028 有超管防删触发器，不能 DELETE——绑角色，缺人则补建
  await pool.query(
    `UPDATE users SET role_id = (SELECT id FROM roles WHERE role_key = 'super_admin')
     WHERE phone = $1`,
    [ADMIN_PHONE]
  );
  await pool.query(
    `INSERT INTO users (phone, nickname, role_id, created_at)
     SELECT $1::varchar, 'SuperAdmin', (SELECT id FROM roles WHERE role_key = 'super_admin'), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE phone = $1::varchar)`,
    [ADMIN_PHONE]
  );
  const { rows } = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.phone = $1 AND r.role_key = 'super_admin' LIMIT 1`,
    [ADMIN_PHONE]
  );
  adminId = rows[0].id;
  // 打桩身份 = 真库超管（requirePerm 仍走真库权限点校验）
  authState.user = { userId: adminId, roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

afterAll(async () => {
  // 恢复开关默认值 + 清理测试用户（防污染测试库）
  await pool.query(
    `UPDATE feature_flags SET enabled = TRUE
     WHERE flag_key IN ('enable_ai_agent','enable_subscription','enable_public_sharing','enable_2fa')`
  );
  await pool.query(`UPDATE feature_flags SET enabled = FALSE WHERE flag_key = 'signup_waitlist'`);
  invalidateFlagsCache();
  if (waitlistUserId) {
    await pool.query('DELETE FROM users WHERE id = $1', [waitlistUserId]);
  }
});

describe('功能开关服务端强制生效', () => {
  it('enable_ai_agent 关闭 → AI 接口 403 且带 flagDisabled；开启 → 放行', async () => {
    await setFlag('enable_ai_agent', false);
    const blocked = await request(app).get('/api/ai/providers');
    expect(blocked.status).toBe(403);
    expect(blocked.body.flagDisabled).toBe('enable_ai_agent');
    expect(blocked.body.error).toContain('AI 助手已由管理员关闭');

    await setFlag('enable_ai_agent', true);
    const ok = await request(app).get('/api/ai/providers');
    expect(ok.status).toBeLessThan(500);
    expect(ok.body.flagDisabled).toBeUndefined();
  });

  it('enable_public_sharing 关闭 → 创建分享 403', async () => {
    await setFlag('enable_public_sharing', false);
    const res = await request(app)
      .post('/api/shared-links')
      .send({ content: 'hello', title: 't', contentType: 'text' });
    expect(res.status).toBe(403);
    expect(res.body.flagDisabled).toBe('enable_public_sharing');
    await setFlag('enable_public_sharing', true);
  });

  it('enable_2fa 关闭 → 2fa/setup 403（status 查询不受影响）', async () => {
    await setFlag('enable_2fa', false);
    const blocked = await request(app).post('/api/auth/2fa/setup').send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.flagDisabled).toBe('enable_2fa');

    const status = await request(app).get('/api/auth/2fa/status');
    expect(status.status).toBe(200);
    await setFlag('enable_2fa', true);
  });

  it('开关持久化：PATCH 管理端点写库后 GET /api/app/feature-flags 反映新值', async () => {
    const before = await request(app).get('/api/app/feature-flags');
    expect(before.status).toBe(200);
    expect(before.body.flags.enable_ai_agent).toBe(true);

    const patched = await request(app)
      .patch('/api/admin/flags/enable_ai_agent')
      .send({ enabled: false });
    expect(patched.status).toBe(200);

    const after = await request(app).get('/api/app/feature-flags');
    expect(after.body.flags.enable_ai_agent).toBe(false);
    await setFlag('enable_ai_agent', true);
  });

  it('signup_waitlist 开启 → 新注册进待审（不发令牌）→ 重复登录被拦 → 管理员审批后可登录', async () => {
    await setFlag('signup_waitlist', true);

    // 首次验证码登录 = 注册：进入待审，无 token
    const first = await codeLogin(WAITLIST_PHONE);
    expect(first.body.pendingReview).toBe(true);
    expect(first.body.token).toBeUndefined();

    // 再次登录被拦截
    const second = await request(app)
      .post('/api/auth/verify-code')
      .send({ phone: WAITLIST_PHONE, code: '888888' });
    expect(second.status).toBe(403);
    expect(second.body.pendingReview).toBe(true);

    // 管理员审批
    const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [WAITLIST_PHONE]);
    waitlistUserId = rows[0].id;
    const approve = await request(app)
      .post(`/api/admin/users/${waitlistUserId}/approve`)
      .send({});
    expect(approve.status).toBe(200);

    // 审批后可正常登录
    const third = await request(app)
      .post('/api/auth/verify-code')
      .send({ phone: WAITLIST_PHONE, code: '888888' });
    expect(third.status).toBe(200);
    expect(third.body.token).toBeTruthy();

    await setFlag('signup_waitlist', false);
  });

  it('审批越界：不存在的用户 → 404；非待审用户 → 409', async () => {
    const missing = await request(app)
      .post(`/api/admin/users/${crypto.randomUUID()}/approve`)
      .send({});
    expect(missing.status).toBe(404);

    const normal = await request(app)
      .post(`/api/admin/users/${adminId}/approve`)
      .send({});
    expect(normal.status).toBe(409);
  });
});

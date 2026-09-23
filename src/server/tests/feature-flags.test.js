import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { invalidateFlagsCache } from '../src/utils/featureFlags.js';
import { signAccessToken } from './test-helpers.js';

/**
 * 功能开关服务端强制生效（feature_flags → requireFlag / 注册待审 / 管理端写库）
 * 覆盖：AI 关闭 403 / 分享创建 403 / 2FA 绑定 403 / 开关持久化 / 注册进待审 + 登录拦截 + 审批放行。
 *
 * 混合模式（与 admin/*.test.js 同风格）：authenticateToken 打桩注入身份，但 requirePerm 的权限点、
 * 开关读写、注册/登录流程全部走真库（clipsync_test）。
 *
 * ⚠ P0-C/C1 更正：此处原注释写的是「test 环境真实链路会被固定 level=10 测试用户替换」——
 * auth.js 的 `NODE_ENV==='test'` 注入旁路已删除，该说法不再成立。打桩的理由改为：
 * 本文件要固定一个**超管**身份（roleLevel=100）来走管理端点，用 vi.mock 注入比给固定用户提权更干净。
 * 注意打桩只替换了 authenticateToken：csrf.js 仍是真的，所以写请求必须带 Bearer 头
 * （见 'enable_public_sharing' 用例的注释）。
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
    // P0-C/C1：本用例原先不带任何认证头，靠 csrf.js 的 `NODE_ENV==='test'` 旁路才穿得过去。
    // 旁路拆除后 csrfProtection 先返回 403 {code:'CSRF_INVALID'}，**根本没走到 requireFlag**
    // ——403 状态码相同但 body 里没有 flagDisabled。
    // 生产上这个端点的调用方一定是带 Bearer 的已登录客户端（csrf.js:151-157 对 Bearer 放行，
    // 本站无 cookie 认证），所以这里补上真签名的 Bearer 头，让请求成为一条真实的生产形态请求。
    // 挂载顺序（routes/sharedLinks.js:254）：apiLimiter → authenticateToken → csrfProtection
    // → apiLimiter → requireFlag('enable_public_sharing') → handler；
    // flagDisabled 只可能由 utils/featureFlags.js:59 的 requireFlag 写入。
    // 因此额外断言错误文案，把这个 403 钉死在开关闸门上（防止再次被别的闸门冒名顶替）。
    const res = await request(app)
      .post('/api/shared-links')
      .set('Authorization', `Bearer ${signAccessToken({ userId: adminId })}`)
      .send({ content: 'hello', title: 't', contentType: 'text' });
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('CSRF_INVALID');
    expect(res.body.flagDisabled).toBe('enable_public_sharing');
    expect(res.body.error).toContain('共享链接功能已由管理员关闭');
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

    // 再次登录被拦截（验证码一次性消费，每次登录前需重新发码）
    const second = await codeLogin(WAITLIST_PHONE);
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
    const third = await codeLogin(WAITLIST_PHONE);
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

/**
 * S0 认证安全修复的针对性验证
 *
 * ⚠ P0-C/C1 更正本文件头（原文称「生产代码里 authenticateToken / csrf / 部分 limiter 在
 * NODE_ENV=test 下是 no-op」——那批旁路现已全部拆除，下列分类的意义随之变化）：
 *   1. 中间件单元测试：下面的 `process.env.NODE_ENV = 'development'` 已成**冗余**
 *      （auth.js 不再有环境分支），保留仅作防御性说明，不再改变任何行为；
 *   2. HTTP 集成测试：走 storeName != 'api' 的限流器与验证码消费路径
 *      （这些从来不被旁路），验证限流分桶、重置码一次性、找回密码不回显码。
 *      limiter 的用例隔离由 tests/setup.js 的 beforeEach(resetAllRateLimitStores) 提供，
 *      所以**每条用例自己打满阈值**，不再依赖同文件相邻用例的残留计数。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool.js';
import config from '../src/config.js';
import * as authMiddleware from '../src/middleware/auth.js';

let app;

const createdUserIds = [];
const createdIdentifiers = [];

/** 唯一标识，避免与其它测试文件/重复运行冲突 */
const stamp = Date.now().toString().slice(-5);
const phone = (suffix) => `1390${stamp}${suffix}`.slice(0, 11);
/** verification_codes.phone 列为 VARCHAR(20)，测试邮箱必须控制在 20 字符内 */
const email = (prefix) => `${prefix}${stamp}@e.co`.slice(0, 20);

async function createAccount({ phone: p, email, nickname, password }) {
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const { rows } = await pool.query(
    `INSERT INTO users (phone, email, nickname, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
    [p, email || null, nickname || null, hash]
  );
  createdUserIds.push(rows[0].id);
  if (p) createdIdentifiers.push(p);
  if (email) createdIdentifiers.push(email);
  return rows[0].id;
}

async function insertCode(identifier, code, used = false) {
  await pool.query(
    `INSERT INTO verification_codes (phone, code, expires_at, used)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes', $3)`,
    [identifier, code, used]
  );
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

beforeAll(async () => {
  // 延迟导入 app，避免模块加载期触发 server.listen()
  const mod = await import('../src/index.js');
  app = mod.app;

  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[auth-s0] 仅允许在 clipsync_test 库运行，当前连接的是 ${dbName}`);
  }
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  for (const identifier of createdIdentifiers) {
    await pool.query('DELETE FROM verification_codes WHERE phone = $1', [identifier]).catch(() => {});
  }
});

// ============================================
// 修复 3：2FA 挑战令牌不得被当作登录态
// ============================================
describe('S0-3 2FA 挑战令牌不是 access token', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const challengeToken = jwt.sign(
    { userId, twoFactorChallenge: true, tokenType: '2fa_challenge' },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
  const legacyChallengeToken = jwt.sign(
    { userId, twoFactorChallenge: true },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
  const plainAccessToken = jwt.sign(
    {
      userId: '00000000-0000-4000-8000-00000000dead',
      sessionId: '00000000-0000-4000-8000-00000000beef',
      jti: '00000000-0000-4000-8000-00000000beef',
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );

  it('authenticateToken 拒绝挑战令牌（新格式与旧格式）', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development'; // 绕过 test 环境旁路，走真实校验分支
    try {
      for (const token of [challengeToken, legacyChallengeToken]) {
        const req = { headers: { authorization: `Bearer ${token}` }, get: () => '' };
        const res = fakeRes();
        let nextCalled = false;
        await authMiddleware.authenticateToken(req, res, () => { nextCalled = true; });

        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(req.user).toBeUndefined();
      }
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('authenticateToken 对普通 access token 不因类型检查而误杀（错误来自账号校验而非挑战令牌）', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const req = { headers: { authorization: `Bearer ${plainAccessToken}` }, get: () => '' };
      const res = fakeRes();
      let nextCalled = false;
      await authMiddleware.authenticateToken(req, res, () => { nextCalled = true; });

      // 账号不存在 → 401 Account not found；关键是不得命中挑战令牌分支
      expect(res.body?.error).not.toBe('Two-factor verification required');
      expect(res.statusCode).toBe(401);
      expect(nextCalled).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('require2faChallenge 只放行挑战令牌，拒绝普通 access token', async () => {
    // 头部传令牌
    const reqOk = { headers: { authorization: `Bearer ${challengeToken}` }, body: {} };
    const resOk = fakeRes();
    let okCalled = false;
    authMiddleware.require2faChallenge(reqOk, resOk, () => { okCalled = true; });
    expect(okCalled).toBe(true);
    expect(reqOk.twoFactorChallenge.userId).toBe(userId);
    expect(reqOk.user).toBeUndefined(); // 不得注入登录态
    expect(reqOk.userId).toBeUndefined();

    // 请求体传令牌（/2fa/verify-login 现用形态）
    const reqBody = { headers: {}, body: { challengeToken, code: '123456' } };
    const resBody = fakeRes();
    let bodyCalled = false;
    authMiddleware.require2faChallenge(reqBody, resBody, () => { bodyCalled = true; });
    expect(bodyCalled).toBe(true);

    // 普通 access token → 拒绝
    const reqBad = { headers: { authorization: `Bearer ${plainAccessToken}` }, body: {} };
    const resBad = fakeRes();
    let badCalled = false;
    authMiddleware.require2faChallenge(reqBad, resBad, () => { badCalled = true; });
    expect(badCalled).toBe(false);
    expect(resBad.statusCode).toBe(401);

    // 无令牌 / 垃圾令牌 → 拒绝
    for (const req of [{ headers: {}, body: {} }, { headers: { authorization: 'Bearer garbage' }, body: {} }]) {
      const res = fakeRes();
      let called = false;
      authMiddleware.require2faChallenge(req, res, () => { called = true; });
      expect(called).toBe(false);
      expect(res.statusCode).toBe(401);
    }
  });

  it('optionalAuth 不把挑战令牌当身份', () => {
    const req = { headers: { authorization: `Bearer ${challengeToken}` } };
    let called = false;
    authMiddleware.optionalAuth(req, fakeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
    expect(req.userId).toBeUndefined();
  });
});

// ============================================
// 修复 1：找回密码不得回显重置码
// ============================================
describe('S0-1 找回密码不泄漏重置码', () => {
  const existingEmail = email('s0fp1');
  const missingEmail = email('s0fp9');
  let existingAccountResponse;

  it('SMTP 未配置时返回通用文案，响应体不含 code', async () => {
    await createAccount({ phone: phone('01'), email: existingEmail });
    delete process.env.AUTH_EXPOSE_RESET_CODE;

    const res = await request(app).post('/api/auth/forgot-password').send({ email: existingEmail });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toMatch(/If this account is registered/);
    existingAccountResponse = res.body.message;
  });

  it('账号不存在时响应与账号存在时完全一致（防枚举）', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: missingEmail });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toBe(existingAccountResponse);
  });

  it('逃生口需双重条件：非生产 + AUTH_EXPOSE_RESET_CODE=true 才回显 6 位码', async () => {
    process.env.AUTH_EXPOSE_RESET_CODE = 'true';
    try {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: existingEmail });
      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^\d{6}$/);
    } finally {
      delete process.env.AUTH_EXPOSE_RESET_CODE;
    }

    // 逃生口关闭后再次请求：不得回显
    const res2 = await request(app).post('/api/auth/forgot-password').send({ email: existingEmail });
    expect(res2.body.code).toBeUndefined();
  });
});

// ============================================
// 修复 2：重置码一次性消费 + 限流
// ============================================
describe('S0-2 重置码一次性消费且受爆破限流', () => {
  const resetEmail = email('s0rp1');
  const code = '246810';

  it('同一重置码只能用一次，第二次 401', async () => {
    const userId = await createAccount({ phone: phone('02'), email: resetEmail });
    await insertCode(resetEmail, code);

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: resetEmail, code, newPassword: 'FirstPass123!' });
    expect(first.status).toBe(200);

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    expect(rows[0].password_hash).toBeTruthy();
    expect(await bcrypt.compare('FirstPass123!', rows[0].password_hash)).toBe(true);

    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: resetEmail, code, newPassword: 'SecondPass456!' });
    expect(second.status).toBe(401);

    // 密码未被第二次请求改写
    const after = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    expect(await bcrypt.compare('FirstPass123!', after.rows[0].password_hash)).toBe(true);

    const usedRow = await pool.query(
      'SELECT used FROM verification_codes WHERE phone = $1 AND code = $2',
      [resetEmail, code]
    );
    expect(usedRow.rows[0].used).toBe(true);
  });

  it('已使用过的码（used=TRUE）直接不可用', async () => {
    const email2 = email('s0rp3');
    await createAccount({ phone: phone('03'), email: email2 });
    await insertCode(email2, '135790', true);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: email2, code: '135790', newPassword: 'ThirdPass789!' });
    expect(res.status).toBe(401);
  });

  it('连续尝试触发 429（每 IP / 每账号 15 分钟 5 次）', async () => {
    const email3 = email('s0rp4');
    // P0-C/C1 更正（原注释：「前面的用例已消耗 3 次 IP 额度，这里再打 4 次必然越过阈值」）：
    // 这条用例过去**依赖同文件前两条用例残留在 authCode IP 桶里的 3 次计数**才凑满阈值。
    // 现在 tests/setup.js 在每个用例前清零限流桶（用例隔离，替代被拆除的 NODE_ENV 旁路），
    // 跨用例累加不再成立 ⇒ 4 次请求全部落到业务层的 401。
    // 阈值本身没有被改小或改大：authCodeIpLimiter / authCodeAccountLimiter 仍是
    // max=5 / windowMs=15min（rateLimiter.js:326-340），且内存桶是「满 5 放行、第 6 拒」。
    // 因此正确写法是在**同一用例内**打满：前 5 次必须是真认证失败 401（限流器不得吞业务响应），
    // 第 6 次必须 429 —— 这比原来的 toContain(429) 更强（同时钉住了阈值精确值）。
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ email: email3, code: '000000', newPassword: 'BruteForce1!' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

// ============================================
// 修复 5：限流按身份分桶，不再共用 unknown 桶
// ============================================
describe('S1-5 限流键按身份分桶', () => {
  it('邮箱 A 打满 5 次后 429，邮箱 B 不受影响（旧实现会共用 unknown 桶）', async () => {
    const emailA = email('s0rla');
    const emailB = email('s0rlb');

    const statusesA = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: emailA });
      statusesA.push(res.status);
    }
    expect(statusesA.filter((s) => s === 429).length).toBeGreaterThan(0);

    const resB = await request(app).post('/api/auth/forgot-password').send({ email: emailB });
    expect(resB.status).not.toBe(429);
  });
});

// ============================================
// 修复 4：登录不再按昵称/邮箱自动搬移他人数据
// ============================================
describe('S0-4 登录不自动合并同昵称账号', () => {
  const nickname = `s0merge${stamp}`.slice(0, 20);

  it('攻击者用同昵称登录后，受害者数据与账号均未被搬走', async () => {
    const victimId = await createAccount({ phone: phone('04'), nickname });
    const attackerId = await createAccount({
      phone: phone('05'),
      nickname,
      password: 'AttackerPass1!',
    });
    const { rows } = await pool.query(
      `INSERT INTO clipboard_items (user_id, content_type, content_encrypted, content_preview, content_size, metadata, created_at, updated_at)
       VALUES ($1, 'text', 'victim-secret', 'victim-secret', 13, '{}'::jsonb, NOW(), NOW()) RETURNING id`,
      [victimId]
    );
    const clipId = rows[0].id;

    const res = await request(app)
      .post('/api/auth/login')
      .send({ account: nickname, password: 'AttackerPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    const clip = await pool.query('SELECT user_id FROM clipboard_items WHERE id = $1', [clipId]);
    expect(clip.rows[0].user_id).toBe(victimId);

    const victim = await pool.query('SELECT merged_into, nickname, phone FROM users WHERE id = $1', [victimId]);
    expect(victim.rows[0].merged_into).toBeNull();
    expect(victim.rows[0].nickname).toBe(nickname);
    expect(victim.rows[0].phone).toBe(phone('04'));

    // 攻击者账号未被合并掉
    const attacker = await pool.query('SELECT merged_into FROM users WHERE id = $1', [attackerId]);
    expect(attacker.rows[0].merged_into).toBeNull();
  });
});

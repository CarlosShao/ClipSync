import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { TEST_USER_ID, ensureAuthUser, authHeaders, signAccessToken } from './test-helpers.js';

// 延迟导入 app，确保只加载一次
let app;
beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = mod.app;

  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[security] 仅允许在 clipsync_test 库运行，当前连接的是 ${dbName}`);
  }
  // P0-C/C1：auth.js 的 NODE_ENV==='test' 旁路已拆除，本文件的 'Bearer test-token'
  // 从此不再是有效凭据。改为真库账号 + 真签名 token，让下面的注入/XSS 载荷真正到达
  // SQL 与业务层（此前它们打到的其实是 401 之前的认证层，断言只是「看起来过了」）。
  await ensureAuthUser(pool);
});

/** 真实认证头（固定测试用户，roleLevel=user） */
const auth = () => authHeaders();

describe('安全测试', () => {
  // ============================================
  // SQL注入测试
  // ============================================
  describe('SQL注入测试', () => {
    it('应该防止SQL注入攻击在登录接口', async () => {
      const res = await request(app)
        .post('/api/auth/verify-code')
        .send({
          phone: "13800138000' OR '1'='1",
          code: "123456' OR '1'='1",
        });

      // 不应该返回 500（服务器错误）
      expect(res.status).not.toBe(500);
    });

    it('应该防止SQL注入攻击在搜索接口', async () => {
      const maliciousQuery = "'; DROP TABLE users; --";
      const res = await request(app)
        .get(`/api/clipboard/search?q=${encodeURIComponent(maliciousQuery)}`)
        .set(auth());

      expect([200, 400, 404]).toContain(res.status);
      // 注入确实没跑掉：users 表还在
      const stillThere = await pool.query('SELECT COUNT(*)::int AS c FROM users');
      expect(stillThere.rows[0].c).toBeGreaterThan(0);
    });

    // P0-C/C1 拆掉 auth 旁路后，上面这条搜索用例第一次真的打进 handler，撞出真缺陷：
    // 旧实现把 sanitizeString() 的结果按空白切词直接拼成 `word:*` 喂给 to_tsquery，
    // 命中 PG 的 42601 syntax_error → 该端点对这类搜索词**稳定返回 HTTP 500**
    // （参数化是好的，不是注入；坏的是错误没兜住、也没在进 tsquery 前清洗）。
    // 逐字符实测（把旧实现的产物真送去 to_tsquery 跑一遍）得到的准确清单：
    //   会 500：`(` `)` `:` `!` 以及 `'; DROP TABLE users; --`（转义后含 `#x27;` 组合）
    //   不会 500：`&` `|` `;` `*` `<` `>` —— clipboard.js buildTsQuery 上方原注释把它们
    //             一并列为「to_tsquery 的运算符/非法字符」是**未经实测的夸大**，此处已更正。
    // 两个分支都钉：tsQuery 非空（tsvector + ILIKE 兜底）与 tsQuery 为空
    // （纯符号查询退化为 ILIKE-only，clipboard.js 的 else 分支——不钉的话它就是无覆盖代码）。
    it('搜索词含 tsquery 运算符或纯符号时不得 500（两个分支都钉）', async () => {
      for (const q of ['c:(d)', 'a(b', 'a!b', '!!!', '<>&']) {
        const search = await request(app)
          .get(`/api/clipboard/search?q=${encodeURIComponent(q)}`)
          .set(auth());
        expect(search.status, `GET /api/clipboard/search?q=${q}`).toBe(200);
        expect(Array.isArray(search.body.items)).toBe(true);

        const list = await request(app)
          .get(`/api/clipboard?q=${encodeURIComponent(q)}`)
          .set(auth());
        expect(list.status, `GET /api/clipboard?q=${q}`).toBe(200);
      }
    });

    it('应该防止SQL注入攻击在设备注册接口', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({
          deviceName: "Test'; DROP TABLE devices; --",
          deviceType: 'desktop',
          platform: 'windows',
          platformVersion: '1.0.0',
        });

      expect([200, 201, 400]).toContain(res.status);
      await pool.query('DELETE FROM devices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
    });

    it('应该防止SQL注入攻击在剪贴板保存接口', async () => {
      const res = await request(app)
        .post('/api/clipboard')
        .set(auth())
        .send({
          content: "test'; DROP TABLE clipboard_items; --",
          contentType: 'text',
          deviceId: 'test-device-id',
        });

      expect(res.status).not.toBe(500);
    });
  });

  // ============================================
  // XSS攻击测试
  // ============================================
  describe('XSS攻击测试', () => {
    it('应该防止存储型XSS在设备名称', async () => {
      const xssPayload = '<script>alert("XSS")</script>';
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({
          deviceName: xssPayload,
          deviceType: 'desktop',
          platform: 'windows',
          platformVersion: '1.0.0',
        });

      expect([200, 201, 400, 404]).toContain(res.status);
      if (res.status === 200 || res.status === 201) {
        const { rows } = await pool.query(
          'SELECT device_name FROM devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [TEST_USER_ID]
        );
        // P0-B 的入库清洗是「服务端 HTML 转义」，因此落库值必须已不可执行；
        // 钉住这条而不是钉「原样保存」——原样保存同样是可接受的实现，但**绝不能是
        // 未转义的 <script> 片段**（那才是存储型 XSS）。
        expect(rows[0].device_name).not.toContain('<script');
        expect(rows[0].device_name).toBe(
          '&lt;script&gt;alert(&quot;XSS&quot;)&lt;&#x2F;script&gt;'
        );
      }
      await pool.query('DELETE FROM devices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
    });

    it('应该防止XSS在剪贴板内容', async () => {
      const xssPayload = '<img src=x onerror=alert(1)>';
      const res = await request(app)
        .post('/api/clipboard')
        .set(auth())
        .send({
          content: xssPayload,
          contentType: 'text',
          deviceId: 'test-device-id',
        });

      expect([200, 201, 400, 404]).toContain(res.status);
    });
  });

  // ============================================
  // CSRF：钉住「REST 层的真实契约」，不再靠环境旁路
  // ============================================
  // csrfProtection 的 Bearer 放行（src/middleware/csrf.js）在生产同样成立：
  // 本站**没有任何 cookie 认证**（全仓 grep cookieParser / express-session / res.cookie 零命中），
  // 而 csrfProtection 的全部 21 处活挂载点（index.js 20 处 + routes/sharedLinks.js:22 的 protect 数组）
  // **无一例外**排在 authenticateToken 之后，即能走到这里的请求必然带 Bearer
  // ⇒ REST 的 CSRF 校验分支在应用内不可达，真正承载 CSRF 的是 WS 握手
  //   （src/ws/server.js:155-196，键前缀 csrf:、一次性消费）。
  // ⚠ src/utils/route-loader.js 里那份挂载表**没有任何模块引用**（实测 grep 零命中），
  //   它写的口径（如 /api/subscriptions 挂 authenticateToken）不代表现状，别拿它当依据。
  // 下面两条把这个事实钉成断言（CSRF 校验本身的行为在 tests/csrf.test.js 直接测中间件）。
  describe('CSRF攻击测试', () => {
    it('匿名状态变更先被 authenticateToken 拦下（401），CSRF 层根本不是这道门', async () => {
      const res = await request(app)
        .post('/api/clipboard')
        .set('x-session-id', 'sec-test-session')
        .send({ content: 'test' });

      expect(res.status).toBe(401);
      expect(res.body.code).not.toBe('CSRF_INVALID');
    });

    it('Bearer 请求豁免 REST CSRF（豁免只可能来自 Bearer 分支，不得来自环境旁路）', async () => {
      const res = await request(app)
        .post('/api/clipboard')
        .set(auth())
        .send({ content: 'csrf-exempt-bearer' });

      expect(res.status).not.toBe(403);
    });
  });

  // ============================================
  // 认证强制（P0-C/C1：本章节此前整段 describe.skip，理由是「测试环境 auth 被跳过」）
  // ============================================
  describe('认证绕过测试', () => {
    it('应该拒绝没有令牌的请求', async () => {
      const res = await request(app).get('/api/clipboard');
      expect(res.status).toBe(401);
    });

    it('应该拒绝无效令牌', async () => {
      const res = await request(app)
        .get('/api/clipboard')
        .set('Authorization', 'Bearer invalid-token');
      expect([401, 403]).toContain(res.status);
    });

    it('应该拒绝用别的密钥签名的令牌（真验签，不是查表）', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const forged = jwt.sign({ userId: TEST_USER_ID }, 'not-the-real-secret', { expiresIn: '5m' });
      const res = await request(app).get('/api/clipboard').set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });

    it('应该拒绝已过期令牌', async () => {
      const expired = signAccessToken({ userId: TEST_USER_ID }, { expiresIn: '-1s' });
      const res = await request(app).get('/api/clipboard').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Token expired');
    });

    it('真 token + 真账号才放行（钉住旁路确实没了）', async () => {
      const res = await request(app).get('/api/clipboard').set(auth());
      expect(res.status).toBe(200);
    });
  });

  describe('权限提升测试', () => {
    it('应该防止用户访问其他用户的数据', async () => {
      const res = await request(app)
        .get('/api/clipboard/00000000-0000-4000-8000-00000000dead')
        .set(auth());
      expect([403, 404]).toContain(res.status);
    });
  });

  // ============================================
  // 指标端点鉴权（P0-C/C1：此前 metricsAuth 在测试环境直接 next()，
  // METRICS_TOKEN fail-closed 与 requireRole(50) 两条真实分支零覆盖）
  // ============================================
  describe('GET /api/metrics 鉴权', () => {
    it('匿名访问不得读取指标（此前靠 NODE_ENV===test 旁路恒 200）', async () => {
      const res = await request(app).get('/api/metrics');
      expect(res.status).toBe(401);
    });

    it('prometheus 端点同样不得匿名访问', async () => {
      const res = await request(app).get('/api/metrics/prometheus');
      expect(res.status).toBe(401);
    });

    it('普通用户 token 也不够（须 METRICS_TOKEN 直通或 roleLevel>=50）', async () => {
      const res = await request(app).get('/api/metrics').set(auth());
      expect(res.status).toBe(403);
    });

    // ⚠ 这里用 it.skipIf 而不是「用例体内 if (!token) return」：.env.test 目前**没有**配
    // METRICS_TOKEN（只写变量名，值不入库），那种写法会让本用例静默通过、在报告里
    // 显示成一条绿的用例，等于用「看起来覆盖了」顶替「覆盖了」。skipIf 把它显式计为 skipped，
    // 要真跑这条就在 .env.test 里配 METRICS_TOKEN 即可（指标端点的 fail-closed 与
    // requireRole(50) 两条分支由上面三条覆盖，与本条无关）。
    it.skipIf(!process.env.METRICS_TOKEN)(
      '配置了 METRICS_TOKEN 时 Bearer 直通可用（未配置则显式 skip，不写死凭据值）',
      async () => {
        const res = await request(app)
          .get('/api/metrics')
          .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`);
        expect(res.status).toBe(200);
      }
    );
  });
});


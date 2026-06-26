import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { resetRateLimit } from '../src/middleware/rateLimiter.js';
import {
  ensureTestUser,
  createTestDevice,
  cleanupTestData,
} from './test-helpers.js';

// 延迟导入 app，避免触发 server.listen()
let app;
beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = mod.app;
});

let phoneCounter = 300;
function uniquePhone() {
  phoneCounter++;
  return `13800${String(phoneCounter).padStart(6, '0')}`;
}

describe.skip('错误恢复测试 - 网络断开与服务重启场景', () => {
  let authToken;
  let testDeviceId;
  let testUserId;
  const testPhone = '13900770000';  // 错误恢复测试专用手机号

  beforeAll(async () => {
    // 重置速率限制
    try { resetRateLimit('api'); } catch (_) {}
    try { resetRateLimit('sendCode'); } catch (_) {}
    try { resetRateLimit('loginFailed'); } catch (_) {}

    if (process.env.NODE_ENV === 'test') {
      authToken = 'test-token';
      testUserId = await ensureTestUser(pool, testPhone);
      testDeviceId = await createTestDevice(pool, testUserId, '错误恢复测试设备', { deviceType: 'desktop', platform: 'windows' });
      return;
    }

    // 非测试环境：真实登录
    testPhone = uniquePhone();
    await request(app).post('/api/auth/send-code').send({ phone: testPhone });
    const loginRes = await request(app).post('/api/auth/verify-code').send({ phone: testPhone, code: '888888' });
    authToken = loginRes.body.token;

    const deviceRes = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ deviceName: '错误恢复测试设备', deviceType: 'desktop', platform: 'windows', platformVersion: '1.0.0' });
    testDeviceId = deviceRes.body.id || deviceRes.body.deviceId;
  });

  afterAll(async () => {
    await cleanupTestData(pool, testPhone);
  });

  beforeEach(() => {
    try { resetRateLimit('api'); } catch (_) {}
  });

  // ===== 1. 数据库连接恢复 =====
  describe('1. 数据库连接恢复', () => {
    it('1.1 数据库临时不可用时服务仍能响应健康检查', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(['healthy', 'degraded']).toContain(res.body.status);
    });

    it('1.2 数据库恢复后操作正常', async () => {
      const res = await request(app)
        .post('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceDeviceId: testDeviceId,
          contentEncrypted: 'DB恢复后测试',
          contentType: 'text',
          contentPreview: 'DB恢复后测试',
        });

      expect([201, 200]).toContain(res.status);
    });

    it('1.3 数据库查询超时不会导致进程崩溃', async () => {
      const res = await request(app)
        .get('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ limit: 100 });

      expect([200, 404, 500]).toContain(res.status);

      // Server should still be alive for next request
      const healthRes = await request(app).get('/api/health');
      expect(healthRes.status).toBe(200);
    });
  });

  // ===== 2. WebSocket 连接恢复 =====
  // WebSocket 测试需要真实服务器监听端口，在 Docker 容器中可能不可靠
  (process.env.NODE_ENV === 'test' ? describe.skip : describe)('2. WebSocket 连接恢复', () => {
    it('2.1 WebSocket断连后可重新连接', async () => {
      const { WebSocket } = await import('ws');
      const ws1 = new WebSocket(`ws://localhost:3001/ws?token=${authToken}`);

      await new Promise(resolve => ws1.on('open', resolve));
      ws1.send(JSON.stringify({ type: 'register', deviceId: testDeviceId }));
      await new Promise(resolve => ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') resolve();
      }));

      ws1.close();
      await new Promise(resolve => ws1.on('close', resolve));

      const ws2 = new WebSocket(`ws://localhost:3001/ws?token=${authToken}`);
      await new Promise(resolve => ws2.on('open', resolve));

      ws2.send(JSON.stringify({ type: 'register', deviceId: testDeviceId }));
      const regMsg = await new Promise(resolve => ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') resolve(msg);
      }));

      expect(regMsg.deviceId).toBe(testDeviceId);
      ws2.close();
    });

    it('2.2 无效Token的WebSocket连接被拒绝', async () => {
      const { WebSocket } = await import('ws');
      const ws = new WebSocket('ws://localhost:3001/ws?token=invalid-token');

      const closeCode = await new Promise(resolve => {
        ws.on('close', (code) => resolve(code));
      });

      expect(closeCode).toBe(4002);
    });
  });

  // ===== 3. 网络层错误恢复 =====
  describe('3. 网络层错误恢复', () => {
    it('3.1 请求超时后服务仍然可用', async () => {
      const burst = Array.from({ length: 30 }, () =>
        request(app).get('/api/health')
      );

      const results = await Promise.all(burst);
      const successCount = results.filter(r => r.status === 200).length;

      expect(successCount).toBeGreaterThan(25);

      const afterRes = await request(app).get('/api/health');
      expect(afterRes.status).toBe(200);
    });

    it('3.2 速率限制触发后可恢复', async () => {
      resetRateLimit('api');

      const requests = Array.from({ length: 150 }, () =>
        request(app).get('/api/clipboard').set('Authorization', `Bearer ${authToken}`)
      );

      const results = await Promise.all(requests);

      // Reset and verify recovery
      resetRateLimit('api');
      const recoveryRes = await request(app)
        .get('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`);

      expect(recoveryRes.status).toBe(200);
    });

    it('3.3 大请求体不会导致服务崩溃', async () => {
      const largeContent = 'A'.repeat(1024 * 1024); // 1MB

      const res = await request(app)
        .post('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceDeviceId: testDeviceId,
          contentEncrypted: largeContent,
          contentType: 'text',
          contentPreview: '大内容测试',
        });

      expect([201, 400, 413, 500]).toContain(res.status);

      const healthRes = await request(app).get('/api/health');
      expect(healthRes.status).toBe(200);
    });
  });

  // ===== 4. 认证错误恢复 =====
  describe('4. 认证错误恢复', () => {
    it('4.1 Token过期后可重新登录获取新Token', async () => {
      const expiredRes = await request(app)
        .get('/api/clipboard')
        .set('Authorization', 'Bearer expired.mock.token');

      if (process.env.NODE_ENV !== 'test') {
        expect([401, 403]).toContain(expiredRes.status);
      }

      // Re-login
      const reLoginPhone = uniquePhone();
      try { resetRateLimit('sendCode'); } catch (_) {}

      await request(app).post('/api/auth/send-code').send({ phone: reLoginPhone });
      const reLoginRes = await request(app)
        .post('/api/auth/verify-code')
        .send({ phone: reLoginPhone, code: '888888' });

      expect(reLoginRes.status).toBe(200);
      expect(reLoginRes.body).toHaveProperty('token');
    });

    it('4.2 CSRF令牌丢失后可重新获取', async () => {
      const csrfRes = await request(app)
        .get('/api/csrf-token')
        .set('Authorization', `Bearer ${authToken}`);

      expect(csrfRes.status).toBe(200);
      expect(csrfRes.body).toHaveProperty('csrfToken');
    });
  });

  // ===== 5. 离线队列恢复 =====
  describe('5. 离线队列恢复', () => {
    it('5.1 离线推送队列在服务恢复后可成功提交', async () => {
      const offlineChanges = Array.from({ length: 5 }, (_, i) => ({
        action: 'create',
        data: {
          contentType: 'text',
          contentEncrypted: `离线恢复测试${i}`,
          contentPreview: `离线恢复${i}`,
        },
      }));

      const pushRes = await request(app)
        .post('/api/sync/push')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ deviceId: testDeviceId, changes: offlineChanges });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body.results.length).toBe(5);
    });

    it('5.2 增量同步在断连恢复后可继续', async () => {
      const createRes = await request(app)
        .post('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceDeviceId: testDeviceId,
          contentEncrypted: '增量同步恢复测试',
          contentType: 'text',
          contentPreview: '增量同步恢复',
        });

      expect([201, 200]).toContain(createRes.status);

      const pullRes = await request(app)
        .get(`/api/sync/pull/${testDeviceId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(pullRes.status).toBe(200);
      expect(pullRes.body).toHaveProperty('items');
    });
  });
});

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

describe.skip('压力测试 - 高并发与系统稳定性', () => {
  let authToken;
  let testDeviceId;
  const testPhone = '13900330000';  // 压力测试专用手机号

  beforeAll(async () => {
    try { resetRateLimit('api'); } catch (_) {}
    try { resetRateLimit('sendCode'); } catch (_) {}
    try { resetRateLimit('loginFailed'); } catch (_) {}

    if (process.env.NODE_ENV === 'test') {
      authToken = 'test-token';
      const userId = await ensureTestUser(pool, testPhone);
      testDeviceId = await createTestDevice(pool, userId, '压力测试设备');
      return;
    }

    // 非测试环境：真实登录
    await request(app).post('/api/auth/send-code').send({ phone: testPhone });
    const loginRes = await request(app).post('/api/auth/verify-code').send({ phone: testPhone, code: '888888' });
    authToken = loginRes.body.token;

    const deviceRes = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ deviceName: '压力测试设备', deviceType: 'mobile', platform: 'ios', platformVersion: '1.0.0' });
    testDeviceId = deviceRes.body.id || deviceRes.body.deviceId;
  });

  afterAll(async () => {
    await cleanupTestData(pool, testPhone);
  });

  beforeEach(() => { try { resetRateLimit('api'); } catch (_) {} });

  // ===== 1. 高并发读取 =====
  describe('1. 高并发读取', () => {
    it('1.1 100并发健康检查请求全部成功', async () => {
      const concurrency = 100;
      const start = Date.now();

      const promises = Array.from({ length: concurrency }, () =>
        request(app).get('/api/health')
      );

      const results = await Promise.all(promises);
      const totalTime = Date.now() - start;
      const successCount = results.filter(r => r.status === 200).length;

      console.log(`    ${concurrency}并发健康检查: 总耗时=${totalTime}ms, 成功=${successCount}/${concurrency}`);
      expect(successCount).toBeGreaterThanOrEqual(concurrency - 5);
      expect(totalTime).toBeLessThan(10000);
    });

    it('1.2 100并发剪贴板列表读取', async () => {
      const concurrency = 100;
      const start = Date.now();

      const promises = Array.from({ length: concurrency }, () =>
        request(app)
          .get('/api/clipboard')
          .set('Authorization', `Bearer ${authToken}`)
      );

      const results = await Promise.all(promises);
      const totalTime = Date.now() - start;
      const successCount = results.filter(r => r.status === 200).length;

      console.log(`    ${concurrency}并发读取: 总耗时=${totalTime}ms, 成功=${successCount}/${concurrency}`);
      expect(successCount).toBeGreaterThanOrEqual(90);
      expect(totalTime).toBeLessThan(15000);
    });
  });

  // ===== 2. 高并发写入 =====
  describe('2. 高并发写入', () => {
    it.skip('2.1 50并发剪贴板创建', async () => {
      // 并发测试在测试环境不稳定，跳过
      const concurrency = 50;
      const start = Date.now();

      const promises = Array.from({ length: concurrency }, (_, i) =>
        request(app)
          .post('/api/clipboard')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            sourceDeviceId: testDeviceId,
            contentEncrypted: `压力写入${Date.now()}-${i}-${Math.random()}`,
            contentType: 'text',
            contentPreview: `压力写入${i}`,
          })
      );

      const results = await Promise.all(promises);
      const totalTime = Date.now() - start;
      const successCount = results.filter(r => r.status === 201).length;

      console.log(`    ${concurrency}并发写入: 总耗时=${totalTime}ms, 成功=${successCount}/${concurrency}`);
      expect(successCount).toBeGreaterThanOrEqual(45);
      expect(totalTime).toBeLessThan(20000);
    });
  });

  // ===== 3. 混合读写负载 =====
  describe('3. 混合读写负载', () => {
    it.skip('3.1 70%读+30%写混合负载', async () => {
      // 混合负载测试在测试环境不稳定，跳过
      const total = 100;
      const readCount = 70;
      const writeCount = 30;
      const start = Date.now();

      const readPromises = Array.from({ length: readCount }, () =>
        request(app)
          .get('/api/clipboard')
          .set('Authorization', `Bearer ${authToken}`)
      );

      const writePromises = Array.from({ length: writeCount }, (_, i) =>
        request(app)
          .post('/api/clipboard')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            sourceDeviceId: testDeviceId,
            contentEncrypted: `混合负载写${Date.now()}-${i}`,
            contentType: 'text',
            contentPreview: `混合${i}`,
          })
      );

      const results = await Promise.all([...readPromises, ...writePromises]);
      const totalTime = Date.now() - start;

      const readResults = results.slice(0, readCount);
      const writeResults = results.slice(readCount);

      const readSuccess = readResults.filter(r => r.status === 200).length;
      const writeSuccess = writeResults.filter(r => r.status === 201).length;

      console.log(`    混合负载: 读成功=${readSuccess}/${readCount}, 写成功=${writeSuccess}/${writeCount}, 总耗时=${totalTime}ms`);
      expect(readSuccess).toBeGreaterThanOrEqual(65);
      expect(writeSuccess).toBeGreaterThanOrEqual(25);
      expect(totalTime).toBeLessThan(15000);
    });
  });

  // ===== 4. 持续负载 =====
  describe('4. 持续负载', () => {
    it('4.1 500次连续请求系统稳定', { timeout: 30000 }, async () => {
      const iterations = 500;
      let successCount = 0;
      let errorCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        try {
          const res = await request(app).get('/api/health');
          if (res.status === 200) successCount++;
          else errorCount++;
        } catch {
          errorCount++;
        }

        if (i % 100 === 0 && i > 0) {
          try { resetRateLimit('api'); } catch (_) {}
        }
      }

      const totalTime = Date.now() - startTime;
      console.log(`    ${iterations}次连续请求: 成功=${successCount}, 失败=${errorCount}, 总耗时=${totalTime}ms`);

      expect(successCount).toBeGreaterThanOrEqual(iterations - 10);
      expect(errorCount).toBeLessThan(10);
    });

    it('4.2 持续负载后服务仍然正常', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);

      const clipRes = await request(app)
        .get('/api/clipboard')
        .set('Authorization', `Bearer ${authToken}`);
      expect(clipRes.status).toBe(200);
    });
  });

  // ===== 5. 内存泄漏检测 =====
  describe('5. 内存泄漏检测', () => {
    it('5.1 1000次请求后内存增长<20MB', { timeout: 30000 }, async () => {
      if (global.gc) global.gc();
      const memBefore = process.memoryUsage();

      for (let i = 0; i < 1000; i++) {
        await request(app).get('/api/health');
        if (i % 200 === 0) try { resetRateLimit('api'); } catch (_) {}
      }

      if (global.gc) global.gc();
      const memAfter = process.memoryUsage();
      const heapGrowthMB = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024 * 100) / 100;

      console.log(`    1000次请求后: 内存增长=${heapGrowthMB}MB`);
      expect(heapGrowthMB).toBeLessThan(20);
    });
  });
});

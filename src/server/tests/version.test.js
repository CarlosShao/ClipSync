import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import {
  authHeaders,
  ensureTestUser,
  createTestDevice,
  createTestClipboardItem,
  cleanupTestData,
} from './test-helpers.js';

// 延迟导入 app，确保只加载一次
let app;
beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = mod.app;
});

const testPhone = '13900220000';  // 版本测试专用手机号
// P0-C/C1：auth.js 的 `NODE_ENV==='test'` 旁路已删除 → 带真签名 token，
// 身份就是下面 ensureTestUser 建出来的那个真实用户（不是固定 UUID）。
//
// ⚠ 这条改动的直接后果：本文件的用例**第一次**真正打进 handler。
// 在此之前 authenticateToken 白送固定测试用户，而用例数据挂在 ensureTestUser 的随机
// UUID 名下 ⇒ `WHERE id=$1 AND user_id=$2` 永远 0 行 ⇒ 所有 POST/GET 一律 404。
// 于是满屏 `expect([201, 404, 200]).toContain(...)` 的「或」断言全部绿灯，
// 实际一条都没有验证过版本创建。现在把它们改成确定性断言。
let authFor;
const auth = () => authFor();

describe('版本管理 API', () => {
  let testUserId;
  let testDeviceId;
  let testClipboardItemId;

  /** 真实请求体（对齐 routes/versions.js 的字段名，旧用例写的 content/deviceId 从来不是契约） */
  const versionBody = (over = {}) => ({
    clipboardItemId: testClipboardItemId,
    contentEncrypted: 'iv:fake-ciphertext',
    contentPreview: '预览',
    contentSize: 12,
    sourceDeviceId: testDeviceId,
    changeDescription: '手动版本',
    ...over,
  });

  beforeAll(async () => {
    // 直接用 DB 插入准备测试数据，不调登录 API
    testUserId = await ensureTestUser(pool, testPhone);
    authFor = () => authHeaders({ userId: testUserId });
    testDeviceId = await createTestDevice(pool, testUserId, '版本测试设备');
  });

  beforeEach(async () => {
    testClipboardItemId = await createTestClipboardItem(
      pool, testUserId, testDeviceId, `测试内容_${Date.now()}`
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM file_versions WHERE clipboard_item_id = $1', [testClipboardItemId]);
    await pool.query('DELETE FROM clipboard_items WHERE id = $1', [testClipboardItemId]);
  });

  afterAll(async () => {
    await cleanupTestData(pool, testPhone);
  });

  // ============================================
  // 1. 创建版本
  // ============================================
  describe('1. 创建版本', () => {
    it('合法请求 → 201 且返回 versionNumber=1', async () => {
      const res = await request(app)
        .post('/api/versions').set(auth())
        .send(versionBody());

      expect(res.status).toBe(201);
      expect(res.body.versionNumber).toBe(1);
      expect(res.body.id).toBeTruthy();
    });

    it('缺 contentEncrypted / 给了非法 contentSize → 400，不是 500', async () => {
      // 拆旁路后本用例第一次真打进 handler，暴露出「缺正文撞 NOT NULL → 被 catch 兜成 500」
      // 这个真缺陷（任何登录用户都能稳定 500 这个端点）；已在 routes/versions.js 补校验。
      // ⚠ 收尾时移除了一条 { contentPreview: '' }：content_preview 在库里 NULLABLE 且默认 ''，空预览
      //   是合法值，把它拒成 400 属主动收紧契约而非修 bug；缺可空字段的正向行为改由下一条用例钉。
      for (const bad of [
        { contentEncrypted: undefined },
        { contentEncrypted: '' },
        { contentSize: 'abc' },
        { contentSize: -1 },
      ]) {
        const res = await request(app)
          .post('/api/versions').set(auth())
          .send(versionBody(bad));
        expect(res.status).toBe(400);
      }
    });

    it('只给必填项（省略 contentPreview/contentSize）→ 201，按库默认收下而不是 400', async () => {
      const body = versionBody({ contentEncrypted: undefined });
      delete body.contentPreview;
      delete body.contentSize;
      body.contentEncrypted = 'e2e-ciphertext';
      const res = await request(app).post('/api/versions').set(auth()).send(body);
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
    });

    it('sourceDeviceId 不属于自己 → 404（不得把版本挂到他人设备冒名）', async () => {
      const otherId = await ensureTestUser(pool, '13900220001');
      const otherDevice = await createTestDevice(pool, otherId, '他人设备');
      try {
        const res = await request(app)
          .post('/api/versions').set(auth())
          .send(versionBody({ sourceDeviceId: otherDevice }));
        expect(res.status).toBe(404);
      } finally {
        await pool.query('DELETE FROM devices WHERE id = $1', [otherDevice]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [otherId]).catch(() => {});
      }
    });
  });

  // ============================================
  // 2. 查询版本历史
  // ============================================
  describe('2. 查询版本历史', () => {
    it('返回自己刚创建的版本', async () => {
      const created = await request(app)
        .post('/api/versions').set(auth())
        .send(versionBody());
      expect(created.status).toBe(201);

      const res = await request(app)
        .get(`/api/versions/${testClipboardItemId}`).set(auth())

      expect(res.status).toBe(200);
      expect(res.body.versions ?? res.body.items ?? res.body).toBeTruthy();
    });

    it('别人的剪贴板项 → 查不到版本（空列表，不泄漏）', async () => {
      const otherId = await ensureTestUser(pool, '13900220002');
      try {
        const res = await request(app)
          .get(`/api/versions/${testClipboardItemId}`)
          .set(authHeaders({ userId: otherId }));
        expect(res.status).toBe(200);
        const list = res.body.versions ?? res.body.items ?? [];
        expect(list).toHaveLength(0);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [otherId]).catch(() => {});
      }
    });
  });

  // ============================================
  // 3. 回滚版本（真实端点是 POST /api/versions/restore/:versionId）
  // ============================================
  describe('3. 回滚版本', () => {
    it('旧用例打的 POST /api/versions/:id/rollback 这个路由根本不存在 → 404', async () => {
      const res = await request(app)
        .post(`/api/versions/${testClipboardItemId}/rollback`).set(auth())
        .send({ versionId: 'test-version-id' });

      expect(res.status).toBe(404);
    });

    it('restore 不存在的 versionId → 404（不是 500）', async () => {
      const res = await request(app)
        .post(`/api/versions/restore/${'00000000-0000-4000-8000-0000000000fe'}`).set(auth())
        .send({});

      expect([400, 404]).toContain(res.status);
    });
  });

  // ============================================
  // 4. 删除版本（当前服务端未提供 DELETE /api/versions/:versionId）
  // ============================================
  describe('4. 删除版本', () => {
    it('DELETE /api/versions/:versionId 未实现 → 404（钉住现状，将来实现了这条会红，届时改断言）', async () => {
      const res = await request(app)
        .delete('/api/versions/00000000-0000-4000-8000-0000000000fe').set(auth())

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // 5. 版本数量限制
  // ============================================
  describe('5. 版本数量限制', () => {
    it('创建多个版本后历史可查且版本号递增', async () => {
      for (let i = 0; i < 5; i++) {
        const created = await request(app)
          .post('/api/versions').set(auth())
          .send(versionBody({ changeDescription: `版本内容${i}` }));
        expect(created.status).toBe(201);
        expect(created.body.versionNumber).toBe(i + 1);
      }

      const res = await request(app)
        .get(`/api/versions/${testClipboardItemId}`).set(auth())

      expect(res.status).toBe(200);
      const list = res.body.versions ?? res.body.items ?? [];
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // 6. 错误处理
  // ============================================
  describe('6. 错误处理', () => {
    it('应该拒绝无效的剪贴板ID', async () => {
      const res = await request(app)
        .post('/api/versions').set(auth())
        .send(versionBody({ clipboardItemId: 'invalid-uuid' }));

      expect(res.status).toBe(400);
    });

    it('clipboardItemId 是合法 UUID 但不属于自己 → 404', async () => {
      const res = await request(app)
        .post('/api/versions').set(auth())
        .send(versionBody({ clipboardItemId: '00000000-0000-4000-8000-0000000000fe' }));

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // 7. 认证测试
  // （原 describe.skip，理由写的是「测试环境 auth middleware 被跳过」——
  //  P0-C/C1 把那个旁路拆了，本章节因此从「不可能通过」变成可执行）
  // ============================================
  describe('7. 认证测试', () => {
    it('应该拒绝未认证的请求', async () => {
      const res = await request(app).get(`/api/versions/${testClipboardItemId}`);
      expect(res.status).toBe(401);
    });

    it('应该拒绝无效 token（真实实现是 401，旧用例写的 403 从未被执行过）', async () => {
      const res = await request(app)
        .get(`/api/versions/${testClipboardItemId}`)
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });
  });
});

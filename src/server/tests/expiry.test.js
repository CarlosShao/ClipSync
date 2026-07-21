import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';

// 测试环境 auth 中间件固定使用此用户 ID（见 src/middleware/auth.js）
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

describe('用户侧自动过期集成测试 (exp-api #187)', () => {
  let app;
  let deviceId;
  let itemId;

  beforeAll(async () => {
    const { app: a } = await getTestApp();
    app = a;

    await pool.query(
      `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
       VALUES ($1, $2, '过期测试用户', 'test_hash', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, '+86test-expiry-0001']
    );

    const dev = await pool.query(
      `INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, is_online, created_at, last_seen_at)
       VALUES ($1, '过期测试设备', 'desktop', 'windows', '1.0.0', false, NOW(), NOW())
       ON CONFLICT DO NOTHING RETURNING id`,
      [TEST_USER_ID]
    );
    if (dev.rows[0]?.id) {
      deviceId = dev.rows[0].id;
    } else {
      const existing = await pool.query('SELECT id FROM devices WHERE user_id = $1 AND device_name = $2 LIMIT 1', [TEST_USER_ID, '过期测试设备']);
      deviceId = existing.rows[0].id;
    }
  }, 60000);

  afterAll(async () => {
    if (itemId) await pool.query('DELETE FROM clipboard_items WHERE id = $1', [itemId]).catch(() => {});
    await pool.query('DELETE FROM devices WHERE user_id = $1 AND device_name = $2', [TEST_USER_ID, '过期测试设备']).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('创建条目后 PUT expiresAt 设合法 ISO 日期应 200 且回传 expiresAt', async () => {
    const create = await pool.query(
      `INSERT INTO clipboard_items (
        user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, is_favorite, created_at, updated_at
      ) VALUES ($1, $2, 'text', $3, $4, LENGTH($5), $6, false, NOW(), NOW()) RETURNING id`,
      [TEST_USER_ID, deviceId, '过期测试内容', '过期测试内容', '过期测试内容', JSON.stringify({})]
    );
    itemId = create.rows[0].id;

    const future = new Date(Date.now() + 86400000).toISOString();
    const put = await request(app).put(`/api/clipboard/${itemId}`).send({ expiresAt: future });
    expect(put.status).toBe(200);
    expect(put.body.expiresAt).toBeTruthy();
    // 回传应为 ISO 字符串（Postgres timestamptz 返格式可能带 Z 或偏移，统一比对时间）
    expect(new Date(put.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('PUT expiresAt=null 应清除过期时间并回传 null', async () => {
    const put = await request(app).put(`/api/clipboard/${itemId}`).send({ expiresAt: null });
    expect(put.status).toBe(200);
    expect(put.body.expiresAt).toBeNull();
  });

  it('PUT expiresAt 传非法字符串应返回 400', async () => {
    const res = await request(app).put(`/api/clipboard/${itemId}`).send({ expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

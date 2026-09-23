import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp, TEST_USER_ID, authHeaders } from './test-helpers.js';

// P0-C/C1：auth.js 不再有 NODE_ENV==='test' 旁路，本文件统一带真签名 token。
// 沿用固定用户 ID（test-helpers 里的 TEST_USER_ID），下面的 seed 因此仍是必需品
// ——authenticateToken 会真查 users 表做账户活性校验。
const auth = authHeaders();

describe('归档功能集成测试 (arc-api #179)', () => {
  let app;
  let deviceId;
  let itemId;

  beforeAll(async () => {
    const { app: a } = await getTestApp();
    app = a;

    // TEST_USER_ID 必须真实存在于 users 表：既是 devices/clipboard_items 的外键前提，
    // 也是 authenticateToken 账户活性检查的前提（不存在 → 401 Account not found）。
    await pool.query(
      `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
       VALUES ($1, $2, '归档测试用户', 'test_hash', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, '+86test-archive-0001']
    );

    // clipboard_items.source_device_id NOT NULL，需确保测试用户有设备
    const dev = await pool.query(
      `INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, is_online, created_at, last_seen_at)
       VALUES ($1, '归档测试设备', 'desktop', 'windows', '1.0.0', false, NOW(), NOW())
       ON CONFLICT DO NOTHING RETURNING id`,
      [TEST_USER_ID]
    );
    if (dev.rows[0]?.id) {
      deviceId = dev.rows[0].id;
    } else {
      const existing = await pool.query('SELECT id FROM devices WHERE user_id = $1 AND device_name = $2 LIMIT 1', [TEST_USER_ID, '归档测试设备']);
      deviceId = existing.rows[0].id;
    }
  }, 60000);

  afterAll(async () => {
    if (itemId) await pool.query('DELETE FROM clipboard_items WHERE id = $1', [itemId]).catch(() => {});
    await pool.query('DELETE FROM devices WHERE user_id = $1 AND device_name = $2', [TEST_USER_ID, '归档测试设备']).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('默认主列表含条目；归档后主列表消失、归档视图可见；恢复后回到主列表', async () => {
    const create = await pool.query(
      `INSERT INTO clipboard_items (
        user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, is_favorite, created_at, updated_at
      ) VALUES ($1, $2, 'text', $3, $4, LENGTH($5), $6, false, NOW(), NOW()) RETURNING id`,
      [TEST_USER_ID, deviceId, '归档测试内容', '归档测试内容', '归档测试内容', JSON.stringify({})]
    );
    itemId = create.rows[0].id;

    let list = await request(app).get('/api/clipboard').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.items.find((i) => i.id === itemId)).toBeTruthy();

    const put = await request(app).put(`/api/clipboard/${itemId}`).set(auth).send({ archived: true });
    expect(put.status).toBe(200);
    expect(put.body.archived).toBe(true);

    list = await request(app).get('/api/clipboard').set(auth);
    expect(list.body.items.find((i) => i.id === itemId)).toBeFalsy();

    const arc = await request(app).get('/api/clipboard?view=archive').set(auth);
    expect(arc.status).toBe(200);
    expect(arc.body.items.find((i) => i.id === itemId)).toBeTruthy();

    const restore = await request(app).put(`/api/clipboard/${itemId}`).set(auth).send({ archived: false });
    expect(restore.status).toBe(200);
    expect(restore.body.archived).toBe(false);

    list = await request(app).get('/api/clipboard').set(auth);
    expect(list.body.items.find((i) => i.id === itemId)).toBeTruthy();
  });

  it('PUT archived 传入非布尔值应返回 400', async () => {
    const res = await request(app).put(`/api/clipboard/${itemId}`).set(auth).send({ archived: 'yes' });
    expect(res.status).toBe(400);
  });

  it('搜索结果应排除已归档条目', async () => {
    const create = await pool.query(
      `INSERT INTO clipboard_items (
        user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, is_favorite, created_at, updated_at
      ) VALUES ($1, $2, 'text', $3, $4, LENGTH($5), $6, false, NOW(), NOW()) RETURNING id`,
      [TEST_USER_ID, deviceId, '搜索归档唯一词xyz', '搜索归档唯一词xyz', '搜索归档唯一词xyz', JSON.stringify({})]
    );
    const searchItemId = create.rows[0].id;

    await request(app).put(`/api/clipboard/${searchItemId}`).set(auth).send({ archived: true });

    const search = await request(app).get('/api/clipboard/search?q=搜索归档唯一词xyz').set(auth);
    expect(search.status).toBe(200);
    expect(search.body.items.find((i) => i.id === searchItemId)).toBeFalsy();

    await pool.query('DELETE FROM clipboard_items WHERE id = $1', [searchItemId]).catch(() => {});
  });
});

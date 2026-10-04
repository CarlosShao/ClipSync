import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp, TEST_USER_ID, authHeaders } from './test-helpers.js';

/**
 * 审计 Q3：/api/sync/push 必须与 POST /api/clipboard 共用同一道条目配额闸。
 *
 * 回归背景：/api/sync 的挂载链（src/index.js）此前只有 subscriptionCheck —— 它只把
 * plan 放进 req.user，并不做条目数校验；真正挡配额的 checkClipboardLimit 只挂在了
 * POST /api/clipboard 上。于是免费用户可以绕过 50 条上限，靠离线同步队列
 * （POST /api/sync/push）把库里的剪贴板条目推到任意多。
 *
 * 本文件用真库（clipsync_test）+ 真 app 钉两件事：
 *   1. 已达 Free 上限 → push 被 403 拦下，且**库里的条目数不变**（拦在入库之前）；
 *   2. 未达上限 → push 正常 200（闸只认配额，不误杀正常同步）。
 */

const auth = authHeaders();

let app;
let deviceId;
let freeMax;

/** 批量造 n 条该用户的剪贴板条目（配额判定是 COUNT(*)，内容不重要） */
async function seedItems(n) {
  if (n <= 0) return;
  const values = [];
  const params = [];
  for (let i = 0; i < n; i++) {
    const base = params.length;
    values.push(
      `($${base + 1}, $${base + 2}, 'text', 'x', 'x', 1, '{}'::jsonb, false, NOW(), NOW())`
    );
    params.push(TEST_USER_ID, deviceId);
  }
  await pool.query(
    `INSERT INTO clipboard_items
       (user_id, source_device_id, content_type, content_encrypted, content_preview,
        content_size, metadata, is_favorite, created_at, updated_at)
     VALUES ${values.join(',')}`,
    params
  );
}

async function countItems() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM clipboard_items WHERE user_id = $1',
    [TEST_USER_ID]
  );
  return rows[0].n;
}

async function cleanup() {
  await pool.query('DELETE FROM clipboard_items WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
}

const pushBody = () => ({
  deviceId,
  changes: [
    {
      clientId: `local-${crypto.randomUUID()}`,
      action: 'create',
      clientTimestamp: new Date().toISOString(),
      data: {
        contentType: 'text',
        contentEncrypted: 'cipher',
        contentPreview: 'preview',
        contentSize: 6,
      },
    },
  ],
});

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[sync-clipboard-quota] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }
  app = (await getTestApp()).app;

  // 固定用户必须是「非管理员 + Free」：管理员 plan.isUnlimited 会直接放行，测不出配额闸
  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, is_admin, created_at, updated_at)
     VALUES ($1, $2, '同步配额测试用户', 'test_hash', 'free', false, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE
       SET is_admin = false, subscription_status = 'free', current_subscription_id = NULL`,
    [TEST_USER_ID, '+86test-sync-quota-1']
  );

  const plan = await pool.query(
    "SELECT max_clipboard_items FROM subscription_plans WHERE name = 'Free'"
  );
  freeMax = plan.rows[0]?.max_clipboard_items;
  if (!Number.isInteger(freeMax) || freeMax <= 0) {
    throw new Error(`[sync-clipboard-quota] 缺少 Free 套餐或 max_clipboard_items 非法：${freeMax}`);
  }

  // 设备：push 会校验 deviceId 属于当前用户
  const dev = await pool.query(
    `INSERT INTO devices
       (user_id, device_name, device_type, platform, platform_version, is_online, created_at, last_seen_at)
     VALUES ($1, '同步配额测试设备', 'desktop', 'windows', '1.0.0', false, NOW(), NOW())
     RETURNING id`,
    [TEST_USER_ID]
  );
  deviceId = dev.rows[0].id;

  await cleanup();
}, 60000);

beforeEach(async () => {
  await cleanup();
  await pool.query(
    `UPDATE users SET is_admin = false, subscription_status = 'free', current_subscription_id = NULL
      WHERE id = $1`,
    [TEST_USER_ID]
  );
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.query('DELETE FROM devices WHERE id = $1', [deviceId]).catch(() => {});
  await pool.end().catch(() => {});
});

describe('审计 Q3：/api/sync/push 受剪贴板条目配额约束', () => {
  it('达到 Free 上限后 push 被 403 拦下，且库里条目数不变', async () => {
    await seedItems(freeMax); // 恰好触顶：中间件是 >= 判定
    expect(await countItems()).toBe(freeMax);

    const res = await request(app).post('/api/sync/push').set(auth).send(pushBody());

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Clipboard item limit reached/i);
    expect(res.body.maxItems).toBe(freeMax);
    expect(await countItems()).toBe(freeMax); // 拦在入库之前，没有多写一条
  });

  it('未达上限时 push 正常 200（闸只认配额，不误杀正常同步）', async () => {
    await seedItems(freeMax - 1);

    const res = await request(app).post('/api/sync/push').set(auth).send(pushBody());

    expect(res.status).toBe(200);
    expect(res.body.results?.[0]?.status).toBe('ok');
    expect(await countItems()).toBe(freeMax); // 这次 push 写入 1 条后正好触顶
  });
});

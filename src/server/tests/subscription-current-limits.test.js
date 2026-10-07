import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp, authHeaders, ensureAuthUser } from './test-helpers.js';

/**
 * GET /api/subscriptions/current 里 `plan.maxFileSizeMb` / `plan.maxStorageMb` 的取值来源
 * （2026-10-07 修）
 *
 * 问题：这两个字段取自**套餐行**（`subscription.max_file_size_mb` / `max_storage_mb`），
 * 而同级的 `maxFilesPerClip` / `fileRetentionDays` 取自 `planLimits`（覆盖感知）。
 * 于是「单用户配额覆盖」（迁移 084）改了容量/单文件上限时：
 *   **上传闸按覆盖放行，客户端订阅页却还显示套餐原值** —— 界面与生效值脱节。
 * （⑨ 之前不存在单用户覆盖，所以这处脱节显不出来；是 ⑨ 让它暴露的。）
 *
 * 修法：四列同源，都走 `planLimits`（字节 → MB 还原）。本文件用**真实测试库 + 真实端点**
 * 钉住三件事：
 *   ① 没有覆盖时数值与套餐行**完全一致**（不能因为这次改动而漂）；
 *   ② 有覆盖时下发的是**覆盖值**（修复本体）；
 *   ③ 覆盖为 null（"不限"）时下发 null —— 客户端 `usePlanLimits.normalizeLimit` 会把
 *      null 归一为 Infinity（不限），这正是它注释里写的"如 admin 的不限字段"。
 *
 * 用独立的 user id / 手机号，避免与其它文件（同库并行跑）互相踩。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-0000000000c1';
// users.phone 是 varchar(20)
const TEST_PHONE = '+86test-cur-lim-1';

let app;

async function planRow(name) {
  const { rows } = await pool.query(
    'SELECT id, max_file_size_mb, max_storage_mb FROM subscription_plans WHERE name = $1',
    [name]
  );
  expect(rows.length, `套餐 ${name} 必须存在`).toBeGreaterThan(0);
  return rows[0];
}

async function setOverride(overrides) {
  await pool.query('UPDATE users SET limit_overrides = $2::jsonb WHERE id = $1', [
    TEST_USER_ID,
    overrides === null ? null : JSON.stringify(overrides),
  ]);
}

async function fetchPlan() {
  const res = await request(app)
    .get('/api/subscriptions/current')
    .set(authHeaders({ userId: TEST_USER_ID }));
  expect(res.status, `响应体：${JSON.stringify(res.body)}`).toBe(200);
  return res.body.plan;
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[subscription-current-limits] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }
  const { app: loaded } = await getTestApp();
  app = loaded;

  await ensureAuthUser(pool, { id: TEST_USER_ID, phone: TEST_PHONE, nickname: '配额显示测试用户' });
  const pro = await planRow('Pro');
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', 'monthly',
             NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 day',
             NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 day', NOW(), NOW())`,
    [TEST_USER_ID, pro.id]
  );
  await pool.query(
    `UPDATE users SET subscription_status = 'pro', limit_overrides = NULL WHERE id = $1`,
    [TEST_USER_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]).catch(() => {});
});

describe('GET /api/subscriptions/current · 配额字段取值来源', () => {
  it('① 没有覆盖时与套餐行完全一致（改动不能让它漂）', async () => {
    await setOverride(null);
    const pro = await planRow('Pro');

    const plan = await fetchPlan();

    expect(plan.maxFileSizeMb).toBe(Number(pro.max_file_size_mb));
    expect(plan.maxStorageMb).toBe(Number(pro.max_storage_mb));
  });

  it('★② 有覆盖时下发覆盖值（修复本体：上传闸与界面同源）', async () => {
    await setOverride({ max_file_size_mb: 250, max_storage_mb: 51200 });

    const plan = await fetchPlan();

    expect(plan.maxFileSizeMb).toBe(250);
    expect(plan.maxStorageMb).toBe(51200);
  });

  it('★③ 覆盖为 null（不限）时下发 null，未覆盖的列仍走套餐值', async () => {
    await setOverride({ max_storage_mb: null });
    const pro = await planRow('Pro');

    const plan = await fetchPlan();

    expect(plan.maxStorageMb).toBeNull(); // 不限 —— 客户端会归一为 Infinity
    expect(plan.maxFileSizeMb).toBe(Number(pro.max_file_size_mb)); // 未覆盖 ⇒ 套餐值
  });
});

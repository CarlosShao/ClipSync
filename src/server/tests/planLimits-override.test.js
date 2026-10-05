/**
 * 单用户配额覆盖的解析语义（utils/planLimits.js，迁移 084）
 *
 * 这是 ⑨ 的核心：配额**只有一个来源**（subscription_plans），覆盖是叠在它上面的稀疏补丁。
 * 本文件钉的是**叠加规则**：
 *   ① 覆盖优先于套餐；键缺失 ⇒ 沿用套餐（存量用户零变化）；键值为 null ⇒ 该项不限
 *      （与套餐行 NULL=不限 同语义）；
 *   ② 单文件上限被覆盖时，单次总大小上限跟着变（两者本来就是同一口径）；
 *   ③ 脏数据（非数字/负数/非对象）**忽略该键** —— 覆盖值写错不该让某人的配额变成 NaN，
 *      那会把他的上传全判成超额；
 *   ④ admin 天然不受限，覆盖不会把他变回受限。
 *
 * ⚠️ 文件位置决定 mock 路径深度：本文件在 tests/ 下，故 mock 键是 '../src/...'
 *（tests/admin/ 下的用例才是 '../../src/...'）。写错深度不会报错，只会**静默不生效**，
 * 于是模块拿到真实 pool、查询抛错、回落 FALLBACK —— 症状是"所有断言都差一个 Free 值"。
 *
 * 「user_limit_overrides 列不存在」的退化路径在**另一个文件**
 *（planLimits-legacy-schema.test.js）：planLimits 内部有 60s 的列存在性缓存，
 * 两种 schema 状态必须分文件，否则会互相污染。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../src/db/pool.js', () => ({ pool: state.pool, default: state.pool }));

import { getPlanLimits } from '../src/utils/planLimits.js';

const MB = 1024 * 1024;

/** 列齐全（有 084 的 users.limit_overrides + 042 的两个套餐列） */
function mockQueries({ planRow = {}, mainQueryThrows = false } = {}) {
  state.pool.query.mockImplementation(async (sql) => {
    if (String(sql).includes('information_schema')) {
      return {
        rows: [
          { table_name: 'subscription_plans', column_name: 'max_files_per_clip' },
          { table_name: 'subscription_plans', column_name: 'file_retention_days' },
          { table_name: 'users', column_name: 'limit_overrides' },
        ],
      };
    }
    if (String(sql).includes('FROM users u')) {
      if (mainQueryThrows) throw new Error('boom');
      return {
        rows: [
          {
            is_admin: false,
            limit_overrides: null,
            plan_id: 'plan-pro',
            plan_name: 'Pro',
            max_file_size_mb: 100,
            max_storage_mb: 10240,
            max_files_per_clip: 20,
            file_retention_days: 30,
            ...planRow,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

const mainSelectSql = () =>
  String(state.pool.query.mock.calls.map(([sql]) => sql).find((sql) => String(sql).includes('FROM users u')) || '');

beforeEach(() => {
  state.pool.query.mockReset();
});

describe('配额覆盖 · 叠加规则', () => {
  it('没有覆盖 ⇒ 完全沿用套餐值（存量用户零变化）', async () => {
    mockQueries();
    const limits = await getPlanLimits('u-1');

    expect(limits.maxFileSizeBytes).toBe(100 * MB);
    expect(limits.maxStorageBytes).toBe(10240 * MB);
    expect(limits.maxFilesPerClip).toBe(20);
    expect(limits.fileRetentionDays).toBe(30);
    expect(limits.overrideApplied).toBe(false);
  });

  it('★覆盖优先于套餐；未覆盖的键仍走套餐', async () => {
    mockQueries({ planRow: { limit_overrides: { max_storage_mb: 51200, max_files_per_clip: 99 } } });

    const limits = await getPlanLimits('u-1');

    expect(limits.maxStorageBytes).toBe(51200 * MB); // 被覆盖
    expect(limits.maxFilesPerClip).toBe(99); // 被覆盖
    expect(limits.maxFileSizeBytes).toBe(100 * MB); // 未覆盖 ⇒ 套餐
    expect(limits.fileRetentionDays).toBe(30); // 未覆盖 ⇒ 套餐
    expect(limits.overrideApplied).toBe(true);
  });

  it('★单文件上限被覆盖时，单次总大小上限跟着变（两者是同一口径）', async () => {
    mockQueries({ planRow: { limit_overrides: { max_file_size_mb: 250 } } });

    const limits = await getPlanLimits('u-1');

    expect(limits.maxFileSizeBytes).toBe(250 * MB);
    expect(limits.maxPerClipBytes).toBe(250 * MB);
  });

  it('★键值为 null ⇒ 该项**不限**（与套餐行 NULL=不限 同语义）', async () => {
    mockQueries({ planRow: { limit_overrides: { max_storage_mb: null, file_retention_days: 7 } } });

    const limits = await getPlanLimits('u-1');

    expect(limits.maxStorageBytes).toBeNull(); // 不限
    expect(limits.fileRetentionDays).toBe(7);
    expect(limits.overrideApplied).toBe(true);
  });

  it('★脏数据（非数字/负数）忽略该键，回落套餐值 —— 不能让配额变成 NaN', async () => {
    mockQueries({
      planRow: {
        limit_overrides: {
          max_file_size_mb: 'abc',
          max_storage_mb: -5,
          max_files_per_clip: null, // 这个是合法语义，应生效
        },
      },
    });

    const limits = await getPlanLimits('u-1');

    expect(limits.maxFileSizeBytes).toBe(100 * MB); // 'abc' 被忽略
    expect(limits.maxStorageBytes).toBe(10240 * MB); // -5 被忽略
    expect(limits.maxFilesPerClip).toBeNull(); // null = 不限，生效
  });

  it('非对象（数组）一律视作没有覆盖', async () => {
    mockQueries({ planRow: { limit_overrides: [1, 2, 3] } });

    const limits = await getPlanLimits('u-1');

    expect(limits.maxStorageBytes).toBe(10240 * MB);
    expect(limits.overrideApplied).toBe(false);
  });

  it('★admin 天然不受限，覆盖不会把他变回受限', async () => {
    mockQueries({ planRow: { is_admin: true, limit_overrides: { max_storage_mb: 1 } } });

    const limits = await getPlanLimits('u-admin');

    expect(limits.isUnlimited).toBe(true);
    expect(limits.maxStorageBytes).toBeNull();
    expect(limits.overrideApplied).toBe(false);
  });

  it('正常路径会 SELECT 覆盖列', async () => {
    mockQueries();
    await getPlanLimits('u-1');
    expect(mainSelectSql()).toContain('u.limit_overrides');
  });

  it('主查询失败 ⇒ 回落 FALLBACK_LIMITS（行为与改动前一致）', async () => {
    mockQueries({ mainQueryThrows: true });

    const limits = await getPlanLimits('u-1');

    expect(limits.plan).toBe('Free');
    expect(limits.maxFilesPerClip).toBe(3);
    expect(limits.maxStorageBytes).toBe(200 * MB);
    expect(limits.overrideApplied).toBe(false);
  });
});

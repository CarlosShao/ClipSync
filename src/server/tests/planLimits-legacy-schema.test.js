/**
 * ★退化路径：users.limit_overrides **列不存在**时（新二进制 + 旧库）的配额查询
 *
 * 为什么单独一个文件：`planLimits.js` 内部有 60 秒的「列是否存在」缓存，
 * 「列存在」与「列不存在」两种状态在同一个文件里会互相污染（先跑的那个决定后续），
 * 所以必须分文件 —— vitest 默认按文件隔离模块状态。
 *
 * 为什么这条路径值得单独测：迁移在**服务启动时**执行且失败即 `process.exit(1)`
 *（src/index.js:644-650），所以正常不会出现这个窗口；但只要出现了，直接 SELECT 一个
 * 不存在的列会让**整条配额查询抛错**，而本模块的兜底是 `FALLBACK_LIMITS`（Free 级：
 * 20MB/3 个/3 天）—— 那等于在没人察觉的情况下把**全体用户静默降级**。
 * 宁可退化成"没有覆盖"，也不能让查询炸。
 */
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../src/db/pool.js', () => ({ pool: state.pool, default: state.pool }));

import { getPlanLimits } from '../src/utils/planLimits.js';

const MB = 1024 * 1024;

/** 旧库：只有 042 的两个套餐列，没有 084 的 users.limit_overrides */
function mockLegacySchema({ infoSchemaThrows = false } = {}) {
  state.pool.query.mockImplementation(async (sql) => {
    if (String(sql).includes('information_schema')) {
      if (infoSchemaThrows) throw new Error('permission denied for information_schema');
      return {
        rows: [
          { table_name: 'subscription_plans', column_name: 'max_files_per_clip' },
          { table_name: 'subscription_plans', column_name: 'file_retention_days' },
        ],
      };
    }
    if (String(sql).includes('FROM users u')) {
      return {
        rows: [
          {
            is_admin: false,
            // 注意：旧库下这列根本不存在，SQL 里用 NULL::jsonb 占位，所以这里恒为 null
            limit_overrides: null,
            plan_id: 'plan-pro',
            plan_name: 'Pro',
            max_file_size_mb: 100,
            max_storage_mb: 10240,
            max_files_per_clip: 20,
            file_retention_days: 30,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

const mainSelectSql = () =>
  String(
    state.pool.query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => String(sql).includes('FROM users u')) || ''
  );

describe('配额覆盖 · 旧库（列不存在）', () => {
  it('★绝不 SELECT 不存在的列，改用 NULL::jsonb 占位；套餐配额照常返回', async () => {
    mockLegacySchema();

    const limits = await getPlanLimits('u-1');

    const sql = mainSelectSql();
    expect(sql).not.toContain('u.limit_overrides');
    expect(sql).toContain('NULL::jsonb AS limit_overrides');
    // 关键：没有被降级到 FALLBACK —— 读到的仍是套餐值
    expect(limits.plan).toBe('Pro');
    expect(limits.maxFileSizeBytes).toBe(100 * MB);
    expect(limits.maxStorageBytes).toBe(10240 * MB);
    expect(limits.maxFilesPerClip).toBe(20);
    expect(limits.overrideApplied).toBe(false);
  });

  it('★information_schema 查询失败 ⇒ 保守按"缺列"处理，不抛错也不降级', async () => {
    mockLegacySchema({ infoSchemaThrows: true });

    const limits = await getPlanLimits('u-1');

    expect(mainSelectSql()).not.toContain('u.limit_overrides');
    expect(limits.plan).toBe('Pro');
    expect(limits.maxFilesPerClip).toBe(20);
  });
});

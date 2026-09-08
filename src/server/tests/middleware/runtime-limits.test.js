import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 运行时限流阈值读取层 + 限流器动态阈值/总开关（CO-10）
 *
 * 纯单元测试：vi.mock 掉 db/pool 与 logger，不依赖真库（区别于 tests/ 下的集成测试）。
 * 覆盖：键缺失回退默认 / 读库失败 fail-closed 回退（绝不 disabled，方向与 featureFlags 相反）/
 *       非法配置值回退 / 库值生效 / disabled=true 全部放行 / 动态阈值内存路径 429 /
 *       TTL 缓存与失效 / checkWsConnectionLimit 总开关接入（同步快照）。
 */

const poolState = vi.hoisted(() => ({ rows: [], fail: false, query: null }));

vi.mock('../../src/db/pool.js', () => {
  const query = vi.fn(async () => {
    if (poolState.fail) throw new Error('db down');
    return { rows: poolState.rows, rowCount: poolState.rows.length };
  });
  poolState.query = query;
  return { default: { query } };
});

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  default: {},
}));

import { getRuntimeLimits, invalidateLimitsCache, getCachedRuntimeLimits } from '../../src/utils/runtimeLimits.js';
import { sendCodeLimiter, checkWsConnectionLimit } from '../../src/middleware/rateLimiter.js';
import { logger } from '../../src/utils/logger.js';
import pool from '../../src/db/pool.js';

const DEFAULTS = {
  apiPerMin: 300,
  sendCodePerHour: 5,
  loginFailedPer15Min: 5,
  uploadPerMin: 20,
  disabled: false,
};

/** 构造 system_configs 查询行（config_value 为 JSONB 字符串形态，同迁移 050 / to_jsonb($2::text)） */
function configRows(overrides = {}) {
  const base = {
    rate_limit_api_per_min: '300',
    rate_limit_send_code_per_hour: '5',
    rate_limit_login_failed_per_15min: '5',
    rate_limit_upload_per_min: '20',
    rate_limit_disabled: 'false',
  };
  return Object.entries({ ...base, ...overrides }).map(([config_key, config_value]) => ({
    config_key,
    config_value,
  }));
}

/** 最小 express res 桩：支持 set(k,v)/set(obj)/status/json */
function makeRes() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(h, v) {
      if (v !== undefined) this.headers[h] = v;
      else Object.assign(this.headers, h);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

beforeEach(() => {
  poolState.fail = false;
  poolState.rows = [];
  invalidateLimitsCache();
  vi.clearAllMocks();
});

describe('runtimeLimits 读取层', () => {
  it('键缺失（空行集）→ 回退硬编码默认值（fail-closed，disabled 恒 false）', async () => {
    poolState.rows = [];
    const limits = await getRuntimeLimits();
    expect(limits).toEqual(DEFAULTS);
  });

  it('读库失败 → fail-closed 回退默认值并 logger.warn（绝不变成不限流，与 featureFlags 方向相反）', async () => {
    poolState.fail = true;
    const limits = await getRuntimeLimits();
    expect(limits).toEqual(DEFAULTS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('[runtimeLimits]');
  });

  it('非法配置值（负数/非数字/垃圾布尔）→ 回退默认，disabled 按 false（保守）', async () => {
    poolState.rows = configRows({
      rate_limit_api_per_min: '-1',
      rate_limit_send_code_per_hour: 'abc',
      rate_limit_disabled: 'yes-please',
    });
    const limits = await getRuntimeLimits();
    expect(limits.apiPerMin).toBe(300);
    expect(limits.sendCodePerHour).toBe(5);
    expect(limits.disabled).toBe(false);
  });

  it('库中键值生效（JSONB 字符串 → 数字/布尔），未配置键回退默认', async () => {
    poolState.rows = configRows({
      rate_limit_api_per_min: '500',
      rate_limit_send_code_per_hour: '3',
      rate_limit_upload_per_min: '7',
    });
    const limits = await getRuntimeLimits();
    expect(limits.apiPerMin).toBe(500);
    expect(limits.sendCodePerHour).toBe(3);
    expect(limits.uploadPerMin).toBe(7);
    expect(limits.loginFailedPer15Min).toBe(5); // 未配置 → 默认
    expect(limits.disabled).toBe(false);
  });

  it('TTL 缓存：TTL 内复用快照不再查库；invalidateLimitsCache 后重新查库', async () => {
    poolState.rows = [];
    await getRuntimeLimits();
    const callsAfterFirst = pool.query.mock.calls.length;
    await getRuntimeLimits();
    await getRuntimeLimits();
    expect(pool.query.mock.calls.length).toBe(callsAfterFirst);

    invalidateLimitsCache();
    await getRuntimeLimits();
    expect(pool.query.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it('TTL 过期（>5s）后重新查库', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      poolState.rows = [];
      await getRuntimeLimits();
      const calls = pool.query.mock.calls.length;
      vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
      await getRuntimeLimits();
      expect(pool.query.mock.calls.length).toBe(calls + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getCachedRuntimeLimits：无快照时回退默认（同步调用安全）', () => {
    invalidateLimitsCache();
    const snapshot = getCachedRuntimeLimits();
    expect(snapshot.disabled).toBe(false);
    expect(snapshot.apiPerMin).toBe(300);
  });
});

describe('限流器动态阈值与总开关（rateLimiter 接入）', () => {
  // 注：apiLimiter 在 NODE_ENV=test 下整体短路，故用无 test 门控的 sendCodeLimiter 验证真实链路

  it('rate_limit_disabled=true → sendCodeLimiter 直接放行（不计数、不 429、无响应头）', async () => {
    poolState.rows = configRows({ rate_limit_disabled: 'true' });
    const phone = '13900009999';
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const next = vi.fn();
      await sendCodeLimiter({ body: { phone }, ip: '10.0.0.1' }, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
      expect(res.headers['X-RateLimit-Limit']).toBeUndefined();
    }
  });

  it('阈值动态生效：send_code_per_hour=2 → 同号第 3 次 429 + Retry-After + 动态响应头', async () => {
    poolState.rows = configRows({ rate_limit_send_code_per_hour: '2' });
    const phone = '13900008888';
    let res;
    for (let i = 0; i < 3; i++) {
      res = makeRes();
      await sendCodeLimiter({ body: { phone }, ip: '10.0.0.2' }, res, vi.fn());
    }
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toContain('Verification code');
    expect(res.headers['X-RateLimit-Limit']).toBe(2);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('checkWsConnectionLimit：disabled=true（同步快照）→ 直接放行', async () => {
    poolState.rows = configRows({ rate_limit_disabled: 'true' });
    await getRuntimeLimits(); // 预热进程内快照（同步读取依赖此步）
    expect(checkWsConnectionLimit('ws-user-disabled', 'dev-a')).toBe(true);
    expect(checkWsConnectionLimit('ws-user-disabled', 'dev-b')).toBe(true);
  });

  it('checkWsConnectionLimit：未开总开关 → 每用户最多 5 个设备，重复设备不受限', async () => {
    poolState.rows = [];
    invalidateLimitsCache();
    await getRuntimeLimits(); // 快照 disabled=false
    const uid = 'ws-user-normal';
    for (let i = 0; i < 5; i++) {
      expect(checkWsConnectionLimit(uid, `dev-${i}`)).toBe(true);
    }
    expect(checkWsConnectionLimit(uid, 'dev-5')).toBe(false);
    expect(checkWsConnectionLimit(uid, 'dev-0')).toBe(true); // 已在窗口内的设备放行
  });
});

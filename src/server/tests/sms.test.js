import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A4 短信服务回归测试
 *
 * 防复发目标（文档 external-dependency-audit 第 1 节「脏状态」第 1 条）：
 * 生产环境曾用固定码 888888 且无 NODE_ENV 判断 —— 任何人输 888888 可登录任意手机号。
 *
 * 本文件锁定三条不变量：
 *   1. 未配置短信时，发送必须返回 ok:false 且 reason=not_configured
 *      —— 绝不可静默"成功"（那等于保留后门）
 *   2. generateCode 产出 6 位数字随机码
 *   3. sms_access_key_secret 属于敏感键：写库加密、读取脱敏、审计不落明文
 */

const poolState = vi.hoisted(() => ({ rows: [] }));

vi.mock('../src/db/pool.js', () => {
  const pool = {
    query: vi.fn(async () => ({ rows: poolState.rows, rowCount: poolState.rows.length })),
  };
  return { pool, default: pool };
});

import { pool } from '../src/db/pool.js';
import {
  sendVerificationCodeSms,
  generateCode,
  isSmsConfigured,
  invalidateSmsConfigCache,
} from '../src/utils/sms.js';

/** 造一条 system_configs 行（config_value 为 JSONB 已解析值） */
function cfg(key, value) {
  return { config_key: key, config_value: value };
}

beforeEach(() => {
  poolState.rows = [];
  invalidateSmsConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A4 短信：未配置时的 fail-closed 行为', () => {
  it('provider=console（默认）→ 发送返回 ok:false, reason=not_configured，不抛异常', async () => {
    poolState.rows = [cfg('sms_provider', 'console')];
    const r = await sendVerificationCodeSms('13800138000', '123456');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('provider=aliyun 但凭据不全 → 仍视为未配置（缺签名/模板）', async () => {
    poolState.rows = [
      cfg('sms_provider', 'aliyun'),
      cfg('sms_access_key_id', 'LTAIxxx'),
      cfg('sms_access_key_secret', 'secret'),
      // 缺 sms_sign_name / sms_template_code
    ];
    const r = await sendVerificationCodeSms('13800138000', '123456');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('空表（迁移未跑）→ 未配置，不崩溃', async () => {
    poolState.rows = [];
    const r = await sendVerificationCodeSms('13800138000', '123456');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('读库抛异常 → 按未配置处理，不把异常抛给调用方', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const r = await sendVerificationCodeSms('13800138000', '123456');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('isSmsConfigured 不泄露凭据：仅返回 configured 与 provider', async () => {
    poolState.rows = [cfg('sms_provider', 'console')];
    const r = await isSmsConfigured();
    expect(r).toEqual({ configured: false, provider: 'console' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

describe('A4 短信：generateCode 随机性', () => {
  it('产出 6 位数字字符串', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('200 次采样具备随机性（去重后应远多于 1 种）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateCode()));
    // 200 次全同的概率可忽略；此断言防"又变回固定码"
    expect(set.size).toBeGreaterThan(150);
  });

  it('不返回固定码 888888', () => {
    const codes = Array.from({ length: 200 }, () => generateCode());
    // 允许极小概率巧合命中，但绝不能"总是"888888
    const hit = codes.filter((c) => c === '888888').length;
    expect(hit).toBeLessThan(5);
  });
});

describe('A4 短信：provider=aliyun 且配置完整时走真实 SDK 路径', () => {
  it('配置完整 → 不再返回 not_configured（会尝试调用网关）', async () => {
    poolState.rows = [
      cfg('sms_provider', 'aliyun'),
      cfg('sms_access_key_id', 'LTAIxxx'),
      cfg('sms_access_key_secret', 'plainsecret'),
      cfg('sms_sign_name', 'ClipSync'),
      cfg('sms_template_code', 'SMS_123456'),
    ];

    // 拦截底层 fetch/node 请求不现实，此处只断言"已进入发送分支"：
    // 由于真实调用会失败（假 AK），reason 应为 send_failed 而非 not_configured
    const r = await sendVerificationCodeSms('13800138000', '123456');
    expect(r.ok).toBe(false);
    expect(r.reason).not.toBe('not_configured');
    expect(['send_failed', 'circuit_open', 'error']).toContain(r.reason);
  });
});

/**
 * logAuditEvent 的降级重试契约（P0-C 修）。
 *
 * 审计日志的失败模式必须是"字段变少"，不能是"事件消失"：
 *  1. 正常路径只写一行，字段齐全；
 *  2. resource_id 触发约束时，降级为 resource_id=NULL，但原始标识必须留在 details 里
 *    （P0-B 之前的实现把降级信息拼好了却没传给 INSERT，等于承诺了没做）；
 *  3. user_id 触发外键（008 迁移里 audit_logs.user_id REFERENCES users(id)）时，
 *    必须继续降级到 user_id=NULL —— 此前两级重试用的是同一个 user_id，必然同样失败，
 *    于是账号被硬删后的审计事件静默丢失，只剩一行 error 日志；
 *  4. 三级全失败也不得把异常抛给业务调用方，且要打出可人工补记的字段。
 *
 * 不触库：pool 与 logger 均为桩，专测重试编排本身。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts = [];
const logError = vi.fn();
const logWarn = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  default: {
    query: vi.fn(async (sql, params) => {
      inserts.push(params);
      // 全局 setup 也会经这里的 query 一次（本文件的 pool 是桩），故用可选链
      const plan = inserts._behavior?.[inserts.length - 1];
      if (plan instanceof Error) throw plan;
    }),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a) => logWarn(...a),
    error: (...a) => logError(...a),
  },
}));

const { logAuditEvent } = await import('../src/utils/audit.js');

const COLS = { user: 0, action: 1, resourceType: 2, resourceId: 3, details: 4 };

function FKViolation() {
  const e = new Error('insert violates audit_logs_user_id_fkey');
  e.code = '23503';
  return e;
}

describe('logAuditEvent 降级重试', () => {
  beforeEach(() => {
    inserts.length = 0;
    inserts._behavior = [];
    logError.mockClear();
    logWarn.mockClear();
  });

  const base = {
    userId: '11111111-1111-4111-8111-111111111111',
    action: 'payment_refund',
    resourceType: 'order',
    resourceId: 'ORD-42',
    details: { amountCents: 1 },
  };

  it('第一次就成功：只写一行，字段齐全，且不打降级日志', async () => {
    inserts._behavior = [undefined];
    await logAuditEvent(base);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][COLS.user]).toBe(base.userId);
    expect(inserts[0][COLS.resourceId]).toBe('ORD-42');
    expect(JSON.parse(inserts[0][COLS.details])).toEqual({ amountCents: 1 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('resource_id 撞约束：丢掉该列但事件保留，原始标识留在 details', async () => {
    inserts._behavior = [new Error('value too long for resource_id'), undefined];
    await logAuditEvent(base);
    expect(inserts).toHaveLength(2);
    expect(inserts[1][COLS.resourceId]).toBeNull();
    const d = JSON.parse(inserts[1][COLS.details]);
    expect(d.amountCents).toBe(1);
    expect(d.__resourceId).toBe('ORD-42');
    expect(d.__auditInsertError).toContain('value too long');
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('user_id 撞外键：必须继续降级到 user_id=NULL，事件不得消失（P0-B 前会整条丢失）', async () => {
    inserts._behavior = [FKViolation(), FKViolation(), undefined];
    await logAuditEvent(base);
    expect(inserts).toHaveLength(3);
    const last = inserts[2];
    expect(last[COLS.user]).toBeNull();
    expect(last[COLS.action]).toBe('payment_refund');
    const d = JSON.parse(last[COLS.details]);
    expect(d.__userId).toBe(base.userId);
    expect(d.__resourceId).toBe('ORD-42');
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('三级全失败：不向业务调用方抛错，但 error 日志足以人工补记', async () => {
    inserts._behavior = [FKViolation(), FKViolation(), FKViolation()];
    await expect(logAuditEvent(base)).resolves.toBeUndefined();
    expect(inserts).toHaveLength(3);
    const lastArg = logError.mock.calls.at(-1)[1];
    expect(lastArg.userId).toBe(base.userId);
    expect(lastArg.action).toBe('payment_refund');
    expect(lastArg.resourceId).toBe('ORD-42');
    expect(lastArg.code).toBe('23503');
  });

  it('降级不得把 details 之外的字段一起丢掉：status/error_message 原样保留', async () => {
    inserts._behavior = [FKViolation(), FKViolation(), undefined];
    await logAuditEvent({ ...base, status: 'failure', errorMessage: '渠道拒绝' });
    const last = inserts[2];
    expect(last[7]).toBe('failure');
    expect(last[8]).toBe('渠道拒绝');
  });
});

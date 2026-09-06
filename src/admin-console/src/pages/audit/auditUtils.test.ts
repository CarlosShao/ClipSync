import { describe, expect, test } from 'vitest';
import dayjs from 'dayjs';
import { isSensitiveAction } from './sensitive';
import { buildAuditCsv, buildAuditCsvFilename } from './auditCsv';
import { parseDetailsToJson } from './auditDetail';
import type { AuditLog } from '@/api/types';

/** T-A6 审计页纯函数：敏感判定规则 / CSV 导出（BOM+转义）/ 文件名 / 详情 JSON 化 */

function logOf(partial: Partial<AuditLog>): AuditLog {
  return {
    id: 'aud_test',
    operator: 'Carlos',
    operatorRole: 'super_admin',
    userId: null,
    action: 'user.login',
    resourceType: 'session',
    resourceId: 'session',
    details: '',
    ipAddress: '116.24.*.*',
    status: 'success',
    sensitive: false,
    createdAt: '2026-09-05 20:31:12',
    ...partial,
  };
}

describe('敏感操作判定（行首红点 + 整行浅红底）', () => {
  test('admin. 前缀与指定精确动作判敏感，普通用户动作不敏感', () => {
    expect(isSensitiveAction('admin.refund.execute')).toBe(true);
    expect(isSensitiveAction('admin.roles.update')).toBe(true);
    expect(isSensitiveAction('user.deactivate')).toBe(true);
    expect(isSensitiveAction('role.assign')).toBe(true);
    expect(isSensitiveAction('user.delete')).toBe(true);
    expect(isSensitiveAction('user.login')).toBe(false);
    expect(isSensitiveAction('data.export')).toBe(false);
    expect(isSensitiveAction('device.pair')).toBe(false);
  });
});

describe('审计 CSV 导出', () => {
  test('BOM 头 + 表头 + 字段转义（引号/逗号）与结果中文化', () => {
    const csv = buildAuditCsv([
      logOf({
        action: 'admin.refund.execute',
        resourceType: 'payment_order',
        resourceId: 'CS20260905172256',
        details: 'amount=9.90, reason="用户重复支付, 含逗号"',
        status: 'success',
      }),
      logOf({ operator: '159****8834', operatorRole: 'user', action: 'user.login', status: 'failed' }),
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('时间,操作者,角色,动作,资源类型,资源 ID,详情,IP,结果');
    expect(lines[1]).toContain('"admin.refund.execute"');
    expect(lines[1]).toContain('"amount=9.90, reason=""用户重复支付, 含逗号"""');
    expect(lines[1]).toContain('"超管"');
    expect(lines[1]).toContain('"成功"');
    expect(lines[2]).toContain('"159****8834"');
    expect(lines[2]).toContain('"终端用户"');
    expect(lines[2]).toContain('"失败"');
  });

  test('文件名格式 audit-YYYYMMDD.csv', () => {
    expect(buildAuditCsvFilename(dayjs('2026-09-05T20:00:00'))).toBe('audit-20260905.csv');
  });
});

describe('详情摘要 → JSON', () => {
  test('key=value 摘要解析（含引号值与逗号短语），JSON 串直接解析', () => {
    expect(parseDetailsToJson('amount=9.90, reason="用户重复支付"')).toEqual({
      amount: '9.90',
      reason: '用户重复支付',
    });
    expect(parseDetailsToJson('{"count":214,"format":"csv"}')).toEqual({ count: 214, format: 'csv' });
  });
});

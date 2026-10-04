/**
 * 订单可退款判定（api/orders.ts#isOrderRefundable）单测。
 *
 * 这张判定直接决定列表/详情是否露出退款按钮：放行过宽 → 运营点了必然收到
 * 40005（服务端 order.status 闸），白填一次原因还以为是系统故障；
 * 放行过窄 → H2 之后「渠道已收款、本地未履约」的单在管理台上退不了款。
 * 故两侧边界都要锁住，尤其是「无 channelReportsPaid 标记不放行」。
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { isOrderRefundable } from '@/api/orders';

describe('isOrderRefundable —— 退款入口的窄口径', () => {
  test('已支付单可退（常规路径）', () => {
    expect(isOrderRefundable({ status: 'paid', channelReportsPaid: false })).toBe(true);
    expect(isOrderRefundable({ status: 'paid' })).toBe(true);
  });

  test('已退款一律不可再退（含 refundAmount 未落的「退款处理中」）', () => {
    expect(isOrderRefundable({ status: 'refunded', channelReportsPaid: false })).toBe(false);
    expect(isOrderRefundable({ status: 'refunded', channelReportsPaid: true })).toBe(false);
  });

  test('异常到账：已关闭 / 待支付 + 渠道已收款标记 → 可退', () => {
    expect(isOrderRefundable({ status: 'cancelled', channelReportsPaid: true })).toBe(true);
    expect(isOrderRefundable({ status: 'pending', channelReportsPaid: true })).toBe(true);
  });

  test('没有渠道已收款标记时一律不放行（否则必然 40005）', () => {
    expect(isOrderRefundable({ status: 'cancelled', channelReportsPaid: false })).toBe(false);
    expect(isOrderRefundable({ status: 'pending', channelReportsPaid: false })).toBe(false);
    expect(isOrderRefundable({ status: 'pending' })).toBe(false);
    expect(isOrderRefundable({ status: 'cancelled' })).toBe(false);
  });

  test('已失败单即便带标记也不放行（渠道未完成扣款，无钱可退）', () => {
    expect(isOrderRefundable({ status: 'failed', channelReportsPaid: true })).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  SELF_REFUND_WINDOW_DAYS,
  SELF_REFUND_CHANNEL,
  SELF_REFUND_GATE_CODES,
  REFUNDABLE_ORDERS_LIMIT,
  REFUND_REASON_CODES,
  normalizeOrderChannel,
  evaluateSelfRefund,
} from '../src/services/refundPolicy.js';
import { UUID_ORDER_ID_RE, orderKeyColumn } from '../src/services/refund.js';

/**
 * 属主自助退款风控闸的纯函数单测（不碰 DB）。
 *
 * 这些边界是**资金安全边界**：窗口差一天、paid_at 缺失被判成"在窗口内"，
 * 都会让用户自助退掉本该只能人工处理的单。所以时间边界（正好 7 天 / 7 天+1ms）、
 * 脏数据（paid_at 为 null / 非法）、判定优先级（哪条理由先出）都要钉死。
 *
 * 路由级的真库行为在 tests/payment-refund.test.js，服务级在 tests/refund-service.test.js。
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ORDER_ID = '11111111-1111-1111-1111-111111111111';

function order(overrides = {}) {
  return {
    id: ORDER_ID,
    order_no: 'ORDTEST0000000001',
    user_id: 'u1',
    status: 'paid',
    payment_channel: 'alipay',
    payment_method: 'alipay',
    paid_at: new Date(NOW.getTime() - 60 * 1000),
    amount: '9.90',
    currency: 'CNY',
    metadata: {},
    ...overrides,
  };
}

function verdict(overrides, anchorOrderId = ORDER_ID) {
  return evaluateSelfRefund({ order: order(overrides), anchorOrderId, now: NOW });
}

describe('常量契约', () => {
  it('自助退款窗口 7 天、渠道 alipay、列表回溯 10 条', () => {
    expect(SELF_REFUND_WINDOW_DAYS).toBe(7);
    expect(SELF_REFUND_CHANNEL).toBe('alipay');
    expect(REFUNDABLE_ORDERS_LIMIT).toBe(10);
  });

  it('实际拦截的两道闸只有 NOT_CURRENT_SUB_ORDER / REFUND_WINDOW_EXPIRED（status/渠道交回 refundPaidOrder）', () => {
    expect([...SELF_REFUND_GATE_CODES].sort()).toEqual([
      'NOT_CURRENT_SUB_ORDER',
      'REFUND_WINDOW_EXPIRED',
    ]);
  });

  it('reasonCode 取值集合就是响应契约，客户端按此出文案', () => {
    expect(REFUND_REASON_CODES).toMatchObject({
      ALREADY_REFUNDED: 'ALREADY_REFUNDED',
      REFUND_WINDOW_EXPIRED: 'REFUND_WINDOW_EXPIRED',
      NOT_CURRENT_SUB_ORDER: 'NOT_CURRENT_SUB_ORDER',
      CHANNEL_UNSUPPORTED: 'CHANNEL_UNSUPPORTED',
    });
  });
});

describe('evaluateSelfRefund · 可退判定', () => {
  it('paid + alipay + 锚定单（当前生效订阅的最近一笔已付）+ 窗口内 → refundable', () => {
    expect(verdict({})).toMatchObject({ refundable: true, reasonCode: null });
  });

  it('正好等于窗口边界（7 天前那一刻）仍可退，超 1ms 即拒（边界不模糊）', () => {
    expect(
      verdict({ paid_at: new Date(NOW.getTime() - SELF_REFUND_WINDOW_DAYS * DAY) }).refundable
    ).toBe(true);
    const justOver = verdict({ paid_at: new Date(NOW.getTime() - SELF_REFUND_WINDOW_DAYS * DAY - 1) });
    expect(justOver.refundable).toBe(false);
    expect(justOver.reasonCode).toBe('REFUND_WINDOW_EXPIRED');
  });

  it('超窗 → REFUND_WINDOW_EXPIRED，extra.paidAt 供客户端显示"付款于 X"', () => {
    const paidAt = new Date(NOW.getTime() - 10 * DAY);
    const v = verdict({ paid_at: paidAt });
    expect(v.reasonCode).toBe('REFUND_WINDOW_EXPIRED');
    expect(v.extra.paidAt).toBe(paidAt.toISOString());
    expect(v.extra.windowDays).toBe(SELF_REFUND_WINDOW_DAYS);
    expect(v.message).toBeTruthy();
  });

  it('paid_at 为 null / 非法字符串 → 一律按超窗拒退（fail closed，时间说不清就不退钱）', () => {
    for (const paidAt of [null, undefined, '', 'not-a-date']) {
      const v = verdict({ paid_at: paidAt });
      expect(v.refundable).toBe(false);
      expect(v.reasonCode).toBe('REFUND_WINDOW_EXPIRED');
    }
    expect(verdict({ paid_at: null }).extra.paidAt).toBeNull();
  });

  it('不是锚定单（当前生效订阅的最近一笔已付）→ NOT_CURRENT_SUB_ORDER；无锚点（anchor 为空）时一律拒', () => {
    const other = verdict({}, '22222222-2222-2222-2222-222222222222');
    expect(other.reasonCode).toBe('NOT_CURRENT_SUB_ORDER');
    expect(other.extra.anchorOrderId).toBe('22222222-2222-2222-2222-222222222222');

    // 无 active 订阅 / 该订阅无已付订单（anchor=null）→ 没有任何可退依据，一律不退。
    // 这正是防「依次顺移退款」的落点：退掉锚定单后 anchor 消失，旧单永不轮上。
    for (const anchor of [null, undefined, '']) {
      const v = evaluateSelfRefund({ order: order({}), anchorOrderId: anchor, now: NOW });
      expect(v.refundable).toBe(false);
      expect(v.reasonCode).toBe('NOT_CURRENT_SUB_ORDER');
    }
  });

  it('id 与 anchorOrderId 类型不一致（UUID 字符串 vs 其它对象）也能正确比对：按字符串比', () => {
    expect(
      evaluateSelfRefund({
        order: order({ id: ORDER_ID }),
        anchorOrderId: String(ORDER_ID),
        now: NOW,
      }).refundable
    ).toBe(true);
  });

  it('已退款 → ALREADY_REFUNDED；其它状态 → ORDER_NOT_REFUNDABLE（与 refundPaidOrder 同码）', () => {
    expect(verdict({ status: 'refunded' }).reasonCode).toBe('ALREADY_REFUNDED');
    for (const status of ['pending', 'failed', 'cancelled']) {
      const v = verdict({ status });
      expect(v.reasonCode).toBe('ORDER_NOT_REFUNDABLE');
      expect(v.extra.status).toBe(status);
    }
  });

  it('非支付宝渠道 → CHANNEL_UNSUPPORTED（优先级高于"锚定单/窗口"，先说清这单根本退不了）', () => {
    for (const method of ['mock', 'stripe', 'wechat', null, '']) {
      const v = verdict({
        payment_channel: method,
        payment_method: method,
        paid_at: new Date(NOW.getTime() - 99 * DAY),
        // 同时不满足"锚定单"，仍应先报渠道
      }, 'other-id');
      expect(v.reasonCode).toBe('CHANNEL_UNSUPPORTED');
      expect(v.extra.channel).toBe(String(method || '').toLowerCase() || 'unknown');
    }
  });

  it('渠道归一口径与 refundPaidOrder 一致：payment_channel 优先，空则回退 payment_method，大小写无关', () => {
    expect(normalizeOrderChannel({ payment_channel: 'AliPay', payment_method: 'mock' })).toBe('alipay');
    expect(normalizeOrderChannel({ payment_channel: null, payment_method: 'ALIPAY' })).toBe('alipay');
    expect(normalizeOrderChannel({})).toBe('');
    expect(verdict({ payment_channel: null, payment_method: 'alipay' }).refundable).toBe(true);
  });

  it('订单为空 → ORDER_NOT_FOUND（防御：调用方漏判时也不会崩）', () => {
    expect(evaluateSelfRefund({ order: null, now: NOW }).reasonCode).toBe('ORDER_NOT_FOUND');
  });
});

describe('订单定位的形状判别（refund.js 与路由共用一份正则）', () => {
  it('UUID 形状按主键 id 定位，其余按 order_no 定位', () => {
    expect(orderKeyColumn(ORDER_ID)).toBe('id');
    expect(orderKeyColumn(`  ${ORDER_ID.toUpperCase()}  `)).toBe('id');
    expect(orderKeyColumn('ORDRF1758283000ab12')).toBe('order_no');
    expect(orderKeyColumn('')).toBe('order_no');
    expect(orderKeyColumn(null)).toBe('order_no');
  });

  it('正则本身不放过半截 UUID（错位定位=退错单，故边界要卡死）', () => {
    expect(UUID_ORDER_ID_RE.test(`${ORDER_ID}extra`)).toBe(false);
    expect(UUID_ORDER_ID_RE.test(ORDER_ID.slice(0, -1))).toBe(false);
    expect(UUID_ORDER_ID_RE.test('not-a-uuid')).toBe(false);
  });
});

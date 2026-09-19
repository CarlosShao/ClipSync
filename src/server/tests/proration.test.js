import { describe, it, expect } from 'vitest';

import {
  computeProration,
  decidePlanChange,
  roundToCent,
  MIN_ORDER_AMOUNT,
} from '../src/services/proration.js';

/**
 * 升级差价折抵纯函数回归测试（services/proration.js，任务板 #15）
 *
 * 这段逻辑直接决定**用户实付金额**，算错就是资损或白送权益，且线上很难被发现
 * （金额看着"差不多"）。所以全部用固定 UTC 时间点把边界钉死，不依赖当前时间。
 *
 * 统一基准周期：2026-09-01T00:00:00Z → 2026-10-01T00:00:00Z，正好 30 天，
 * 手算残值不需要考虑闰月/夏令时。
 */

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-10-01T00:00:00.000Z'); // 30 天整

describe('折抵 - 金额取整', () => {
  it('四舍五入到分，且不被浮点噪声吃掉一分', () => {
    expect(roundToCent(9.9)).toBe(9.9);
    expect(roundToCent(0.005)).toBe(0.01); // 16.5 这类 .5 必须进位
    expect(roundToCent(9.875)).toBe(9.88);
    expect(roundToCent(9.874)).toBe(9.87);
    // 9.9 * 30 / 30 在浮点下是 9.900000000000002 / 9.899999999999999 一类值
    expect(roundToCent((9.9 * 30) / 30)).toBe(9.9);
    // 非法输入按 0 处理（绝不产出 NaN 金额）
    expect(roundToCent(null)).toBe(0);
    expect(roundToCent('abc')).toBe(0);
  });
});

describe('折抵 - 残值计算（四个边界）', () => {
  it('① 周期起点购买：残值 = 旧套餐全额实付', () => {
    const r = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 19.9,
      now: START,
    });
    expect(r.cycleDays).toBe(30);
    expect(r.remainingDays).toBe(30);
    expect(r.creditAmount).toBe(9.9);
    expect(r.finalAmount).toBe(10.0); // 19.9 - 9.9
    expect(r.floorApplied).toBe(false);
  });

  it('② 剩余半天：按时间线性折算，不为 0（取整到天会把残值抹平）', () => {
    const r = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 19.9,
      now: new Date('2026-09-30T12:00:00.000Z'), // 距到期 0.5 天
    });
    expect(r.remainingDays).toBe(0.5);
    expect(r.ratio).toBe(0.0167); // 0.5/30 保留四位
    expect(r.creditAmount).toBe(0.17); // 9.9 * 0.5/30 = 0.165 → 0.17
    expect(r.finalAmount).toBe(19.73);
  });

  it('③ 到期日当天（周期已走完 / 已过期）：残值为 0，按新价全额', () => {
    const atEnd = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 19.9,
      now: END,
    });
    expect(atEnd.remainingDays).toBe(0);
    expect(atEnd.creditAmount).toBe(0);
    expect(atEnd.finalAmount).toBe(19.9);

    // 已过期（脏数据：status 还是 active 但周期早结束了）同样 0 残值，不得倒扣
    const pastEnd = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 19.9,
      now: new Date('2026-11-15T00:00:00.000Z'),
    });
    expect(pastEnd.remainingDays).toBe(0);
    expect(pastEnd.creditAmount).toBe(0);
    expect(pastEnd.finalAmount).toBe(19.9);
  });

  it('④ 残值 ≥ 新价：订单金额兜底 0.01（不出 0 元单/负数单）', () => {
    const yearStart = new Date('2026-01-01T00:00:00.000Z');
    const yearEnd = new Date('2027-01-01T00:00:00.000Z'); // 365 天
    const r = computeProration({
      paidAmount: 199, // 企业版年付实付
      periodStart: yearStart,
      periodEnd: yearEnd,
      newPrice: 9.9, // 折抵后本应为负
      now: new Date('2026-02-01T00:00:00.000Z'), // 还剩 334 天
    });
    expect(r.creditAmount).toBeGreaterThan(r.originalPrice);
    expect(r.finalAmount).toBe(MIN_ORDER_AMOUNT);
    expect(r.floorApplied).toBe(true);
  });
});

describe('折抵 - 异常与非法输入（宁可少折，不可乱折）', () => {
  it('周期时间倒挂 / 缺列（NaN）→ 残值 0，金额仍是新套餐价', () => {
    const r = computeProration({
      paidAmount: 9.9,
      periodStart: END,
      periodEnd: START,
      newPrice: 19.9,
      now: START,
    });
    expect(r.creditAmount).toBe(0);
    expect(r.finalAmount).toBe(19.9);

    const missing = computeProration({
      paidAmount: 9.9,
      periodStart: null,
      periodEnd: undefined,
      newPrice: 19.9,
    });
    expect(missing.creditAmount).toBe(0);
    expect(missing.finalAmount).toBe(19.9);
  });

  it('残值不得超过旧套餐实付金额（now 早于周期起点也不超发）', () => {
    const r = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 99,
      now: new Date('2026-08-01T00:00:00.000Z'), // 数据异常：当前时间在周期开始之前
    });
    expect(r.creditAmount).toBeLessThanOrEqual(9.9);
    expect(r.finalAmount).toBe(89.1); // 99 - 9.9（JS 裸算是 89.10000000000001，必须已取整）
  });

  it('字符串日期与 Date 等价（DB 取出来的是 timestamptz 字符串/Date 两种形态）', () => {
    const fromDate = computeProration({
      paidAmount: 9.9,
      periodStart: START,
      periodEnd: END,
      newPrice: 19.9,
      now: new Date('2026-09-16T00:00:00.000Z'),
    });
    const fromString = computeProration({
      paidAmount: '9.90',
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      newPrice: '19.90',
      now: '2026-09-16T00:00:00.000Z',
    });
    expect(fromString.creditAmount).toBe(fromDate.creditAmount);
    expect(fromString.finalAmount).toBe(fromDate.finalAmount);
  });
});

describe('档位判定 decidePlanChange', () => {
  it('无 active 订阅 → none（全价新订，不折抵）', () => {
    expect(decidePlanChange({ currentPlanId: null, targetPlanId: 'p-pro', currentTierPrice: 0, targetTierPrice: 9.9 }).kind)
      .toBe('none');
  });

  it('同一套餐 → same（路由侧回 409 ALREADY_SUBSCRIBED）', () => {
    expect(decidePlanChange({ currentPlanId: 'p-pro', targetPlanId: 'p-pro', currentTierPrice: 9.9, targetTierPrice: 9.9 }).kind)
      .toBe('same');
  });

  it('按 price_monthly 比档位：Free < Pro < Enterprise', () => {
    expect(decidePlanChange({ currentPlanId: 'a', targetPlanId: 'b', currentTierPrice: 0, targetTierPrice: 9.9 }).kind)
      .toBe('upgrade');
    expect(decidePlanChange({ currentPlanId: 'b', targetPlanId: 'c', currentTierPrice: 9.9, targetTierPrice: 19.9 }).kind)
      .toBe('upgrade');
    expect(decidePlanChange({ currentPlanId: 'c', targetPlanId: 'b', currentTierPrice: 19.9, targetTierPrice: 9.9 }).kind)
      .toBe('downgrade');
  });

  it('年付价不参与档位比较（否则年付 Pro 99 会"高过"月付 Enterprise 19.9）', () => {
    // 目标套餐 price_monthly=19.9 与当前 price_monthly=9.9 → 升档，与 yearly 无关
    expect(decidePlanChange({ currentPlanId: 'b', targetPlanId: 'c', currentTierPrice: 9.9, targetTierPrice: 19.9 }).kind)
      .toBe('upgrade');
  });

  it('不同套餐但同价 → downgrade（无升档依据，拦下而非给一条说不清的折抵单）', () => {
    expect(decidePlanChange({ currentPlanId: 'x', targetPlanId: 'y', currentTierPrice: 9.9, targetTierPrice: 9.9 }).kind)
      .toBe('downgrade');
  });

  it('NULL/空价格按 0 处理（缺价套餐不会误判为升档）', () => {
    expect(decidePlanChange({ currentPlanId: 'x', targetPlanId: 'y', currentTierPrice: null, targetTierPrice: null }).kind)
      .toBe('downgrade');
    expect(decidePlanChange({ currentPlanId: 'x', targetPlanId: 'y', currentTierPrice: 0, targetTierPrice: 9.9 }).kind)
      .toBe('upgrade');
  });
});

/**
 * 升级差价折抵（任务板 #15）——纯计算模块。
 *
 * 为什么单独抽一个纯函数：折抵是**唯一决定用户实付金额**的逻辑，边界多
 * （到期日当天、剩余不足一天、残值大于新价），且一旦算错就是资损或白送权益。
 * 做成不碰 DB / 不碰网络的纯函数，才能用单测把边界钉死（tests/proration.test.js）。
 * 路由侧（routes/payments.js）只负责取数与落库，算法一律在这里。
 *
 * 口径（产品决策）：
 *  - 档位序按 subscription_plans.price_monthly 数值比较（Free 0 < Pro 9.9 < Enterprise 19.9）；
 *  - 残值 = 旧套餐**实付金额** × (剩余天数 / 该周期总天数)，按时间线性折算、四舍五入到分；
 *  - 新订单金额 = max(新套餐价 − 残值, 0.01)（支付宝/微信单笔下限 1 分，绝不出 0 元单）。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 订单最低金额（元）：折抵后不得为 0 或负数。 */
export const MIN_ORDER_AMOUNT = 0.01;

/**
 * 四舍五入到分。
 * 先把乘 100 后的浮点噪声按 12 位有效数字归一（9.9 * 30 / 30 这类会写成
 * 989.9999999999999），再取整，避免"差一分"的随机结果。
 */
export function roundToCent(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

/** Date | 毫秒 | ISO 字符串 → 毫秒时间戳（非法输入返回 NaN，由调用方按"无残值"处理） */
function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/**
 * 套餐变更判定：区分「同套餐重复购买 / 升档 / 降档」。
 *
 * 只认 price_monthly 作为档位序（price_yearly 是促销折扣价，不能当档位依据，
 * 否则年付 Pro 99 会"高过"月付 Enterprise 19.9）。
 *
 * 同价不同套餐（未来若上线同档位的多个套餐）按**降档**处理：
 * 没有档位提升就没有折抵依据，宁可拦下来让人工/前端引导，也不给一条说不清的折抵单。
 *
 * @param {object} p
 * @param {string} [p.currentPlanId]   用户当前 active 订阅的套餐 id
 * @param {string} [p.targetPlanId]    本次要购买的套餐 id
 * @param {number|string} [p.currentTierPrice] 当前套餐 price_monthly
 * @param {number|string} [p.targetTierPrice]  目标套餐 price_monthly
 * @returns {{kind:'none'|'same'|'upgrade'|'downgrade', currentTierPrice:number, targetTierPrice:number}}
 */
export function decidePlanChange({ currentPlanId, targetPlanId, currentTierPrice, targetTierPrice }) {
  const cur = Number(currentTierPrice) || 0;
  const tgt = Number(targetTierPrice) || 0;

  // 无 active 订阅（currentPlanId 为空）→ 全价新订，不参与折抵判定
  if (!currentPlanId || !targetPlanId) {
    return { kind: 'none', currentTierPrice: cur, targetTierPrice: tgt };
  }
  if (String(currentPlanId) === String(targetPlanId)) {
    return { kind: 'same', currentTierPrice: cur, targetTierPrice: tgt };
  }
  if (tgt > cur) {
    return { kind: 'upgrade', currentTierPrice: cur, targetTierPrice: tgt };
  }
  return { kind: 'downgrade', currentTierPrice: cur, targetTierPrice: tgt };
}

/**
 * 计算残值折抵。
 *
 * @param {object} p
 * @param {number|string} p.paidAmount    旧套餐本期**实付**金额（元）
 * @param {Date|string|number} p.periodStart   旧订阅 current_period_start
 * @param {Date|string|number} p.periodEnd     旧订阅 current_period_end
 * @param {number|string} p.newPrice      新套餐按本次 billingCycle 取到的价（元）
 * @param {Date|string|number} [p.now=新 Date()] 折算基准时刻（测试可注入）
 * @returns {{
 *   originalPrice:number, creditAmount:number, finalAmount:number,
 *   remainingDays:number, cycleDays:number, floorApplied:boolean, ratio:number
 * }}
 */
export function computeProration({ paidAmount, periodStart, periodEnd, newPrice, now = new Date() }) {
  const paid = Math.max(0, Number(paidAmount) || 0);
  const originalPrice = roundToCent(Math.max(0, Number(newPrice) || 0));

  const startTs = toTime(periodStart);
  const endTs = toTime(periodEnd);
  const nowTs = toTime(now);

  let cycleDays = 0;
  let remainingDays = 0;
  let ratio = 0;

  // 周期数据非法（缺列/倒挂/无法解析）时残值按 0 处理 —— 宁可让用户多付，
  // 也不可少付后由履约侧开权益；下游金额闸（expectedAmount）会拒绝渠道金额不符的履约。
  if (Number.isFinite(startTs) && Number.isFinite(endTs) && Number.isFinite(nowTs) && endTs > startTs) {
    cycleDays = (endTs - startTs) / MS_PER_DAY;
    const remainMs = Math.max(0, endTs - nowTs);
    remainingDays = Math.min(cycleDays, remainMs / MS_PER_DAY);
    ratio = remainingDays / cycleDays;
  }

  const creditAmount = Math.min(paid, roundToCent(paid * ratio));
  const rawFinal = roundToCent(originalPrice - creditAmount);
  const floorApplied = rawFinal < MIN_ORDER_AMOUNT;
  const finalAmount = floorApplied ? MIN_ORDER_AMOUNT : rawFinal;

  return {
    originalPrice,
    creditAmount,
    finalAmount,
    // 天数保留两位小数写进 metadata（0.5 天这类是有效信息，取整会把残值抹平）
    remainingDays: Math.round(remainingDays * 100) / 100,
    cycleDays: Math.round(cycleDays * 100) / 100,
    floorApplied,
    ratio: Math.round(ratio * 10000) / 10000,
  };
}

export default { computeProration, decidePlanChange, roundToCent, MIN_ORDER_AMOUNT };

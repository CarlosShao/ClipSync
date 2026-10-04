import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { ensureAuthUser } from './test-helpers.js';
import { runOrderCloseSweep } from '../src/services/orderCloseSweep.js';

/**
 * orderCloseSweep 回归测试（2026-10-03 补）
 *
 * ⚠️ 为什么这个文件必须存在：本服务此前**零测试**，而 2026-09-29 审计 H2 之后
 * 它的逻辑被**整体重写**了 —— 从「一条 UPDATE 批量本地关单」改成
 * 「逐单：先查渠道 → 已付款则绝不关单 → 渠道关单成功才本地置 cancelled」。
 * 这正是全链路里最容易把钱关丢、也最没人看着的一段（审计报告 §"未覆盖的真实风险
 * 场景" 第 4 条点名的就是它）。
 *
 * 被钉死的不变量（按重要性）：
 *   1. **渠道已付款的单绝不关**（否则钱进了账户、订单 cancelled、退款入口又拒收
 *      cancelled 单 → 系统内无路可退，只能人工登支付宝后台）；
 *   2. **查单/关单失败时宁可不动**（下轮重试），也不冒险关单；
 *   3. 关单前**必须**在渠道侧关掉（否则支付宝侧仍可支付，等于重新打开同一个洞）；
 *   4. 非支付宝渠道不调渠道接口；
 *   5. 未超时、已付/已退的单一概不受影响；
 *   6. 关单要留痕（metadata.auto_closed）并逐单写审计。
 */

const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];
const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const savedEnv = {};
let seq = 0;
const created = [];

function signWith(str) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(str, 'utf8');
  return s.sign(PRIV, 'base64');
}

/**
 * 按 method 路由的网关桩：查单与关单是两个不同的 response key。
 * `overrides` 里的方法若给 `__throw` 则模拟网络/业务异常。
 */
function stubGateway(byMethod) {
  const fn = vi.fn(async (_url, opts) => {
    const method = new URLSearchParams(opts.body).get('method');
    const spec = byMethod[method];
    if (!spec) throw new Error(`unexpected alipay method in test: ${method}`);
    if (spec.__throw) throw new Error(spec.__throw);
    const valueText = JSON.stringify(spec);
    const key = `${method.replace(/\./g, '_')}_response`;
    return { text: async () => `{"${key}":${valueText},"sign":"${signWith(valueText)}"}` };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function methodsOf(fn) {
  return fn.mock.calls.map(([, o]) => new URLSearchParams(o.body).get('method'));
}

/** 造一条订单；ageHours 控制 created_at，用来跨过 24h 阈值 */
async function seedOrder({
  status = 'pending',
  channel = 'alipay',
  ageHours = 30,
  amount = 9.9,
} = {}) {
  const orderNo = `ORDSWP${Date.now()}${seq++}`;
  const { rows } = await pool.query(
    `INSERT INTO payment_orders
       (user_id, order_no, amount, currency, payment_method, payment_channel, status,
        created_at, updated_at, metadata)
     VALUES ((SELECT id FROM users LIMIT 1), $1, $2, 'CNY', $3, $3, $4,
             NOW() - ($5 || ' hours')::interval, NOW(), '{}'::jsonb)
     RETURNING id, order_no`,
    [orderNo, amount, channel, status, String(ageHours)]
  );
  created.push(rows[0].order_no);
  return rows[0];
}

const readOrder = async (orderNo) =>
  (await pool.query('SELECT * FROM payment_orders WHERE order_no = $1', [orderNo])).rows[0];

const readAudit = async (orderId) =>
  (await pool.query(
    `SELECT action, details FROM audit_logs
      WHERE resource_type = 'payment_order' AND resource_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [String(orderId)]
  )).rows[0];

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[order-close-sweep] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }
  await ensureAuthUser(pool); // payment_orders.user_id NOT NULL，全局清理后需要账号行
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (created.length) {
    await pool
      .query('DELETE FROM payment_orders WHERE order_no = ANY($1::text[])', [created])
      .catch(() => {});
  }
});

beforeEach(async () => {
  // 只清自己造的，避免影响同库其它测试
  if (created.length) {
    await pool
      .query('DELETE FROM payment_orders WHERE order_no = ANY($1::text[])', [created])
      .catch(() => {});
    created.length = 0;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TRADE_NOT_EXIST = { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST' };
const WAIT_BUYER_PAY = { code: '10000', msg: 'Success', trade_status: 'WAIT_BUYER_PAY' };
const PAID = { code: '10000', msg: 'Success', trade_status: 'TRADE_SUCCESS', total_amount: '9.90' };
const CLOSE_OK = { code: '10000', msg: 'Success' };

describe('orderCloseSweep · 超时关单（审计 H2 重写后的不变量）', () => {
  it('渠道未付款 → 先查单、再关渠道、最后才本地置 cancelled 并留痕 + 审计', async () => {
    const order = await seedOrder({ status: 'pending', channel: 'alipay', ageHours: 30 });

    const fn = stubGateway({
      'alipay.trade.query': WAIT_BUYER_PAY,
      'alipay.trade.close': CLOSE_OK,
    });

    const result = await runOrderCloseSweep();

    expect(result.swept).toBe(true);
    expect(result.closedCount).toBe(1);
    // 顺序不变量：必须查过、且关过渠道
    expect(methodsOf(fn)).toEqual(['alipay.trade.query', 'alipay.trade.close']);

    const after = await readOrder(order.order_no);
    expect(after.status).toBe('cancelled');
    expect(after.metadata.auto_closed).toBe('timeout_unpaid');

    const audit = await readAudit(order.id);
    expect(audit.action).toBe('payment_auto_close');
    expect(audit.details).toMatchObject({ orderNo: order.order_no, channelClosed: true });
  });

  it('渠道没有这笔交易（TRADE_NOT_EXIST）→ 视为未付，照常关单', async () => {
    const order = await seedOrder();
    stubGateway({
      'alipay.trade.query': TRADE_NOT_EXIST,
      'alipay.trade.close': CLOSE_OK,
    });

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(1);
    expect((await readOrder(order.order_no)).status).toBe('cancelled');
  });

  it('★渠道已付款 → 绝不关单，订单保持 pending，并计入 skippedPaid 待对账', async () => {
    const order = await seedOrder({ status: 'pending', channel: 'alipay', ageHours: 30 });

    const fn = stubGateway({
      'alipay.trade.query': PAID,
      // 明确不给 close：一旦代码错误地去关渠道，桩会抛错让用例直接失败
    });

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(0);
    expect(result.skippedPaid).toBe(1);
    // 只查了单，没有关单（关单会让钱已付的交易也无法履约）
    expect(methodsOf(fn)).toEqual(['alipay.trade.query']);

    const after = await readOrder(order.order_no);
    expect(after.status).toBe('pending'); // 留给回调/轮询兜底去履约
    expect(after.metadata.auto_closed).toBeUndefined();
  });

  it('★查单失败（非 TRADE_NOT_EXIST）→ 本轮跳过，订单保持 pending（绝不冒险关单）', async () => {
    const order = await seedOrder();

    const fn = stubGateway({ 'alipay.trade.query': { __throw: 'gateway timeout' } });

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(0);
    expect(result.deferredByChannel).toBe(1);
    expect(methodsOf(fn)).toEqual(['alipay.trade.query']); // 没走到关单
    expect((await readOrder(order.order_no)).status).toBe('pending');
  });

  it('★渠道关单失败 → 本轮跳过，订单保持 pending（绝不在渠道还开着时就本地关掉）', async () => {
    const order = await seedOrder();

    stubGateway({
      'alipay.trade.query': WAIT_BUYER_PAY,
      'alipay.trade.close': { __throw: 'close failed' },
    });

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(0);
    expect(result.deferredByChannel).toBe(1);
    expect((await readOrder(order.order_no)).status).toBe('pending');
  });

  it('非支付宝渠道不调渠道接口，直接本地关单', async () => {
    const order = await seedOrder({ status: 'pending', channel: 'mock', ageHours: 30 });

    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(1);
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(order.order_no)).status).toBe('cancelled');
  });

  it('未超时（未满 24h）的 pending 单不受影响', async () => {
    const fresh = await seedOrder({ status: 'pending', channel: 'mock', ageHours: 1 });

    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(0);
    expect((await readOrder(fresh.order_no)).status).toBe('pending');
  });

  it('已 paid 的旧单不受影响（关单绝不能碰终态）', async () => {
    const paidOrder = await seedOrder({ status: 'paid', channel: 'mock', ageHours: 30 });

    vi.stubGlobal('fetch', vi.fn());

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(0);
    expect((await readOrder(paidOrder.order_no)).status).toBe('paid');
  });

  it('一轮里混合场景：只关该关的那几条', async () => {
    const unpaid = await seedOrder({ status: 'pending', channel: 'alipay', ageHours: 30 });
    const alreadyPaid = await seedOrder({ status: 'pending', channel: 'alipay', ageHours: 30 });
    const mockOrder = await seedOrder({ status: 'pending', channel: 'mock', ageHours: 30 });
    const freshOrder = await seedOrder({ status: 'pending', channel: 'mock', ageHours: 2 });

    // 两个支付宝单的查单结果不同：靠 out_trade_no 区分
    const fn = vi.fn(async (_url, opts) => {
      const form = new URLSearchParams(opts.body);
      const method = form.get('method');
      const biz = JSON.parse(form.get('biz_content'));
      let payload;
      if (method === 'alipay.trade.query') {
        payload = biz.out_trade_no === alreadyPaid.order_no ? PAID : WAIT_BUYER_PAY;
      } else {
        payload = CLOSE_OK;
      }
      const valueText = JSON.stringify(payload);
      const key = `${method.replace(/\./g, '_')}_response`;
      return { text: async () => `{"${key}":${valueText},"sign":"${signWith(valueText)}"}` };
    });
    vi.stubGlobal('fetch', fn);

    const result = await runOrderCloseSweep();

    expect(result.closedCount).toBe(2); // unpaid + mockOrder
    expect(result.skippedPaid).toBe(1); // alreadyPaid

    expect((await readOrder(unpaid.order_no)).status).toBe('cancelled');
    expect((await readOrder(mockOrder.order_no)).status).toBe('cancelled');
    expect((await readOrder(alreadyPaid.order_no)).status).toBe('pending');
    expect((await readOrder(freshOrder.order_no)).status).toBe('pending');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * 支付宝支付工具回归测试（utils/alipay.js）
 *
 * 防复发目标：本项目支付链路的验签此前是**完全错的**——
 * `middleware/webhook-signature.js` 的支付宝分支虽能排序拼串，但从未排除
 * `sign_type`，且整条回调路由不可达（404 + 被登录鉴权拦住）。真实接入时
 * 会在「钱扣了但订阅不开通」处爆掉，且静默无日志。
 *
 * 本文件锁定四条不变量：
 *   1. 签名串规则：按 key ASCII 升序、`&` 连接、末尾无 `&`、空值参与
 *   2. 排除字段因场景而异：请求签名只排 sign；回调验签还要排 sign_type
 *      （写死任一种都会在另一侧验签失败）
 *   3. 裸 base64 密钥可补成 PEM，且补出来的内容能被 crypto 真正解析
 *   4. 篡改任何一个字段（金额/订单号）都必须验签失败
 *
 * 退款（refundTrade，任务板 #10）额外锁定：请求报文口径 + 成功判定（旧版
 * fund_status='Y'；现行接口无该字段，code=10000 即成功态、幂等重放 fund_change='N' 也算）
 * + 响应验签不可绕过（伪造 Y 等于凭空把订单标成已退款）。
 * 全部离线：网关调用用 vi.stubGlobal('fetch') 打桩，签名/验签用测试内自生成的密钥对。
 */

const { publicKey: PUB, privateKey: PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const privBody = PRIV.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
const pubBody = PUB.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

const ENV_KEYS = [
  'ALIPAY_APP_ID',
  'ALIPAY_PRIVATE_KEY',
  'ALIPAY_PUBLIC_KEY',
  'ALIPAY_SANDBOX',
];

let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

/** 每个用例都动态 import：模块读 env 不缓存，但保持与线上一致的取用方式 */
async function loadModule() {
  return import('../src/utils/alipay.js');
}

function signWith(str) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(str, 'utf8');
  return s.sign(PRIV, 'base64');
}

describe('支付宝工具 - 签名串规则', () => {
  it('按 key ASCII 升序拼接，末尾不加 &', async () => {
    const { buildSignString } = await loadModule();
    expect(buildSignString({ b: '2', a: '1', c: '3' })).toBe('a=1&b=2&c=3');
  });

  it('默认排除 sign，但 sign_type 仍参与（请求签名口径）', async () => {
    const { buildSignString } = await loadModule();
    const s = buildSignString({ z: '1', sign: 'XXX', sign_type: 'RSA2', a: '2' });
    expect(s).toBe('a=2&sign_type=RSA2&z=1');
    expect(s).not.toContain('sign=XXX');
  });

  it('空值被剔除（官方 SDK areNotEmpty 口径；保留空值必然验签失败）', async () => {
    const { buildSignString } = await loadModule();
    expect(buildSignString({ a: '1', empty: '', sign: 'x' })).toBe('a=1');
    expect(buildSignString({ a: '1', b: null, c: undefined, d: '2' })).toBe('a=1&d=2');
  });

  it('按 ASCII 而非自然序排序（Z 在 a 之前）', async () => {
    const { buildSignString } = await loadModule();
    expect(buildSignString({ a: '1', Z: '2' })).toBe('Z=2&a=1');
  });

  it('显式排除 sign_type（回调验签口径）', async () => {
    const { buildSignString } = await loadModule();
    const s = buildSignString({ a: '1', sign: 'X', sign_type: 'RSA2' }, ['sign', 'sign_type']);
    expect(s).toBe('a=1');
  });
});

describe('支付宝工具 - PEM 补齐', () => {
  it('裸 base64 私钥补 RSAPRIVATEKEY 头且可被 crypto 解析', async () => {
    const { toPem } = await loadModule();
    const pem = toPem(privBody, 'PRIVATE');
    expect(pem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(() => crypto.createPrivateKey(pem)).not.toThrow();
  });

  it('裸 base64 公钥补 PUBLICKEY 头且可被 crypto 解析', async () => {
    const { toPem } = await loadModule();
    const pem = toPem(pubBody, 'PUBLIC');
    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(() => crypto.createPublicKey(pem)).not.toThrow();
  });

  it('已是 PEM 的输入可往返（幂等语义）', async () => {
    const { toPem } = await loadModule();
    expect(() => crypto.createPublicKey(toPem(PUB, 'PUBLIC'))).not.toThrow();
  });

  it('字面量 \\n 会被还原为真实换行（.env 常见写法）', async () => {
    const { toPem } = await loadModule();
    const escaped = PUB.replace(/\n/g, '\\n');
    expect(toPem(escaped, 'PUBLIC')).toBe(PUB);
  });

  it('空值返回空串（不抛异常）', async () => {
    const { toPem } = await loadModule();
    expect(toPem('', 'PUBLIC')).toBe('');
    expect(toPem(null, 'PRIVATE')).toBe('');
  });
});

describe('支付宝工具 - 回调验签', () => {
  const notify = () => ({
    out_trade_no: 'ORD20260916001',
    trade_no: '2026091622001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '19.90',
    app_id: '2021000000000000',
    sign_type: 'RSA2',
  });

  it('正确回调验签通过', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const params = notify();
    const sig = signWith(mod.buildSignString(params, ['sign', 'sign_type']));
    expect(mod.verifyParams(params, sig, 'RSA2')).toBe(true);
  });

  it('金额被篡改 → 验签失败', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const params = notify();
    const sig = signWith(mod.buildSignString(params, ['sign', 'sign_type']));
    expect(mod.verifyParams({ ...params, total_amount: '0.01' }, sig, 'RSA2')).toBe(false);
  });

  it('订单号被篡改 → 验签失败', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const params = notify();
    const sig = signWith(mod.buildSignString(params, ['sign', 'sign_type']));
    expect(mod.verifyParams({ ...params, out_trade_no: 'ORD_ATTACKER' }, sig, 'RSA2')).toBe(false);
  });

  it('sign_type 不参与验签（若参与则真实回调必然失败）', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const params = notify();
    // 用「含 sign_type」的串签名 → 因验签侧排除 sign_type，应当**不通过**
    const sigWithSignType = signWith(mod.buildSignString(params, ['sign']));
    expect(mod.verifyParams(params, sigWithSignType, 'RSA2')).toBe(false);
    // 用「排除 sign_type」的串签名 → 通过
    const sigCorrect = signWith(mod.buildSignString(params, ['sign', 'sign_type']));
    expect(mod.verifyParams(params, sigCorrect, 'RSA2')).toBe(true);
  });

  it('空签名 / 缺公钥 → 均失败且不抛异常', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    expect(mod.verifyParams(notify(), '', 'RSA2')).toBe(false);

    delete process.env.ALIPAY_PUBLIC_KEY;
    const sig = signWith(mod.buildSignString(notify(), ['sign', 'sign_type']));
    expect(mod.verifyParams(notify(), sig, 'RSA2')).toBe(false);
  });

  it('用别人的公钥验签 → 失败', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    process.env.ALIPAY_PUBLIC_KEY = other.publicKey;
    const mod = await loadModule();
    const params = notify();
    const sig = signWith(mod.buildSignString(params, ['sign', 'sign_type']));
    expect(mod.verifyParams(params, sig, 'RSA2')).toBe(false);
  });
});

describe('支付宝工具 - 配置判定', () => {
  it('未配置时 isAlipayConfigured 为 false（禁止静默当成可用）', async () => {
    const mod = await loadModule();
    expect(mod.isAlipayConfigured()).toBe(false);
    expect(mod.isAlipayNotifyConfigured()).toBe(false);
  });

  it('只有 appId + 私钥才算「可下单」；公钥与否不影响下单判定', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    const mod = await loadModule();
    expect(mod.isAlipayConfigured()).toBe(true);
    expect(mod.isAlipayNotifyConfigured()).toBe(false);
  });

  it('未配置私钥时 signParams 抛错（不产出无效签名）', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    const mod = await loadModule();
    expect(() => mod.signParams({ a: '1' })).toThrow(/ALIPAY_PRIVATE_KEY/);
  });
});

describe('支付宝工具 - 收银台 URL', () => {
  it('使用电脑网站支付 + qr_pay_mode=4（嵌入式二维码）', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    const mod = await loadModule();

    const url = mod.buildPagePayUrl({
      outTradeNo: 'ORD123',
      totalAmount: 19.9,
      subject: 'ClipSync Pro',
      notifyUrl: 'https://api.clipchain.top/api/webhooks/alipay',
    });

    expect(url).toContain('openapi.alipay.com/gateway.do');
    const q = new URL(url).searchParams;
    expect(q.get('method')).toBe('alipay.trade.page.pay');
    expect(q.get('sign_type')).toBe('RSA2');
    expect(q.get('notify_url')).toBe('https://api.clipchain.top/api/webhooks/alipay');

    const biz = JSON.parse(q.get('biz_content'));
    expect(biz.qr_pay_mode).toBe('4');
    expect(biz.product_code).toBe('FAST_INSTANT_TRADE_PAY');
    // 金额必须两位小数（支付宝要求，19.9 → "19.90"）
    expect(biz.total_amount).toBe('19.90');
    expect(biz.out_trade_no).toBe('ORD123');
    // H2：必须带渠道侧可支付窗口，且短于本地 24h 关单窗口（见 PAYMENT_TIMEOUT_EXPRESS 注释）
    expect(biz.timeout_express).toBe('1h');
    expect(q.get('sign')).toBeTruthy();
  });

  it('沙箱开关切到沙箱网关', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_SANDBOX = 'true';
    const mod = await loadModule();
    const url = mod.buildPagePayUrl({
      outTradeNo: 'ORD1',
      totalAmount: 1,
      subject: 'x',
      notifyUrl: 'https://example.com/n',
    });
    expect(url).toContain('openapi-sandbox.dl.alipaydev.com');
  });
});

describe('支付宝工具 - 网关响应验签（S3）', () => {
  // 口径（2026-09-19 生产实测钉死）：签名原文 = 响应节点**值的原始子串**，不含 "key": 前缀
  const node = (amount = '9.90') =>
    `{"code":"10000","msg":"Success","out_trade_no":"ORD1","total_amount":"${amount}"}`;

  it('正确响应原文验签通过', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    expect(mod.verifyResponseSignature(node(), signWith(node()))).toBe(true);
  });

  it('响应金额被篡改 → 验签失败', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const sig = signWith(node('9.90'));
    expect(mod.verifyResponseSignature(node('0.01'), sig)).toBe(false);
  });

  it('含键名前缀验签必须失败（钉死口径，防止改回 `"key":{...}` 旧实现）', async () => {
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    const mod = await loadModule();
    const value = node();
    const withKey = `"alipay_trade_query_response":${value}`;
    expect(mod.verifyResponseSignature(withKey, signWith(value))).toBe(false);
  });

  it('extractResponseNode：返回节点值（不含键名），字符串值内含花括号/转义不干扰配对', async () => {
    const mod = await loadModule();
    const text = `{"alipay_trade_query_response":{"code":"10000","sub_msg":"a{\\"b\\"}c"},"sign":"xx"}`;
    expect(mod.extractResponseNode(text, 'alipay_trade_query_response')).toBe(
      `{"code":"10000","sub_msg":"a{\\"b\\"}c"}`,
    );
  });

  it('extractResponseNode：键不存在返回 null', async () => {
    const mod = await loadModule();
    expect(mod.extractResponseNode('{"other":{}}', 'alipay_trade_query_response')).toBeNull();
  });
});

describe('支付宝工具 - 退款 refundTrade（#10）', () => {
  const REFUND_KEY = 'alipay_trade_refund_response';

  /** 用测试内生成的私钥签响应原文（口径：只签节点**值**），模拟"真的来自支付宝"的网关响应 */
  function gatewayBody(payload) {
    const valueText = JSON.stringify(payload);
    return `{"${REFUND_KEY}":${valueText},"sign":"${signWith(valueText)}"}`;
  }

  function stubGateway(payload) {
    const fn = vi.fn(async () => ({ text: async () => gatewayBody(payload) }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function configuredEnv() {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = PUB;
  }

  const successPayload = {
    code: '10000',
    msg: 'Success',
    trade_no: '2026091922001456789',
    out_trade_no: 'ORD123',
    fund_status: 'Y',
    refund_amount: '9.90',
    buyer_logon_id: 't***@example.com',
  };

  it('请求报文：method=alipay.trade.refund，biz_content 含三个必填字段且金额为两位小数', async () => {
    configuredEnv();
    const fn = stubGateway(successPayload);
    const mod = await loadModule();

    await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 });

    const [url, opts] = fn.mock.calls[0];
    expect(String(url)).toContain('openapi.alipay.com/gateway.do');
    const form = new URLSearchParams(opts.body);
    expect(form.get('method')).toBe('alipay.trade.refund');
    expect(form.get('sign')).toBeTruthy();
    const biz = JSON.parse(form.get('biz_content'));
    expect(biz).toEqual({
      out_trade_no: 'ORD123',
      refund_amount: '9.90', // 支付宝要求字符串、最多两位小数
      out_request_no: 'ORD123', // 缺省用订单号 → 全额退款天然幂等
    });
  });

  it('可显式传 out_request_no（为后续部分退款/多次退款留的扩展位）', async () => {
    configuredEnv();
    const fn = stubGateway(successPayload);
    const mod = await loadModule();
    await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: '1.00', outRequestNo: 'ORD123-2' });
    const biz = JSON.parse(new URLSearchParams(fn.mock.calls[0][1].body).get('biz_content'));
    expect(biz.out_request_no).toBe('ORD123-2');
  });

  it('fund_status=Y 才算成功，并回传 payload 供上层留痕', async () => {
    configuredEnv();
    stubGateway(successPayload);
    const mod = await loadModule();
    const r = await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 });
    expect(r.ok).toBe(true);
    expect(r.fundStatus).toBe('Y');
    expect(r.code).toBe('10000');
    expect(r.tradeNo).toBe('2026091922001456789');
    expect(r.payload).toMatchObject({ fund_status: 'Y', refund_amount: '9.90' });
  });

  it('code=10000 但 fund_status=C/D → ok=false（绝不能当成功退款）', async () => {
    configuredEnv();
    const mod = await loadModule();

    for (const fundStatus of ['C', 'D']) {
      stubGateway({ ...successPayload, fund_status: fundStatus });
      const r = await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 });
      expect(r.ok).toBe(false);
      expect(r.fundStatus).toBe(fundStatus);
    }
  });

  it('业务失败（code≠10000）抛错并带上 code/subCode 供路由回给客服', async () => {
    configuredEnv();
    stubGateway({
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'TRADE_NOT_EXIST',
      sub_msg: '交易不存在',
      out_trade_no: 'ORD123',
    });
    const mod = await loadModule();

    await expect(mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 })).rejects.toMatchObject({
      code: '40004',
      subCode: 'TRADE_NOT_EXIST',
    });
  });

  it('响应未签名 / 签名与报文不符 → 抛错（伪造 Y 不可信）', async () => {
    configuredEnv();
    const mod = await loadModule();

    // 1) 完全没有 sign 字段
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => JSON.stringify({ [REFUND_KEY]: successPayload }) })));
    await expect(mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 })).rejects.toThrow(/no sign/);

    // 2) 有 sign 但报文被改（把 9.90 改成 99.00，签名仍按原报文）
    const tampered = `{"${REFUND_KEY}":${JSON.stringify({ ...successPayload, refund_amount: '99.00' })},"sign":"${signWith(JSON.stringify(successPayload))}"}`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => tampered })));
    await expect(mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 9.9 })).rejects.toThrow(/signature invalid/);
  });

  it('现行接口形态：无 fund_status，code=10000 + fund_change=Y → ok=true（2026-09-19 生产实测）', async () => {
    configuredEnv();
    stubGateway({
      code: '10000',
      msg: 'Success',
      trade_no: '2026091922001451181401908425',
      out_trade_no: 'ORD123',
      fund_change: 'Y',
      gmt_refund_pay: '2026-09-19 22:09:57',
      refund_fee: '0.01',
      send_back_fee: '0.00',
    });
    const mod = await loadModule();
    const r = await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 0.01 });
    expect(r.ok).toBe(true);
    expect(r.fundStatus).toBe('Y'); // fund_status 缺失时回退 fund_change
    expect(r.refundAmount).toBe('0.01'); // 现行字段名是 refund_fee
  });

  it('幂等重放：code=10000 + fund_change=N（首笔已退成功）→ ok=true，对账可收敛', async () => {
    configuredEnv();
    stubGateway({
      code: '10000',
      msg: 'Success',
      trade_no: '2026091922001451181401908425',
      out_trade_no: 'ORD123',
      fund_change: 'N',
      gmt_refund_pay: '2026-09-19 22:09:57',
      refund_fee: '0.01',
    });
    const mod = await loadModule();
    const r = await mod.refundTrade({ outTradeNo: 'ORD123', refundAmount: 0.01 });
    expect(r.ok).toBe(true);
    expect(r.fundStatus).toBe('N');
  });

  it('入参非法时不发请求（缺订单号 / 金额 ≤ 0 / 非数字）', async () => {
    configuredEnv();
    const fn = stubGateway(successPayload);
    const mod = await loadModule();

    await expect(mod.refundTrade({ refundAmount: 9.9 })).rejects.toThrow(/outTradeNo/);
    await expect(mod.refundTrade({ outTradeNo: 'ORD1', refundAmount: 0 })).rejects.toThrow(/refundAmount/);
    await expect(mod.refundTrade({ outTradeNo: 'ORD1', refundAmount: -1 })).rejects.toThrow(/refundAmount/);
    await expect(mod.refundTrade({ outTradeNo: 'ORD1', refundAmount: 'abc' })).rejects.toThrow(/refundAmount/);
    expect(fn).not.toHaveBeenCalled();
  });
});

/**
 * C1（2026-09-29 审计发现）：响应验签与业务取数曾经不是同一份数据。
 *
 * `payload = json[responseKey]` 走 `JSON.parse`（重复键取**最后一个**），
 * 而 `extractResponseNode` 用 `indexOf` 取**第一个**。攻击者能篡改出站响应时，
 * 可用「截获的真签名节点 A（第一个）+ 伪造的成功节点 B（第二个）」让验签通过、
 * 业务却读到 B —— `queryTrade` 即返回 TRADE_SUCCESS，未付款开通订阅。
 *
 * 修法：验签前拒绝重复键；业务数据只从**验签过的字节**反序列化。
 * 这两条共同保证「验签的对象」与「使用的对象」恒为同一个。
 */
describe('支付宝工具 - 响应取数必须来自验签字节（C1）', () => {
  const QUERY_KEY = 'alipay_trade_query_response';

  function configuredEnv() {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = PUB;
  }

  function stubText(body) {
    const fn = vi.fn(async () => ({ text: async () => body }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('重复响应键 → 直接拒绝（这是 C1 的利用形态：真签名节点 + 伪造成功节点）', async () => {
    configuredEnv();
    // 节点 A：真实的「交易不存在」错误响应，带真签名
    const nodeA = JSON.stringify({ code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST' });
    // 节点 B：伪造的成功响应（无签名，仅靠「JSON.parse 取最后一个」生效）
    const nodeB = JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS', total_amount: '19.90' });
    stubText(`{"${QUERY_KEY}":${nodeA},"${QUERY_KEY}":${nodeB},"sign":"${signWith(nodeA)}"}`);
    const mod = await loadModule();

    await expect(mod.queryTrade('ORD_C1')).rejects.toThrow(/duplicate/i);
  });

  it('第三次出现同一个键同样拒绝（不是只查第二个）', async () => {
    configuredEnv();
    const nodeA = JSON.stringify({ code: '40004', msg: 'Business Failed' });
    const nodeB = JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS' });
    stubText(
      `{"${QUERY_KEY}":${nodeA},"junk":1,"${QUERY_KEY}":${nodeB},"junk2":2,"${QUERY_KEY}":${nodeB},"sign":"${signWith(nodeA)}"}`
    );
    const mod = await loadModule();

    await expect(mod.queryTrade('ORD_C1')).rejects.toThrow(/duplicate/i);
  });

  it('正常单键响应不受影响：验签通过且业务字段可用（防改坏正常支付）', async () => {
    configuredEnv();
    const node = JSON.stringify({
      code: '10000',
      msg: 'Success',
      trade_no: '2026092922001456789',
      out_trade_no: 'ORD_OK',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '9.90',
    });
    stubText(`{"${QUERY_KEY}":${node},"sign":"${signWith(node)}"}`);
    const mod = await loadModule();

    const r = await mod.queryTrade('ORD_OK');
    expect(r.paid).toBe(true);
    expect(r.tradeStatus).toBe('TRADE_SUCCESS');
    expect(r.tradeNo).toBe('2026092922001456789');
    expect(r.raw.total_amount).toBe('9.90'); // 未付款状态同样要能读到
  });

  it('未付款（WAIT_BUYER_PAY）不应被判成已付', async () => {
    configuredEnv();
    const node = JSON.stringify({ code: '10000', trade_status: 'WAIT_BUYER_PAY', out_trade_no: 'ORD_WAIT' });
    stubText(`{"${QUERY_KEY}":${node},"sign":"${signWith(node)}"}`);
    const mod = await loadModule();

    const r = await mod.queryTrade('ORD_WAIT');
    expect(r.paid).toBe(false);
    expect(r.tradeStatus).toBe('WAIT_BUYER_PAY');
  });

  it('报文被篡改（改了节点内容但签名照旧）→ 仍然验签失败', async () => {
    configuredEnv();
    const genuine = JSON.stringify({ code: '10000', trade_status: 'WAIT_BUYER_PAY', total_amount: '9.90' });
    const tampered = JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS', total_amount: '9.90' });
    stubText(`{"${QUERY_KEY}":${tampered},"sign":"${signWith(genuine)}"}`);
    const mod = await loadModule();

    await expect(mod.queryTrade('ORD_TAMPER')).rejects.toThrow(/signature invalid/i);
  });
});

/**
 * H2（2026-09-29 审计）：超时关单必须在渠道侧先关，否则本地已 cancelled
 * 而支付宝侧仍可支付 → 用户付款成功但订单永远无法履约，且退款接口拒收 cancelled 单。
 *
 * `closeTrade` 是这条链路的下半段。它必须：
 *   · 只在渠道明确「没有这笔交易」或「已关闭」时算成功（可安全本地关单）
 *   · 其它任何错误（尤其「已付款/已完成」类）一律抛出，让调用方**不要**关本地单
 */
describe('支付宝工具 - 关单 closeTrade（H2）', () => {
  const CLOSE_KEY = 'alipay_trade_close_response';

  function stubGateway(payload) {
    const valueText = JSON.stringify(payload);
    const body = `{"${CLOSE_KEY}":${valueText},"sign":"${signWith(valueText)}"}`;
    const fn = vi.fn(async () => ({ text: async () => body }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function configuredEnv() {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = PUB;
  }

  function errorBody(code, subCode, subMsg) {
    const valueText = JSON.stringify({ code, msg: 'Business Failed', sub_code: subCode, sub_msg: subMsg });
    return `{"${CLOSE_KEY}":${valueText},"sign":"${signWith(valueText)}"}`;
  }

  it('method=alipay.trade.close，biz_content 只带 out_trade_no', async () => {
    configuredEnv();
    const fn = stubGateway({ code: '10000', msg: 'Success', trade_no: 'T1', out_trade_no: 'ORD123' });
    const mod = await loadModule();

    const r = await mod.closeTrade('ORD123');

    const form = new URLSearchParams(fn.mock.calls[0][1].body);
    expect(form.get('method')).toBe('alipay.trade.close');
    expect(JSON.parse(form.get('biz_content'))).toEqual({ out_trade_no: 'ORD123' });
    expect(r.closed).toBe(true);
    expect(r.alreadyClosed).toBeUndefined();
  });

  it('渠道没有这笔交易（ACQ.TRADE_NOT_EXIST）→ 视为已不可支付，可安全关单', async () => {
    configuredEnv();
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => errorBody('40004', 'ACQ.TRADE_NOT_EXIST', '交易不存在') })));
    const mod = await loadModule();

    const r = await mod.closeTrade('ORD123');
    expect(r.closed).toBe(true);
    expect(r.alreadyClosed).toBe(true);
    expect(r.subCode).toBe('ACQ.TRADE_NOT_EXIST');
  });

  it('渠道已关闭（ACQ.TRADE_HAS_CLOSE）→ 同样可安全关单', async () => {
    configuredEnv();
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => errorBody('40004', 'ACQ.TRADE_HAS_CLOSE', '交易已关闭') })));
    const mod = await loadModule();

    const r = await mod.closeTrade('ORD123');
    expect(r.closed).toBe(true);
    expect(r.alreadyClosed).toBe(true);
  });

  it('其它错误（如交易已完成）→ 必须抛出，绝不能被当成"可安全关单"', async () => {
    configuredEnv();
    // 关键安全断言：把「已付款/已完成」类错误当良性会让本地订单被错误关掉
    for (const subCode of ['ACQ.TRADE_HAS_FINISHED', 'ACQ.TRADE_STATUS_ERROR', 'SYSTEM_ERROR']) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => errorBody('40004', subCode, '不可关单') })));
      const mod = await loadModule();
      await expect(mod.closeTrade('ORD123')).rejects.toMatchObject({ subCode });
    }
  });

  it('缺订单号时不发请求', async () => {
    configuredEnv();
    const fn = stubGateway({ code: '10000', msg: 'Success' });
    const mod = await loadModule();

    await expect(mod.closeTrade('')).rejects.toThrow(/outTradeNo/);
    await expect(mod.closeTrade()).rejects.toThrow(/outTradeNo/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('响应未签名 → 抛错（不能凭未验签报文认定渠道已关单）', async () => {
    configuredEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ text: async () => JSON.stringify({ [CLOSE_KEY]: { code: '10000', msg: 'Success' } }) }))
    );
    const mod = await loadModule();

    await expect(mod.closeTrade('ORD123')).rejects.toThrow(/no sign/);
  });
});

/**
 * H1（2026-09-29 审计）：启动期凭据自检。
 *
 * 「有 appId + 私钥」≠「回调能验签」。最能坑人的是把**应用公钥**当成
 * **支付宝公钥**填进去 —— 格式完全合法，静态检查看不出来，但回调验签 100% 失败
 * → 用户付了真钱、订阅永远不开。检测手段：Alipay 模型下两者不是一对，
 * 因此「用应用私钥签 → 用配置的公钥验」正常情况下应当**失败**；
 * 若竟然验通，就说明填错了。
 */
describe('支付宝工具 - 凭据自检 checkAlipayCredentials（H1）', () => {
  // 另一对独立密钥，模拟"支付宝的公钥"
  const { publicKey: ALIPAY_SIDE_PUB } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  it('正确配置（公钥是另一对）→ ok=true，无问题', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = ALIPAY_SIDE_PUB; // 与 privBody 不成对 = 正确形态

    const mod = await loadModule();
    const r = mod.checkAlipayCredentials();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('公钥误填成「应用公钥」（与私钥成对）→ ok=false 且明确指出填错了', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = PUB; // ← 这是应用公钥，最典型的错法

    const mod = await loadModule();
    const r = mod.checkAlipayCredentials();
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/应用公钥/);
  });

  it('缺公钥 / 只有空白 → 报告未配置（与 create-order 的闸同口径）', async () => {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    delete process.env.ALIPAY_PUBLIC_KEY;

    const mod = await loadModule();
    expect(mod.checkAlipayCredentials().problems.join(' ')).toMatch(/ALIPAY_PUBLIC_KEY 未配置/);

    process.env.ALIPAY_PUBLIC_KEY = '   ';
    expect(mod.checkAlipayCredentials().problems.join(' ')).toMatch(/ALIPAY_PUBLIC_KEY 未配置/);
  });

  it('缺 APP_ID / 缺私钥 / 私钥格式坏 → 逐项报告，且不抛异常', async () => {
    const mod = await loadModule();

    // 三个都缺
    delete process.env.ALIPAY_APP_ID;
    delete process.env.ALIPAY_PRIVATE_KEY;
    delete process.env.ALIPAY_PUBLIC_KEY;
    const all = mod.checkAlipayCredentials();
    expect(all.ok).toBe(false);
    expect(all.problems.length).toBe(3);

    // 私钥是垃圾串（粘贴截断 / 漏头）
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'not-a-real-key';
    process.env.ALIPAY_PUBLIC_KEY = ALIPAY_SIDE_PUB;
    const bad = mod.checkAlipayCredentials();
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/无法用于签名|无法解析/);
  });

  it('自检本身绝不抛异常（启动期不能因凭据问题崩掉整个 API）', async () => {
    process.env.ALIPAY_APP_ID = '';
    process.env.ALIPAY_PRIVATE_KEY = '';
    process.env.ALIPAY_PUBLIC_KEY = '';
    const mod = await loadModule();
    expect(() => mod.checkAlipayCredentials()).not.toThrow();
  });
});

/**
 * H3（2026-10-03 审计）：退款查单。
 *
 * 迁移 074 的注释要求「停在 processing 的退款行必须先去支付宝查单，不能盲重试」，
 * 但此前全仓只有 `alipay.trade.refund`（发起）而没有它的查询接口 ——
 * 那一行一旦卡住，就没有任何手段能确认钱到底退没退。
 *
 * 查询键必须与发起侧**同源**：refundPaidOrder 固定用订单号做 out_request_no，
 * 所以这里也用同一对 (out_trade_no, out_request_no) 反查。
 */
describe('支付宝工具 - 退款查单 queryRefund（H3）', () => {
  const REFUND_QUERY_KEY = 'alipay_trade_fastpay_refund_query_response';

  function stubGateway(payload) {
    const valueText = JSON.stringify(payload);
    const body = `{"${REFUND_QUERY_KEY}":${valueText},"sign":"${signWith(valueText)}"}`;
    const fn = vi.fn(async () => ({ text: async () => body }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function configuredEnv() {
    process.env.ALIPAY_APP_ID = '2021000000000000';
    process.env.ALIPAY_PRIVATE_KEY = privBody;
    process.env.ALIPAY_PUBLIC_KEY = PUB;
  }

  it('method 与 biz_content 口径正确；out_request_no 缺省用订单号（与发起侧同源）', async () => {
    configuredEnv();
    const fn = stubGateway({ code: '10000', msg: 'Success', refund_status: 'REFUND_SUCCESS' });
    const mod = await loadModule();

    await mod.queryRefund({ outTradeNo: 'ORD123' });

    const form = new URLSearchParams(fn.mock.calls[0][1].body);
    expect(form.get('method')).toBe('alipay.trade.fastpay.refund.query');
    expect(JSON.parse(form.get('biz_content'))).toEqual({
      out_trade_no: 'ORD123',
      out_request_no: 'ORD123',
    });
  });

  it('refund_status=REFUND_SUCCESS → refunded=true，并回传金额/交易号', async () => {
    configuredEnv();
    stubGateway({
      code: '10000',
      msg: 'Success',
      trade_no: '2026100322001456789',
      out_trade_no: 'ORD123',
      out_request_no: 'ORD123',
      refund_status: 'REFUND_SUCCESS',
      refund_amount: '19.90',
    });
    const mod = await loadModule();

    const r = await mod.queryRefund({ outTradeNo: 'ORD123' });
    expect(r.refunded).toBe(true);
    expect(r.refundStatus).toBe('REFUND_SUCCESS');
    expect(r.refundAmount).toBe('19.90');
    expect(r.tradeNo).toBe('2026100322001456789');
  });

  it('没有退款记录（无 refund_status）→ refunded=false，绝不能当成"已退款"', async () => {
    configuredEnv();
    stubGateway({ code: '10000', msg: 'Success', trade_no: 'T1', out_trade_no: 'ORD123' });
    const mod = await loadModule();

    const r = await mod.queryRefund({ outTradeNo: 'ORD123' });
    expect(r.refunded).toBe(false);
    expect(r.refundStatus).toBeNull();
  });

  it('可显式传 out_request_no（为将来的部分退款留扩展位）', async () => {
    configuredEnv();
    const fn = stubGateway({ code: '10000', refund_status: 'REFUND_SUCCESS' });
    const mod = await loadModule();

    await mod.queryRefund({ outTradeNo: 'ORD123', outRequestNo: 'ORD123-2' });
    const biz = JSON.parse(new URLSearchParams(fn.mock.calls[0][1].body).get('biz_content'));
    expect(biz.out_request_no).toBe('ORD123-2');
  });

  it('缺订单号时不发请求', async () => {
    configuredEnv();
    const fn = stubGateway({ code: '10000' });
    const mod = await loadModule();

    await expect(mod.queryRefund({})).rejects.toThrow(/outTradeNo/);
    await expect(mod.queryRefund()).rejects.toThrow(/outTradeNo/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('响应未签名 → 抛错（不能凭未验签报文断定退款结果）', async () => {
    configuredEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        text: async () => JSON.stringify({ [REFUND_QUERY_KEY]: { code: '10000', refund_status: 'REFUND_SUCCESS' } }),
      }))
    );
    const mod = await loadModule();

    await expect(mod.queryRefund({ outTradeNo: 'ORD123' })).rejects.toThrow(/no sign/);
  });
});

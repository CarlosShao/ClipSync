import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

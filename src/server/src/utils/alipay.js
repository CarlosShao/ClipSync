import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * 支付宝开放平台客户端（自实现，不引第三方 SDK）。
 *
 * 为什么手写而不装 `alipay-sdk`：
 *  1. 本项目只用三个服务端接口（电脑网站支付下单 + 交易查询 + 退款）和回调验签，
 *     SDK 带来的体积/传递依赖不划算；
 *  2. 回调验签本就必须自己控制「原始报文」与「排序规则」，SDK 反而遮住了细节；
 *  3. 项目已有手写 crypto 验签的先例（`middleware/webhook-signature.js`）。
 *
 * ⚠️ 三条容易写错、写错必然验签失败的铁律（官方文档口径）：
 *  1. **签名串的字段顺序**：按参数名 ASCII 升序，用 `k=v&k=v` 拼接，**末尾不加 &**。
 *  2. **不参与签名的字段**：请求签名时排除 `sign`；回调验签时还要排除 `sign_type`。
 *  3. **签名用未编码的原值**：签名基于原始值，URL 编码只在最终发送时做。
 *     反之验签时，回调报文已被 `express.urlencoded` 解码，直接取 `req.body` 的原值即可
 *     —— **不要**再手动 encode/decode 一次。
 */

const GATEWAY_PROD = 'https://openapi.alipay.com/gateway.do';
const GATEWAY_SANDBOX = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

/** 电脑网站支付的产品码（固定值）。 */
const PRODUCT_CODE_PAGE_PAY = 'FAST_INSTANT_TRADE_PAY';

/**
 * 读取运行时配置。**每次调用都读 process.env**，不缓存：
 * 管理台改配置后重启即可生效，避免「改了没反应」的排查陷阱。
 */
function getConfig() {
  const appId = process.env.ALIPAY_APP_ID || '';
  const privateKey = process.env.ALIPAY_PRIVATE_KEY || '';
  const publicKey = process.env.ALIPAY_PUBLIC_KEY || '';
  const useSandbox = String(process.env.ALIPAY_SANDBOX || '').toLowerCase() === 'true';
  return {
    appId,
    privateKey,
    publicKey,
    gateway: useSandbox ? GATEWAY_SANDBOX : GATEWAY_PROD,
    useSandbox,
  };
}

/**
 * 是否已配置到「可以发起真实支付」的程度。
 * 只判断下单必需的 appId + 应用私钥；回调验签另需公钥（见 isNotifyConfigured）。
 */
export function isAlipayConfigured() {
  const { appId, privateKey } = getConfig();
  return Boolean(appId && privateKey);
}

/** 回调验签所需的公钥是否已配置。 */
export function isAlipayNotifyConfigured() {
  const { publicKey } = getConfig();
  return Boolean(publicKey);
}

/**
 * 把支付宝控制台/密钥工具给出的**裸 base64 密钥**补成 PEM。
 *
 * 支付宝后台复制的公私钥是单行 base64（无 -----BEGIN----- 头），
 * 而 Node 的 crypto 只认 PEM。若不补头，`createSign` 会抛
 * `error:0909006C:PEM routines:get_name:no start line`。
 *
 * 已有 PEM 头的输入原样返回（幂等），便于运维直接贴文件内容。
 *
 * @param {string} key 裸 base64 或 PEM
 * @param {'PRIVATE'|'PUBLIC'} kind
 */
export function toPem(key, kind) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) {
    // 兼容字面量 \n（.env 里换行常被写成两个字符）
    return raw.replace(/\\n/g, '\n');
  }
  const label = kind === 'PRIVATE' ? 'RSA PRIVATE KEY' : 'PUBLIC KEY';
  const body = raw.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** 当前时间戳，格式 `yyyy-MM-dd HH:mm:ss`（支付宝要求北京时间，不带时区后缀）。 */
function alipayTimestamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  // 容器 TZ 已设为 Asia/Shanghai；这里仍显式按 +08:00 换算，避免依赖部署环境
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return (
    `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ` +
    `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`
  );
}

/**
 * 构造待签名串：按 key ASCII 升序，`k=v` 用 `&` 连接，末尾无 &。
 *
 * ⚠️ 两条容易错、错了必然验签失败的规则：
 *
 * 1. **空值必须剔除**。官方 Java SDK `AlipaySignature.getSignCheckContentV1()` 用
 *    `StringUtils.areNotEmpty(key, value)` 过滤，空 key / 空 value 直接跳过。
 *    保留空值会与服务端重算的签名串不一致 → 验签 100% 失败。
 *
 * 2. **排除字段因场景而异**：
 *    - 请求签名：只排除 `sign`（`sign_type` 要参与）
 *    - 回调/响应验签：还要排除 `sign_type`
 *    写死任一种都会在另一侧失败，故用 `exclude` 显式传入。
 *
 * 另注：回调报文已被 `express.urlencoded` 解码，**直接取原值**即可，
 * 不要再手动 decode 一次（SDK 解码是因为它读的是未解码的原始 query）。
 *
 * @param {object} params    参与签名的参数
 * @param {string[]} [exclude] 排除的字段名
 */
export function buildSignString(params, exclude = ['sign']) {
  const skip = new Set(exclude);
  return Object.keys(params)
    .filter((k) => {
      if (skip.has(k)) return false;
      const v = params[k];
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v === '') return false; // 空串剔除（见上）
      return true;
    })
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/**
 * RSA2(SHA256withRSA) 签名，返回 base64。
 * @param {object} params 参与签名的参数（不含 sign）
 */
export function signParams(params) {
  const { privateKey } = getConfig();
  if (!privateKey) throw new Error('ALIPAY_PRIVATE_KEY not configured');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(buildSignString(params), 'utf8');
  return signer.sign(toPem(privateKey, 'PRIVATE'), 'base64');
}

/**
 * 校验支付宝回调/响应签名。
 *
 * 参与验签的字段 = 回调全部字段 − `sign` − `sign_type`，其余规则同 buildSignString。
 *
 * @param {object} params     回调参数（已由 body parser 解码，直接用原值）
 * @param {string} signature  base64 签名
 * @param {string} [signType] 默认 RSA2
 * @returns {boolean}
 */
export function verifyParams(params, signature, signType = 'RSA2') {
  const { publicKey } = getConfig();
  if (!publicKey) {
    logger.error('[alipay] ALIPAY_PUBLIC_KEY not configured, cannot verify');
    return false;
  }
  if (!signature) return false;

  const signString = buildSignString(params, ['sign', 'sign_type']);
  const algorithm = signType === 'RSA2' ? 'RSA-SHA256' : 'RSA-SHA1';
  try {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(signString, 'utf8');
    return verifier.verify(toPem(publicKey, 'PUBLIC'), signature, 'base64');
  } catch (err) {
    logger.error('[alipay] verifyParams error', { error: err.message });
    return false;
  }
}

/**
 * 组装公共请求参数（除 biz_content 外的固定字段）。
 */
function commonParams(method, notifyUrl) {
  const { appId } = getConfig();
  const params = {
    app_id: appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
  };
  if (notifyUrl) params.notify_url = notifyUrl;
  return params;
}

/**
 * 校验支付宝网关响应签名（S3）。
 *
 * ⚠️ 签名原文口径（2026-09-19 生产实测钉死）：是响应节点**值的原始 JSON 子串**
 * （即 `"alipay_trade_refund_response":` 冒号后面的 `{...}` 本身，**不含键名与冒号**），
 * 且必须是响应文本的原始字节——不能 JSON.parse 后重新 stringify（键序/数字格式会变）。
 * 历史教训：最初按官方文档摘录写成 `"key":{...}`（含键名）口径，结果对真实响应
 * **100% 验签失败**——退款实际已在支付宝侧成功却被判为渠道失败。口径变更的
 * 判据实验（node_value_only RSA2 验签通过，其余口径全部失败）已留档。
 */
export function verifyResponseSignature(nodeContent, signature) {
  const { publicKey } = getConfig();
  if (!publicKey || !signature || !nodeContent) return false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(nodeContent, 'utf8');
    return verifier.verify(toPem(publicKey, 'PUBLIC'), signature, 'base64');
  } catch (err) {
    logger.error('[alipay] verifyResponseSignature error', { error: err.message });
    return false;
  }
}

/**
 * 从响应原文中截取 `"responseKey":{...}` 的**值部分**（`{` 到配对 `}`，
 * 跳过字符串内的括号/转义）。返回的子串即验签原文——不含键名与冒号（见上）。
 * 截不到（无该键/JSON 异常）返回 null，调用方按验签失败处理，绝不降级信任。
 */
export function extractResponseNode(text, responseKey) {
  const marker = `"${responseKey}":`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  if (text[i] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start + marker.length, i + 1);
    }
  }
  return null;
}

/**
 * 发起一次网关调用（application/x-www-form-urlencoded POST）。
 *
 * 注意：这里用 POST + 表单，是支付宝**服务端接口**的标准调用方式；
 * 与「电脑网站支付」返回给浏览器收银台的形式是两回事（见 buildPagePayUrl）。
 */
async function callGateway(method, bizContent, notifyUrl) {
  const params = { ...commonParams(method, notifyUrl), biz_content: JSON.stringify(bizContent) };
  params.sign = signParams(params);

  const body = new URLSearchParams(params).toString();
  const { gateway } = getConfig();

  const res = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`alipay gateway returned non-JSON: ${text.slice(0, 200)}`);
  }

  // 响应键名规则：方法名把点换成下划线，再加 _response
  //   例：alipay.trade.query → alipay_trade_query_response
  const responseKey = `${method.replace(/\./g, '_')}_response`;
  const payload = json[responseKey];
  if (!payload) {
    throw new Error(`alipay response missing ${responseKey}: ${text.slice(0, 200)}`);
  }

  // S3：响应必须验签后才可信（含错误响应——伪造 code!=10000 可制造假故障）。
  // 缺 sign / 截不到原文 / 验签失败，一律拒绝，绝不降级信任。
  if (!json.sign) {
    throw new Error(`alipay response for ${method} has no sign field`);
  }
  const nodeContent = extractResponseNode(text, responseKey);
  if (!nodeContent || !verifyResponseSignature(nodeContent, json.sign)) {
    throw new Error(`alipay response signature invalid for ${method}`);
  }

  if (payload.code && payload.code !== '10000') {
    const err = new Error(`alipay error ${payload.code}: ${payload.sub_msg || payload.msg}`);
    err.code = payload.code;
    err.subCode = payload.sub_code;
    throw err;
  }
  return payload;
}

/**
 * 生成「电脑网站支付」的收银台 URL（用于前端 iframe 内嵌二维码）。
 *
 * 为什么返回 URL 而不是 HTML 表单：
 *  前端要把收银台放进 iframe。`qr_pay_mode` 的「前置模式」正是为此设计
 *  （官方文档：前置模式是把二维码前置到商户订单确认页，需商户以 iframe 请求支付宝页面）。
 *  以 GET + query 调 gateway.do 同样会返回收银台页面，故直接给出 iframe.src 即可。
 *
 * @param {object} p
 * @param {string} p.outTradeNo  商户订单号（同 order_no）
 * @param {string|number} p.totalAmount 金额（元，最多两位小数）
 * @param {string} p.subject     商品标题（用户账单可见）
 * @param {string} p.notifyUrl   异步通知地址（必须公网可达）
 * @param {string} [p.returnUrl] 同步跳转地址（本方案不依赖，用户付完停在收银台页）
 * @returns {string} 收银台 URL
 */
export function buildPagePayUrl({ outTradeNo, totalAmount, subject, notifyUrl, returnUrl }) {
  const bizContent = {
    out_trade_no: outTradeNo,
    total_amount: Number(totalAmount).toFixed(2),
    subject: String(subject || 'ClipSync 订阅').slice(0, 256),
    product_code: PRODUCT_CODE_PAGE_PAY,
    // 4 = 订单码-可定义宽度的嵌入式二维码（把二维码前置到商户页面）
    qr_pay_mode: '4',
    qrcode_width: '200',
  };

  const params = { ...commonParams('alipay.trade.page.pay', notifyUrl), biz_content: JSON.stringify(bizContent) };
  if (returnUrl) params.return_url = returnUrl;
  params.sign = signParams(params);

  const { gateway } = getConfig();
  return `${gateway}?${new URLSearchParams(params).toString()}`;
}

/**
 * 主动查询交易状态（轮询兜底）。
 *
 * 为什么不只依赖回调：回调可能因为网络/部署问题没到达。客户端轮询时
 * 服务端顺带查一次支付宝，能显著降低「用户付了钱但订单还是 pending」的概率。
 *
 * @param {string} outTradeNo 商户订单号
 * @returns {Promise<{paid:boolean, tradeStatus?:string, tradeNo?:string, raw?:object}>}
 */
export async function queryTrade(outTradeNo) {
  const payload = await callGateway('alipay.trade.query', { out_trade_no: outTradeNo });
  const tradeStatus = payload.trade_status;
  return {
    // TRADE_SUCCESS 交易支付成功；TRADE_FINISHED 交易结束不可退款，同样算已付
    paid: tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED',
    tradeStatus,
    tradeNo: payload.trade_no,
    raw: payload,
  };
}

/**
 * 发起退款（alipay.trade.refund）。
 *
 * 与 queryTrade 同样走 callGateway —— 响应**强制验签**，否则伪造的
 * `fund_status: "Y"` 能让服务端在钱没退出去的情况下把订单标成 refunded。
 *
 * 幂等：`out_request_no` 是支付宝侧的退款请求号，同一笔请求重复提交不会重复扣款，
 * 因此全额退款固定用商户订单号充当（一期只做全额退款，见 routes/payments.js /refund）。
 * 换 out_request_no 即可做部分退款/多次退款（本期未开放）。
 *
 * fund_status 语义（仅旧版接口返回；现行 alipay.trade.refund 响应**没有** fund_status，
 * 2026-09-19 生产实测确认）：'Y' 成功 / 'C' 失败 / 'D' 未知。
 * 现行接口的成功判定：callGateway 已保证 code='10000'（非 10000 一律抛错），
 * 退款请求即进入成功态；fund_change 只描述**本次调用**是否发生资金变动——
 * 同一 out_request_no 幂等重放返回 code=10000 + fund_change='N'，含义是
 * 「此前该请求已成功退款」，绝不能当作失败（否则本地永远对不上账）。
 * 真正的失败只会以 code!=10000 出现（如 REFUND_FEE_EXCEED / TRADE_STATUS_NOT_ALLOWED）。
 *
 * @param {object} p
 * @param {string} p.outTradeNo    商户订单号（下单时的 out_trade_no）
 * @param {number|string} p.refundAmount 退款金额（元，最多两位小数）
 * @param {string} [p.outRequestNo] 退款请求号；缺省时用 outTradeNo（全额退款幂等键）
 * @returns {Promise<{ok:boolean, code:string, fundStatus:string, refundAmount:string,
 *                    tradeNo:string, outTradeNo:string, requestId:string, payload:object}>}
 */
export async function refundTrade({ outTradeNo, refundAmount, outRequestNo }) {
  if (!outTradeNo) throw new Error('refundTrade: outTradeNo is required');
  const amount = Number(refundAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`refundTrade: invalid refundAmount ${refundAmount}`);
  }

  const bizContent = {
    out_trade_no: outTradeNo,
    refund_amount: amount.toFixed(2),
    out_request_no: String(outRequestNo || outTradeNo),
  };

  const payload = await callGateway('alipay.trade.refund', bizContent);

  return {
    // 旧版响应带 fund_status：只有 'Y' 算成功；现行响应不带该字段：code=10000（能走到
    // 这里就成立）即退款成功态，fund_change='N' 是幂等重放的正常表现（见上方注释）。
    ok: payload.fund_status ? payload.fund_status === 'Y' : true,
    code: payload.code,
    fundStatus: payload.fund_status || payload.fund_change || null,
    refundAmount: payload.refund_fee || payload.refund_amount || bizContent.refund_amount,
    tradeNo: payload.trade_no,
    outTradeNo: payload.out_trade_no || outTradeNo,
    requestId: bizContent.out_request_no,
    payload,
  };
}

export default {
  isAlipayConfigured,
  isAlipayNotifyConfigured,
  buildPagePayUrl,
  queryTrade,
  refundTrade,
  signParams,
  verifyParams,
  verifyResponseSignature,
  extractResponseNode,
  buildSignString,
  toPem,
};

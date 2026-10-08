import pool from '../db/pool.js';
import { logger } from './logger.js';
import { circuitBreakers } from './circuit-breaker.js';
import { decryptField } from './encryption.js';

// =============================================
// 短信发送（A4）
//
// 背景：文档 external-dependency-audit 第 1 节「脏状态」第 1 条 ——
// auth-verify.js 曾用固定码 888888 且无 NODE_ENV 判断，生产环境任何人
// 输 888888 即可登录任意手机号。本模块提供真实短信下发能力，
// 固定码逻辑由 routes/auth-verify.js 的环境判断取代（见该文件）。
//
// 配置来源（与 email.js 对称，复用 system_configs + 5s 缓存）：
//   sms_provider        aliyun | tencent | console（缺省 console）
//   sms_access_key_id   阿里云 AccessKeyId
//   sms_access_key_secret 阿里云 AccessKeySecret（加密落库，读取解密）
//   sms_sign_name       短信签名（需审核通过，如「ClipSync」）
//   sms_template_code   验证码模板 CODE（如 SMS_123456789）
//
// 设计原则：
//   - fail-closed 方向：配置不完整或发送失败时**绝不静默放行**。
//     未配置 → 返回 { ok:false, reason:'not_configured' }，
//     由调用方决定是否降级；绝不用固定码冒充发送成功。
//   - 断路器保护：走 circuitBreakers.sms，网关连续失败时快速失败，
//     避免把请求线程拖死在网关节超时上。
//   - SDK 动态 import：未开通短信时（provider=console）不加载阿里云 SDK，
//     保持与 storage.js 一致的可选依赖策略。
// =============================================

const SMS_TTL_MS = 5000;
const SMS_KEYS = [
  'sms_provider',
  'sms_access_key_id',
  'sms_access_key_secret',
  'sms_sign_name',
  'sms_template_code',
];

// { config: object|null, at: number } —— config 为 null 表示「已读库但未配置」
let smsCache = { config: undefined, at: 0 };

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * 读取 system_configs 的 sms_*（5s 进程内缓存）。
 * 返回 null 表示未配置或读库失败（调用方按未配置处理）。
 */
async function getSmsConfig() {
  const now = Date.now();
  if (smsCache.config !== undefined && now - smsCache.at < SMS_TTL_MS) {
    return smsCache.config;
  }
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)`,
      [SMS_KEYS]
    );
    const cfg = {};
    for (const r of rows) {
      let v = r.config_value;
      // JSONB 列：pg 返回已解析的 JS 值（字符串存的是带引号的 JSON）
      if (v && typeof v === 'object') v = v.value ?? '';
      cfg[r.config_key] = toTrimmedString(v);
    }
    const provider = cfg.sms_provider || 'console';
    const complete =
      provider !== 'console' &&
      cfg.sms_access_key_id &&
      cfg.sms_access_key_secret &&
      cfg.sms_sign_name &&
      cfg.sms_template_code;

    smsCache = { config: complete ? { ...cfg, provider } : null, at: now };
    return smsCache.config;
  } catch (err) {
    logger.warn('[sms] 读取 sms 配置失败，按未配置处理', { error: err.message });
    // 读库失败不覆写缓存（保住最近一次成功快照语义）
    return smsCache.config === undefined ? null : smsCache.config;
  }
}

/** 管理台改完配置后失效缓存（对齐 email.js / releaseArtifacts.js 惯例） */
export function invalidateSmsConfigCache() {
  smsCache = { config: undefined, at: 0 };
}

/**
 * 生成 6 位随机验证码（字符串，保证首位可为 0 时长度仍为 6）。
 * 与邮箱验证码一致用 Math.random，不引入 crypto 依赖（验证码非长期凭据，
 * 有效期 10 分钟 + 一次性消费 + 限流器已覆盖爆破面）。
 */
export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 发送短信验证码。
 *
 * @param {string} phone   手机号（国内 11 位，不带 +86）
 * @param {string} code    验证码
 * @returns {Promise<{ok: boolean, reason?: string, provider?: string, requestId?: string}>}
 *   ok=false 时 reason 取值：
 *     not_configured  未配置短信（provider=console 或配置不全）
 *     circuit_open    断路器打开（网关近期连续失败）
 *     send_failed     网关返回失败
 *     error           异常
 */
export async function sendVerificationCodeSms(phone, code) {
  const config = await getSmsConfig();

  if (!config) {
    // 未配置：明确告知调用方，绝不伪造成功
    logger.warn('[sms] 短信未配置，无法发送验证码', { phone });
    return { ok: false, reason: 'not_configured' };
  }

  // 断路器：execute 内部已处理 OPEN 快速失败（抛 code=CIRCUIT_OPEN），
  // 无需外部 isOpen 判断（circuit-breaker 仅导出 execute / getState）
  const breaker = circuitBreakers.sms;

  try {
    const result = await breaker.execute(async () => {
      if (config.provider === 'aliyun') {
        return await sendViaAliyun(config, phone, code);
      }
      if (config.provider === 'tencent') {
        return await sendViaTencent(config, phone, code);
      }
      throw new Error(`unsupported sms provider: ${config.provider}`);
    });

    logger.info('[sms] 验证码已发送', {
      phone,
      provider: config.provider,
      requestId: result?.requestId,
    });
    return { ok: true, provider: config.provider, requestId: result?.requestId };
  } catch (err) {
    const circuitOpen = err.code === 'CIRCUIT_OPEN';
    logger.error('[sms] 发送失败', {
      phone,
      provider: config.provider,
      error: err.message,
      code: err.code,
    });
    return {
      ok: false,
      reason: circuitOpen ? 'circuit_open' : 'send_failed',
      provider: config.provider,
    };
  }
}

/**
 * 阿里云短信（dysmsapi20170525）
 * SDK 动态 import —— 未开通短信时不加载，避免可选依赖拖累启动。
 */
async function sendViaAliyun(config, phone, code) {
  const mod = await import('@alicloud/dysmsapi20170525');
  // CJS 互操作：该包 main=dist/client.js 为 CJS，ESM import 后命名空间的
  // .default 是 module.exports，真正的 Client 构造器在 .default.default；
  // SendSmsRequest 则是顶层命名导出。用 ?? 兜底以兼容打包形态变化。
  const Client = mod.default?.default ?? mod.default;
  const SendSmsRequest = mod.SendSmsRequest ?? mod.default?.SendSmsRequest;

  // AccessKeySecret 加密落库，发送前解密（与 email_channels.password 同口径）
  const secret = toTrimmedString(decryptField(config.sms_access_key_secret));

  const client = new Client({
    accessKeyId: config.sms_access_key_id,
    accessKeySecret: secret,
    endpoint: 'dysmsapi.aliyuncs.com',
  });

  const req = new SendSmsRequest({
    phoneNumbers: phone,
    signName: config.sms_sign_name,
    templateCode: config.sms_template_code,
    templateParam: JSON.stringify({ code }),
  });

  const resp = await client.sendSms(req);
  const body = resp?.body || resp;
  // 阿里云成功码为 "OK"
  if (body?.code && body.code !== 'OK') {
    const err = new Error(`[aliyun] ${body.code}: ${body.message || ''}`);
    err.code = body.code;
    throw err;
  }
  return { requestId: body?.requestId || body?.RequestId };
}

/**
 * 腾讯云短信（tencentcloud-sdk-nodejs-sms）
 * SDK 动态 import —— 与阿里云同策略，仅在 provider=tencent 时加载。
 */
async function sendViaTencent(config, phone, code) {
  const mod = await import('tencentcloud-sdk-nodejs-sms');
  const tencentcloud = mod.default || mod;
  const SmsClient = tencentcloud.sms?.v20210111?.Client;

  const secret = toTrimmedString(decryptField(config.sms_access_key_secret));

  const client = new SmsClient({
    credential: {
      secretId: config.sms_access_key_id,
      secretKey: secret,
    },
    region: config.sms_region || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
  });

  const resp = await client.SendSms({
    SmsSdkAppId: config.sms_sdk_app_id,
    SignName: config.sms_sign_name,
    TemplateId: config.sms_template_code,
    PhoneNumberSet: [`+86${phone}`],
    TemplateParamSet: [code],
  });

  const status = resp?.SendStatusSet?.[0];
  if (status && status.Code && status.Code !== 'Ok') {
    const err = new Error(`[tencent] ${status.Code}: ${status.Message || ''}`);
    err.code = status.Code;
    throw err;
  }
  return { requestId: resp?.RequestId };
}

/** 北京时间（Asia/Shanghai）的 YYYYMMDD —— 阿里云发送记录按该时区归档 */
function beijingDateString(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * 查询短信**投递结果**（阿里云 QuerySendDetails）。
 *
 * 为什么需要它：`SendSms` 返回 `Code:OK` 只代表**阿里云受理**，真正的送达结果由运营商在
 * 回执里给出（通常几十秒到几分钟）。2026-10-07 owner 实测：管理台显示「发送成功」，
 * 但手机收不到 —— 回执里是 `sendStatus:2 / errCode:PORT_NOT_REGISTERED`（号码未注册）。
 * 把回执查询搬到管理台，运营才能区分「受理成功」与「真的送达」。
 *
 * @param {{ phone: string, sendDate?: string }} p sendDate 为 YYYYMMDD，缺省按北京时间今天
 * @returns {Promise<{ok: boolean, reason?: string, provider?: string, records?: Array}>}
 *   records 每项 { sendDate, receiveDate, sendStatus, errCode, content, templateCode }；
 *   sendStatus 语义：**1=等待回执 / 2=发送失败 / 3=发送成功**
 */
export async function querySmsDelivery({ phone, sendDate } = {}) {
  const target = toTrimmedString(phone);
  if (!target) return { ok: false, reason: 'invalid_phone' };
  const config = await getSmsConfig();
  if (!config) return { ok: false, reason: 'not_configured' };
  if (config.provider !== 'aliyun') {
    // 腾讯云的回执要另走 PullSmsSendStatus（SendStatusSet 只在同步返回里给受理结果），
    // 未实现就明确说不支持，不假装能查。
    return { ok: false, reason: 'not_supported', provider: config.provider };
  }
  const date = toTrimmedString(sendDate) || beijingDateString();
  try {
    const mod = await import('@alicloud/dysmsapi20170525');
    const Client = mod.default?.default ?? mod.default;
    const QueryReq = mod.QuerySendDetailsRequest ?? mod.default?.QuerySendDetailsRequest;
    if (typeof Client !== 'function' || typeof QueryReq !== 'function') {
      return { ok: false, reason: 'sdk_unavailable', provider: 'aliyun' };
    }
    const client = new Client({
      accessKeyId: config.sms_access_key_id,
      accessKeySecret: toTrimmedString(decryptField(config.sms_access_key_secret)),
      endpoint: 'dysmsapi.aliyuncs.com',
    });
    const resp = await client.querySendDetails(
      new QueryReq({ phoneNumber: target, sendDate: date, pageSize: 20, currentPage: 1 })
    );
    const body = resp?.body || resp;
    if (body?.code && body.code !== 'OK') {
      return {
        ok: false,
        reason: 'query_failed',
        provider: 'aliyun',
        detail: `${body.code}: ${body.message || ''}`,
      };
    }
    // ⚠️ 字段路径：SDK v4 回的是 body.smsSendDetailDTOs.smsSendDetailDTO（**不是** SmsSendDetailDTOs）
    const raw =
      body?.smsSendDetailDTOs?.smsSendDetailDTO ??
      body?.SmsSendDetailDTOs?.SmsSendDetailDTO ??
      [];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const records = list.map((it) => ({
      sendDate: it.sendDate ?? it.SendDate ?? null,
      receiveDate: it.receiveDate ?? it.ReceiveDate ?? null,
      sendStatus: Number(it.sendStatus ?? it.SendStatus ?? 0),
      errCode: it.errCode ?? it.ErrCode ?? null,
      content: it.content ?? it.Content ?? null,
      templateCode: it.templateCode ?? it.TemplateCode ?? null,
    }));
    return { ok: true, provider: 'aliyun', sendDate: date, records };
  } catch (err) {
    logger.warn('[sms] 查询投递状态失败', { error: err.message, phone: target });
    return { ok: false, reason: 'query_error', provider: 'aliyun', detail: err.message };
  }
}

/** 供自检/契约测试：当前短信是否已配置（不泄露凭据） */
export async function isSmsConfigured() {
  const config = await getSmsConfig();
  return { configured: Boolean(config), provider: config?.provider || 'console' };
}

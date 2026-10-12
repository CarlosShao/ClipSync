import crypto from 'node:crypto';
import pool from '../db/pool.js';
import { logger } from './logger.js';
import { decryptField } from './encryption.js';

/**
 * 飞书群机器人告警 —— **运行时可配置，未配置则全程 no-op**。
 *
 * 配置（迁移 091）：`system_configs.feishu_webhook_url`（**加密落库**，与 smtp_pass 同口径）
 *   → 管理台「系统参数」里填 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx` 即生效，不必重启容器。
 *   可选 `feishu_webhook_secret`：机器人开了「签名校验」时填。
 *
 * 为什么要有它：Sentry 是"事后去看"，告警是"出事就知道" ✓ ——
 *   5xx 突发、短信/邮件通道失效、支付回调异常这类事，没人盯着后台就等于没发现 ✗。
 *
 * 设计要点：
 *   - **防轰炸**：同一 key 默认 5 分钟只发一条（真实故障是"持续"的，不是"每次都通知"）✓
 *   - **绝不拖慢主流程**：调用方一律 `void sendFeishuAlert(...)`；内部 5s 超时，失败只记日志 ✓
 *   - 未配置 / URL 不是飞书域名 ⇒ 直接返回，不产生任何网络请求 ✓
 */

const CFG_TTL_MS = 5000;
const CONFIG_KEYS = ['feishu_webhook_url', 'feishu_webhook_secret'];
const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;

let cfgCache = { cfg: undefined, at: 0 };
/** 节流记录：key → 上次发送时间戳 */
const lastSentAt = new Map();

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** @returns {Promise<{webhookUrl: string, secret: string, enabled: boolean}>} */
export async function getFeishuConfig() {
  const now = Date.now();
  if (cfgCache.cfg !== undefined && now - cfgCache.at < CFG_TTL_MS) return cfgCache.cfg;

  const cfg = { webhookUrl: '', secret: '', enabled: false };
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [CONFIG_KEYS]
    );
    for (const r of rows) {
      let v = r.config_value;
      if (v && typeof v === 'object') v = v.value ?? '';
      const s = toTrimmedString(v);
      if (r.config_key === 'feishu_webhook_url') cfg.webhookUrl = s;
      else if (r.config_key === 'feishu_webhook_secret') cfg.secret = s ? toTrimmedString(decryptField(s)) : '';
    }
  } catch (err) {
    logger.warn('[feishu] 读取配置失败，按未配置处理', { error: err.message });
    return cfgCache.cfg ?? cfg;
  }
  // 只认飞书/飞书国际版 webhook（避免把 url 配错却一直静默发失败）
  cfg.enabled = /^https:\/\/open\.(feishu|larksuite)\.(cn|com)\//.test(cfg.webhookUrl);
  cfgCache = { cfg, at: now };
  return cfg;
}

export function invalidateFeishuConfigCache() {
  cfgCache = { cfg: undefined, at: 0 };
}

/**
 * 飞书「签名校验」的计算方式：把 `timestamp + "\n" + secret` 当作 **HMAC 密钥**，
 * 对空内容做 HMAC-SHA256，再 base64。这是飞书文档里的非直觉做法，实现时必须照抄 ✓
 */
export function signForFeishu(secret, timestampSec) {
  const stringToSign = `${timestampSec}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

/**
 * 发一条告警（调用方请用 `void sendFeishuAlert(...)`，不要 await 进主链路）。
 *
 * @param {object} opts
 * @param {string} opts.key        节流键（同类告警共用一个键，如 'http_5xx' / 'sms_send_failed'）
 * @param {string} opts.title      标题（一句话说清"哪里坏了"）
 * @param {string[]} [opts.lines]  明细（每行一条）
 * @param {number} [opts.throttleMs] 覆盖默认节流窗口（测试用）
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendFeishuAlert({ key = 'generic', title, lines, throttleMs } = {}) {
  const cfg = await getFeishuConfig();
  if (!cfg.enabled) return { ok: false, reason: 'not_configured' };

  const window = Number(throttleMs) > 0 ? Number(throttleMs) : DEFAULT_THROTTLE_MS;
  if (typeof throttleMs === 'number' && throttleMs <= 0) {
    // 显式传 0/负数 = 跳过节流（仅测试与手工触发用）
  } else {
    const now = Date.now();
    const last = lastSentAt.get(key) || 0;
    if (now - last < window) return { ok: false, reason: 'throttled' };
    lastSentAt.set(key, now);
  }

  const text = [`【ClipSync 告警】${toTrimmedString(title) || '(无标题)'}`, ...(Array.isArray(lines) ? lines : [])]
    .filter(Boolean)
    .join('\n');

  try {
    const body = { msg_type: 'text', content: { text } };
    if (cfg.secret) {
      const ts = Math.floor(Date.now() / 1000);
      body.timestamp = String(ts);
      body.sign = signForFeishu(cfg.secret, ts);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        logger.warn('[feishu] 告警发送失败', { status: resp.status, key });
        return { ok: false, reason: `http_${resp.status}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn('[feishu] 告警发送异常', { error: err.message, key });
    return { ok: false, reason: 'network_error' };
  }
}

/** 供运维页/健康检查展示"告警通道是否可用" */
export async function isFeishuEnabled() {
  const cfg = await getFeishuConfig();
  return cfg.enabled;
}

/** 测试/运维用：清空节流记录 */
export function resetFeishuThrottle() {
  lastSentAt.clear();
}

import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { logger } from './logger.js';
import { circuitBreakers } from './circuit-breaker.js';
import { decryptField } from './encryption.js';

// =============================================
// 邮件发送（CO-30 SMTP 配置化）
//
// SMTP 配置来源：system_configs 的 smtp_host / smtp_port / smtp_user /
// smtp_pass / smtp_from / smtp_secure（050 迁移；管理台经
// PATCH /api/admin/configs/smtp_* 维护，smtp_pass 由 configs.js 加密落库）。
//
// 读取策略：发送前实时读取 + 进程内 5s TTL 缓存——管理台改完 SMTP 配置
// 最迟 5s 生效；读库失败时沿用最近一次成功快照，无快照则走 console 兜底。
// smtp_host 为空 = 未配置，维持既有 console 兜底（不真实发送，不报错）。
// =============================================

const SMTP_TTL_MS = 5000;
const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];

// { config: object|null, at: number } —— config 为 null 表示「已读库但未配置」
let smtpCache = { config: undefined, at: 0 };
let transporter = null;
let transporterKey = '';

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function toBool(v) {
  return v === true || v === 'true' || v === 't' || v === 1 || v === '1';
}

/** 读取 system_configs 的 smtp_*（5s 进程内缓存）；无配置/读库失败返回 null */
async function getSmtpConfig() {
  const now = Date.now();
  if (smtpCache.config !== undefined && now - smtpCache.at < SMTP_TTL_MS) {
    return smtpCache.config;
  }
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)`,
      [SMTP_KEYS]
    );
    const raw = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));
    const cfg = {
      host: toTrimmedString(raw.smtp_host),
      port: parseInt(toTrimmedString(raw.smtp_port), 10) || 587,
      user: toTrimmedString(raw.smtp_user),
      // smtp_pass 由 configs.js 加密写入（AES-256-GCM），发送前解密；解密失败按未配置处理
      pass: raw.smtp_pass ? decryptField(toTrimmedString(raw.smtp_pass)) || '' : '',
      from: toTrimmedString(raw.smtp_from),
      secure: toBool(raw.smtp_secure),
    };
    const resolved = cfg.host ? cfg : null;
    smtpCache = { config: resolved, at: now };
    return resolved;
  } catch (err) {
    logger.warn('[email] failed to read SMTP config, reusing last snapshot / console fallback', {
      error: err.message,
    });
    // 读库失败：沿用上次快照（含「未配置」），从未读到过则走 console 兜底
    return smtpCache.config ?? null;
  }
}

/**
 * 获取（或按当前配置重建）邮件发送器；SMTP 未配置返回 null（console 兜底）
 */
async function getTransporter() {
  const emailConfig = await getSmtpConfig();

  if (!emailConfig || !emailConfig.host || !emailConfig.user || !emailConfig.pass) {
    if (emailConfig && (!emailConfig.user || !emailConfig.pass)) {
      logger.warn('Email configuration incomplete (host set but user/pass missing), using console fallback');
    }
    return null;
  }

  // 配置变更时重建 transporter（缓存 key 含全部连接参数，含解密后的凭据）
  const key = [emailConfig.host, emailConfig.port, emailConfig.secure, emailConfig.user, emailConfig.pass].join('|');
  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure || emailConfig.port === 465,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
    });
    transporterKey = key;
    logger.info('SMTP transporter created', { host: emailConfig.host, port: emailConfig.port });
  }

  return transporter;
}

/**
 * 发送邮件（带断路器保护）
 * @param {Object} options - 邮件选项
 * @param {string} options.to - 收件人
 * @param {string} options.subject - 主题
 * @param {string} options.text - 纯文本内容
 * @param {string} options.html - HTML内容
 * @returns {Promise<Object>} 发送结果
 */
export async function sendEmail(options) {
  const { to, subject, text, html } = options;

  const transporter = await getTransporter();

  if (!transporter) {
    // Fallback: 输出到控制台
    logger.info('Email fallback (console):', {
      to,
      subject,
      text: text?.substring(0, 100) + '...'
    });
    return { success: true, fallback: true };
  }

  const smtpConfig = await getSmtpConfig();
  const fromAddress = smtpConfig?.from || smtpConfig?.user;

  // 使用断路器保护
  try {
    const result = await circuitBreakers.email.execute(async () => {
      const mailOptions = {
        from: `"ClipSync" <${fromAddress}>`,
        to,
        subject,
        text,
        html: html || text
      };

      return await transporter.sendMail(mailOptions);
    });

    logger.info('Email sent successfully', { messageId: result.messageId, to });
    return { success: true, messageId: result.messageId };
  } catch (err) {
    // 断路器打开时，错误码为 CIRCUIT_OPEN
    if (err.code === 'CIRCUIT_OPEN') {
      logger.warn('Email sending skipped: circuit breaker is OPEN', { to, subject });
      return { success: false, error: 'Circuit breaker OPEN', circuitOpen: true };
    }

    logger.error('Failed to send email', { error: err.message, to });
    return { success: false, error: err.message };
  }
}

/**
 * 发送 SMTP 测试邮件（CO-30 管理台「发送测试邮件」POST /api/admin/configs/smtp/test）
 * @param {string} to - 收件人邮箱
 * @returns {Promise<Object>} { success, unconfigured?, messageId?, error?, circuitOpen? }
 *   unconfigured:true 表示 SMTP 未配置/不完整（getTransporter 走 console 兜底）——
 *   调用方（configs.js）应返回业务错误 4090，不能把 console 兜底当作「发送成功」。
 */
export async function sendTestMail(to) {
  const transporterInstance = await getTransporter();
  if (!transporterInstance) {
    return { success: false, unconfigured: true };
  }
  const result = await sendEmail({
    to,
    subject: 'ClipSync SMTP 测试',
    text: '这是一封 ClipSync SMTP 测试邮件。收到即说明当前 SMTP 配置正确。',
    html: '<p>这是一封 <strong>ClipSync SMTP 测试邮件</strong>。收到即说明当前 SMTP 配置正确。</p>',
  });
  return { ...result, unconfigured: false };
}

/**
 * 发送验证码邮件
 * @param {string} to - 收件人邮箱
 * @param {string} code - 验证码
 * @param {string} purpose - 用途（login/reset/delete）
 */
export async function sendVerificationCodeEmail(to, code, purpose = 'login') {
  const purposeText = {
    login: '登录',
    reset: '重置密码',
    delete: '删除账户'
  };

  const subject = `ClipSync - ${purposeText[purpose] || '验证码'}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .code { background: #fff; border: 2px dashed #667eea; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; color: #667eea; margin: 20px 0; border-radius: 5px; letter-spacing: 5px; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔐 ClipSync</h1>
          <p>${purposeText[purpose] || '验证码'}</p>
        </div>
        <div class="content">
          <p>您好，</p>
          <p>您的验证码是：</p>
          <div class="code">${code}</div>
          <p>此验证码将在 <strong>10 分钟</strong>内有效。</p>
          <div class="warning">
            <strong>安全提示：</strong>请勿将此验证码分享给任何人。ClipSync 工作人员不会向您索要此验证码。
          </div>
        </div>
        <div class="footer">
          <p>此邮件由 ClipSync 系统自动发送，请勿回复。</p>
          <p>© ${new Date().getFullYear()} ClipSync. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject,
    text: `您的 ClipSync 验证码是：${code}，有效期 10 分钟。`,
    html
  });
}

/**
 * 发送账户删除确认邮件
 * @param {string} to - 收件人邮箱
 * @param {string} nickname - 用户昵称
 */
export async function sendAccountDeletionEmail(to, nickname) {
  const subject = 'ClipSync - 账户删除确认';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #dc3545; color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🗑️ ClipSync</h1>
          <p>账户删除确认</p>
        </div>
        <div class="content">
          <p>您好 ${nickname}，</p>
          <p>您的 ClipSync 账户已被删除。</p>
          <p><strong>已删除的数据：</strong></p>
          <ul>
            <li>个人资料信息</li>
            <li>所有剪贴板历史记录</li>
            <li>设备绑定信息</li>
            <li>订阅和支付记录（保留法定期限）</li>
          </ul>
          <p>如果您没有执行此操作，请立即联系我们的支持团队。</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} ClipSync. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject,
    text: `您好 ${nickname}，您的 ClipSync 账户已被删除。`,
    html
  });
}

export default {
  sendEmail,
  sendVerificationCodeEmail,
  sendAccountDeletionEmail
};

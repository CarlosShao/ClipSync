import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { logger } from './logger.js';
import { circuitBreakers } from './circuit-breaker.js';
import { decryptField } from './encryption.js';

// =============================================
// 邮件发送（CO-30 SMTP 配置化 → AN-16 邮件多通道，方案 A）
//
// 通道来源（AN-16）：email_channels 表（059 迁移）——多 SMTP 账号 +
// 按用途（transactional/marketing）路由 + priority 优先级 failover。
//
// 选通道逻辑（sendEmail）：
//   - options.channelId 指定通道（管理台「发送测试邮件」用，不降级）
//   - 否则按 options.purpose（缺省 transactional）选 enabled 的该用途通道中
//     priority 最小者；发送失败按 priority 顺延降级重试下一个（最多 2 次降级）
//   - email_channels 无可用通道时，回退 system_configs smtp_*（050 迁移；
//     057 已导入为「默认事务通道」，此兜底仅为迁移未跑/空表时维持兼容，
//     只读兼容一个版本后废弃）
//
// 读取策略：通道列表进程内 5s TTL 缓存——管理台改完通道配置最迟 5s 生效；
// 读库失败沿用最近一次成功快照，无快照则走 console 兜底。
//
// transporter 缓存（AN-16）：按 channelId 维度 Map<channelId, {transporter, key}>，
// key 含全部连接参数（含解密后凭据）+ updated_at——通道配置变更即失效重建。
// smtp_host 为空 / 通道配置不完整 = 走 console 兜底（不真实发送，不报错）。
// =============================================

const SMTP_TTL_MS = 5000;
const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];

// AN-16：目的用途白名单（与 email_channels.purpose CHECK 约束一致）
const PURPOSES = new Set(['transactional', 'marketing']);
// AN-16：主通道之外的最大降级重试次数
const MAX_FAILOVER = 2;

// { config: object|null, at: number } —— config 为 null 表示「已读库但未配置」（legacy smtp_*）
let smtpCache = { config: undefined, at: 0 };

// AN-16：通道列表缓存 Map<purpose, { list: Channel[], at: number }>
const channelsCache = new Map();

// AN-16：transporter 按 channelId 缓存 Map<channelId, { transporter, key }>
const transporters = new Map();

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function toBool(v) {
  return v === true || v === 'true' || v === 't' || v === 1 || v === '1';
}

/**
 * 【legacy 兜底】读取 system_configs 的 smtp_*（5s 进程内缓存）；无配置/读库失败返回 null
 * AN-16：仅在 email_channels 无可用通道时使用（迁移未跑/空表场景）
 */
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

/** 【legacy 兜底】smtp_* 配置 → 伪通道对象（与 email_channels 行同构，id 用固定哨兵值） */
function legacyConfigToChannel(cfg) {
  return {
    id: 'legacy-smtp-config',
    name: 'legacy-smtp',
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.user,
    // 与 email_channels 不同：这里已是解密后明文（getTransporter 不再解密即用）
    password: cfg.pass,
    from_addr: cfg.from,
  };
}

/**
 * AN-16 读取指定用途的启用通道列表（priority 升序，5s TTL 缓存；读库失败沿用最近快照）
 * @param {string} purpose 'transactional' | 'marketing'
 * @returns {Promise<Array>}
 */
async function getEnabledChannels(purpose) {
  const now = Date.now();
  const cached = channelsCache.get(purpose);
  if (cached && now - cached.at < SMTP_TTL_MS) {
    return cached.list;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, purpose, host, port, secure, username, password, from_addr, updated_at
       FROM email_channels
       WHERE enabled = TRUE AND purpose = $1
       ORDER BY priority ASC, created_at ASC`,
      [purpose]
    );
    channelsCache.set(purpose, { list: rows, at: now });
    return rows;
  } catch (err) {
    logger.warn('[email] failed to read email_channels, reusing last snapshot', {
      purpose,
      error: err.message,
    });
    return cached?.list ?? [];
  }
}

/**
 * AN-16 按 id 精确读取通道（管理台「发送测试邮件」用；不要求 enabled——
 * 允许先测试再启用；读库失败返回 null 走 console 兜底）
 */
async function getChannelById(channelId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, purpose, host, port, secure, username, password, from_addr, updated_at
       FROM email_channels WHERE id = $1`,
      [channelId]
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn('[email] failed to read email channel by id', {
      channelId,
      error: err.message,
    });
    return null;
  }
}

/**
 * AN-16 解析本次发送的通道候选列表（有序）：
 *   - channelId 指定 → 单候选（不降级）
 *   - purpose 路由 → priority 升序全部候选（发送时最多尝试 1 + MAX_FAILOVER 个）
 *   - 无候选 → legacy smtp_* 兜底（单候选）
 */
async function getChannelCandidates(channelId, purpose) {
  if (channelId) {
    const channel = await getChannelById(channelId);
    return channel ? [channel] : [];
  }
  const purposeKey = PURPOSES.has(purpose) ? purpose : 'transactional';
  const channels = await getEnabledChannels(purposeKey);
  if (channels.length > 0) {
    return channels;
  }
  // AN-16 兜底：email_channels 无可用通道 → legacy system_configs smtp_*
  const legacy = await getSmtpConfig();
  return legacy ? [legacyConfigToChannel(legacy)] : [];
}

/** AN-16 通道连接凭据是否完整（不完整走 console 兜底，与 legacy 行为一致） */
function isChannelComplete(channel) {
  if (!channel.host) return false;
  return Boolean(channel.username && channel.password);
}

/**
 * AN-16 获取（或按当前配置重建）指定通道的邮件发送器。
 * 缓存 key 含全部连接参数（含解密后凭据）+ updated_at——管理台改通道配置即失效重建；
 * 密码为 email_channels 存的密文（legacy 伪通道除外，已是明文），发送前解密。
 */
async function getTransporterForChannel(channel) {
  const pass = toTrimmedString(channel.password);
  // 配置变更时重建 transporter（缓存 key 含全部连接参数 + updated_at）
  const key = [
    channel.host,
    channel.port,
    channel.secure,
    channel.username,
    pass,
    channel.updated_at ? new Date(channel.updated_at).toISOString() : '',
  ].join('|');

  const cached = transporters.get(channel.id);
  if (cached && cached.key === key) {
    return cached.transporter;
  }

  const transporter = nodemailer.createTransport({
    host: channel.host,
    port: channel.port,
    secure: channel.secure || channel.port === 465,
    auth: {
      user: channel.username,
      pass,
    },
  });
  transporters.set(channel.id, { transporter, key });
  logger.info('SMTP transporter created (channel)', {
    channelId: channel.id,
    channelName: channel.name,
    host: channel.host,
    port: channel.port,
  });
  return transporter;
}

/**
 * 发送邮件（带断路器保护 + AN-16 多通道 failover）
 * @param {Object} options - 邮件选项
 * @param {string} options.to - 收件人
 * @param {string} options.subject - 主题
 * @param {string} options.text - 纯文本内容
 * @param {string} options.html - HTML内容
 * @param {string} [options.channelId] - AN-16 指定通道 id（管理台测试发送；不降级）
 * @param {string} [options.purpose] - AN-16 用途路由（transactional/marketing，缺省 transactional）
 * @returns {Promise<Object>} 发送结果
 */
export async function sendEmail(options) {
  const { to, subject, text, html, channelId, purpose = 'transactional' } = options;

  const candidates = await getChannelCandidates(channelId, purpose);

  // 无候选通道 / 全部候选凭据不完整 → console 兜底（维持既有「不报错」行为）
  const usable = candidates.filter(isChannelComplete);
  if (usable.length === 0) {
    if (candidates.length > 0) {
      logger.warn('Email channel configuration incomplete (host set but user/pass missing), using console fallback', {
        channelIds: candidates.map((c) => c.id),
      });
    }
    logger.info('Email fallback (console):', {
      to,
      subject,
      text: text?.substring(0, 100) + '...',
    });
    return { success: true, fallback: true };
  }

  // AN-16：显式 channelId 只有 1 个候选；purpose 路由最多尝试 主通道 + MAX_FAILOVER 次降级
  const attempts = channelId ? usable.slice(0, 1) : usable.slice(0, 1 + MAX_FAILOVER);
  let lastError = null;

  for (const channel of attempts) {
    let transporter;
    try {
      transporter = await getTransporterForChannel(channel);
    } catch (err) {
      logger.error('Failed to create transporter for channel, trying next', {
        channelId: channel.id,
        error: err.message,
      });
      lastError = err;
      continue;
    }

    const fromAddress = toTrimmedString(channel.from_addr) || channel.username;

    // 使用断路器保护
    try {
      const result = await circuitBreakers.email.execute(async () => {
        const mailOptions = {
          from: `"ClipSync" <${fromAddress}>`,
          to,
          subject,
          text,
          html: html || text,
        };
        return await transporter.sendMail(mailOptions);
      });

      logger.info('Email sent successfully', {
        messageId: result.messageId,
        to,
        channelId: channel.id,
        channelName: channel.name,
      });
      return {
        success: true,
        messageId: result.messageId,
        channelId: channel.id,
        channelName: channel.name,
      };
    } catch (err) {
      // 断路器打开时，错误码为 CIRCUIT_OPEN（不降级——熔断是全站邮件保护，直接返回）
      if (err.code === 'CIRCUIT_OPEN') {
        logger.warn('Email sending skipped: circuit breaker is OPEN', { to, subject });
        return { success: false, error: 'Circuit breaker OPEN', circuitOpen: true };
      }
      lastError = err;
      logger.error('Failed to send email via channel, trying next by priority', {
        channelId: channel.id,
        channelName: channel.name,
        error: err.message,
        to,
      });
    }
  }

  return { success: false, error: lastError?.message || 'Unknown error' };
}

/**
 * 发送 SMTP 测试邮件（CO-30 管理台「发送测试邮件」POST /api/admin/configs/smtp/test；
 * AN-16 扩展：可指定通道 id——POST /api/admin/email-channels/:id/test）
 * @param {string} to - 收件人邮箱
 * @param {string|null} [channelId] - AN-16 指定通道；缺省走 transactional 路由（含 legacy 兜底）
 * @returns {Promise<Object>} { success, unconfigured?, messageId?, error?, circuitOpen?, channelId? }
 *   unconfigured:true 表示 SMTP 未配置/不完整（走 console 兜底）——
 *   调用方（configs.js / emailChannels.js）应返回业务错误 4090，不能把 console 兜底当作「发送成功」。
 */
export async function sendTestMail(to, channelId = null) {
  const candidates = await getChannelCandidates(channelId, 'transactional');
  const usable = candidates.filter(isChannelComplete);
  if (usable.length === 0) {
    return { success: false, unconfigured: true };
  }
  const result = await sendEmail({
    to,
    channelId: channelId || undefined,
    subject: 'ClipSync SMTP 测试',
    text: channelId
      ? `这是一封 ClipSync SMTP 测试邮件。收到即说明该邮件通道配置正确。`
      : '这是一封 ClipSync SMTP 测试邮件。收到即说明当前 SMTP 配置正确。',
    html: channelId
      ? '<p>这是一封 <strong>ClipSync SMTP 测试邮件</strong>。收到即说明该邮件通道配置正确。</p>'
      : '<p>这是一封 <strong>ClipSync SMTP 测试邮件</strong>。收到即说明当前 SMTP 配置正确。</p>',
  });
  return { ...result, unconfigured: false };
}

/**
 * 发送验证码邮件（AN-16：缺省走 transactional 用途路由，主通道失败自动降级备用通道）
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
    html,
    // AN-16：验证码属事务邮件，按 transactional 用途路由（缺省值，显式声明以便阅读）
    purpose: 'transactional'
  });
}

/**
 * 发送账户删除确认邮件（AN-16：缺省走 transactional 用途路由）
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
    html,
    // AN-16：账户删除通知属事务邮件，按 transactional 用途路由
    purpose: 'transactional'
  });
}

export default {
  sendEmail,
  sendVerificationCodeEmail,
  sendAccountDeletionEmail
};

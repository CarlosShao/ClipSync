import nodemailer from 'nodemailer';
import config from '../config.js';
import { logger } from './logger.js';
import { circuitBreakers } from './circuit-breaker.js';

// 邮件发送器
let transporter = null;

/**
 * 初始化邮件发送器
 */
function getTransporter() {
  if (transporter) {
    return transporter;
  }

  const emailConfig = config.email || {};

  if (!emailConfig.host || !emailConfig.user || !emailConfig.pass) {
    logger.warn('Email configuration missing, using console fallback');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port || 587,
    secure: emailConfig.port === 465,
    auth: {
      user: emailConfig.user,
      pass: emailConfig.pass
    }
  });

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

  const transporter = getTransporter();

  if (!transporter) {
    // Fallback: 输出到控制台
    logger.info('Email fallback (console):', {
      to,
      subject,
      text: text?.substring(0, 100) + '...'
    });
    return { success: true, fallback: true };
  }

  // 使用断路器保护
  try {
    const result = await circuitBreakers.email.execute(async () => {
      const mailOptions = {
        from: `"ClipSync" <${config.email.user}>`,
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

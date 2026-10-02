import { sendEmail } from './email.js';
import { logger } from './logger.js';

/**
 * 反馈工单邮件（应用内工单 → 企业邮箱）
 *
 * 复用既有邮件基础设施 utils/email.js 的 sendEmail：
 *   - 通道选择 / 多通道 failover / 断路器 / legacy smtp_* 兜底全部现成；
 *   - 本模块只负责「把工单渲染成一封事务邮件」这一件事，不新引任何依赖。
 *
 * 收件人：环境变量 FEEDBACK_TO（见 .env.example），未配置时用企业邮箱默认值。
 *   收件地址是**配置**不是密钥，因此默认值可以写进代码；SMTP 凭据仍然只存在于
 *   email_channels / system_configs（管理台配置），本文件不碰任何口令。
 *
 * 诚实性约定（调用方 routes/feedback.js 依赖）：
 *   sendEmail 在「通道未配置」时会走 console 兜底并返回 { success: true, fallback: true }，
 *   那**不是**真实投递。本模块把它翻译成 { success: false, error: 'smtp_unconfigured' }，
 *   由调用方落成 email_sent=false —— 库里绝不出现"已发送"的假结论。
 */

/** 企业邮箱默认收件地址（FEEDBACK_TO 可覆盖） */
export const DEFAULT_FEEDBACK_TO = 'swqcarlos@clipchain.top';

/** 工单分类 → 邮件中展示的中文标签（与 routes/feedback.js 的白名单一一对应） */
const CATEGORY_LABELS = {
  feature: '功能建议',
  bug: '问题反馈',
  performance: '性能',
  ui: '界面',
  other: '其它',
};

/** 解析收件人：环境变量优先，空值回落默认企业邮箱 */
export function resolveFeedbackRecipient() {
  const fromEnv = typeof process.env.FEEDBACK_TO === 'string' ? process.env.FEEDBACK_TO.trim() : '';
  return fromEnv || DEFAULT_FEEDBACK_TO;
}

/** HTML 正文里用户输入的最小转义（不转义 '/'，保证 URL 可读） */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function newlineToBr(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** 单行字段：去掉换行，避免破坏邮件头部/表格布局 */
function oneLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 渲染并把工单发给企业邮箱。
 * @param {object} params
 * @param {object} params.ticket 已入库的工单（id/title/category/content/contact/app_version/platform/created_at）
 * @param {object|null} params.user 提交人（id/email/phone/nickname），可为 null
 * @returns {Promise<{ success: boolean, to: string, messageId?: string, error?: string }>}
 *   永不抛出：内部把 sendEmail 的异常也收敛成 { success: false, error }。
 */
export async function sendFeedbackEmail({ ticket, user }) {
  const to = resolveFeedbackRecipient();
  const category = ticket?.category || 'other';
  const categoryLabel = CATEGORY_LABELS[category] || category;
  const title = oneLine(ticket?.title);
  const contact = oneLine(ticket?.contact) || '（未填写）';
  const appVersion = oneLine(ticket?.app_version) || '未知';
  const platform = oneLine(ticket?.platform) || '未知';
  const createdAt = ticket?.created_at
    ? new Date(ticket.created_at).toISOString()
    : new Date().toISOString();

  // 提交人身份：邮箱 / 手机 / 用户 ID 三选多给，方便回访时不丢线索
  const submitter = [
    user?.email ? `邮箱：${oneLine(user.email)}` : '邮箱：未绑定',
    user?.phone ? `手机：${oneLine(user.phone)}` : '手机：未绑定',
    user?.nickname ? `昵称：${oneLine(user.nickname)}` : null,
    `用户 ID：${ticket?.user_id || (user?.id ?? '未知')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const subject = `[ClipSync 反馈] ${categoryLabel} · ${title.slice(0, 60)}`;

  const text = [
    '收到一条新的 ClipSync 应用内反馈：',
    '',
    `工单号：${ticket?.id}`,
    `标题：${title}`,
    `分类：${categoryLabel}（${category}）`,
    `联系方式：${contact}`,
    `客户端版本：${appVersion}`,
    `平台：${platform}`,
    `提交时间：${createdAt}`,
    '',
    '提交用户：',
    submitter,
    '',
    '正文：',
    ticket?.content || '',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.65;color:#333;max-width:640px">
      <h2 style="margin:0 0 4px;font-size:17px">新的 ClipSync 应用内反馈</h2>
      <p style="margin:0 0 16px;color:#888;font-size:13px">工单号 ${escapeHtml(ticket?.id)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr><td style="padding:6px 10px;background:#f6f6f6;width:110px">标题</td><td style="padding:6px 10px">${escapeHtml(title)}</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6">分类</td><td style="padding:6px 10px">${escapeHtml(categoryLabel)}（${escapeHtml(category)}）</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6">联系方式</td><td style="padding:6px 10px">${escapeHtml(contact)}</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6">客户端版本</td><td style="padding:6px 10px">${escapeHtml(appVersion)}</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6">平台</td><td style="padding:6px 10px">${escapeHtml(platform)}</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6">提交时间</td><td style="padding:6px 10px">${escapeHtml(createdAt)}</td></tr>
        <tr><td style="padding:6px 10px;background:#f6f6f6;vertical-align:top">提交用户</td><td style="padding:6px 10px">${newlineToBr(submitter)}</td></tr>
      </table>
      <h3 style="margin:18px 0 6px;font-size:14px">正文</h3>
      <div style="white-space:normal;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:12px;font-size:13px">${newlineToBr(ticket?.content)}</div>
      <p style="margin-top:18px;color:#888;font-size:12px">此邮件由 ClipSync 服务端自动发送。</p>
    </div>
  `;

  try {
    const result = await sendEmail({ to, subject, text, html, purpose: 'transactional' });
    // console 兜底（SMTP 未配置）不是真实投递 → 如实记为失败，避免库里留下假结论
    if (result?.fallback) {
      logger.warn('[feedback] SMTP 未配置，工单仅入库未发信', { ticketId: ticket?.id, to });
      return { success: false, to, error: 'smtp_unconfigured' };
    }
    if (!result?.success) {
      return { success: false, to, error: result?.error || 'send_failed' };
    }
    return { success: true, to, messageId: result.messageId };
  } catch (err) {
    logger.error('[feedback] 反馈邮件发送异常（不影响工单入库）', {
      ticketId: ticket?.id,
      to,
      error: err?.message,
    });
    return { success: false, to, error: err?.message || 'send_exception' };
  }
}

export default { sendFeedbackEmail, resolveFeedbackRecipient, DEFAULT_FEEDBACK_TO };

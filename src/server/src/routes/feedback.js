/**
 * 应用内反馈工单（桌面端「设置 → 关于 ClipSync → 发送反馈」）
 *
 * POST /api/feedback
 *   请求体：{ title, category, content, contact?, appVersion?, platform? }
 *   成功  ：200 { ok: true, id, status, createdAt, emailSent }
 *   校验失败：400 { error, code }
 *   未认证  ：401（由 authenticateToken 返回）
 *
 * 两个不可让步的语义（与迁移 079 的注释一致）：
 *   1. **落库为主**：INSERT 成功即接口成功，用户绝不会因为 SMTP 出问题而丢反馈；
 *   2. **发信尽力而为**：把结果写回本行 email_sent / email_error，
 *      未真实投递（含 SMTP 未配置的 console 兜底）一律 email_sent=false，
 *      不在库里留"已发送"的假结论。
 *
 * 鉴权/CSRF/公共限流在 index.js 的挂载点统一处理（照 /api/ai/settings 的组合）；
 * 本文件只额外挂一条**工单专用**限流（feedbackLimiter）防刷。
 */

import { Router } from 'express';
import pool from '../db/pool.js';
import { feedbackLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { sendFeedbackEmail } from '../utils/feedbackMailer.js';

const router = Router();

/** 分类白名单：必须与迁移 079 的 CHECK 约束、桌面端 FEEDBACK_CATEGORIES 三处一致 */
export const FEEDBACK_CATEGORIES = ['feature', 'bug', 'performance', 'ui', 'other'];

const TITLE_MAX = 200;
const CONTENT_MAX = 5000;
const CONTACT_MAX = 200;
/** 客户端版本 / 平台是附带信息，超长直接截断（不值得让用户提交失败） */
const META_MAX = 50;
const EMAIL_ERROR_MAX = 500;

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 400 响应：同时给人类可读 message 与稳定的机器码（桌面端本地校验只是前置，不能替代这里） */
function badRequest(res, code, error) {
  return res.status(400).json({ error, code });
}

router.post('/', feedbackLimiter, async (req, res) => {
  const body = req.body || {};

  const title = str(body.title).trim();
  const content = str(body.content).trim();
  const rawCategory = str(body.category).trim();
  const category = rawCategory || 'other';
  const contact = str(body.contact).trim();
  const appVersion = str(body.appVersion).trim().slice(0, META_MAX);
  const platform = str(body.platform).trim().slice(0, META_MAX);

  if (!title) {
    return badRequest(res, 'FEEDBACK_TITLE_REQUIRED', 'Title is required');
  }
  if (title.length > TITLE_MAX) {
    return badRequest(res, 'FEEDBACK_TITLE_TOO_LONG', `Title must be at most ${TITLE_MAX} characters`);
  }
  if (!content) {
    return badRequest(res, 'FEEDBACK_CONTENT_REQUIRED', 'Content is required');
  }
  if (content.length > CONTENT_MAX) {
    return badRequest(res, 'FEEDBACK_CONTENT_TOO_LONG', `Content must be at most ${CONTENT_MAX} characters`);
  }
  if (rawCategory && !FEEDBACK_CATEGORIES.includes(rawCategory)) {
    return badRequest(res, 'FEEDBACK_CATEGORY_INVALID', 'Invalid category');
  }
  if (contact.length > CONTACT_MAX) {
    return badRequest(res, 'FEEDBACK_CONTACT_TOO_LONG', `Contact must be at most ${CONTACT_MAX} characters`);
  }

  const userId = req.userId || req.user?.userId || null;

  let ticket;
  try {
    const inserted = await pool.query(
      `INSERT INTO feedback_tickets (user_id, title, category, content, contact, app_version, platform)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, title, category, content, contact, app_version, platform,
                 status, email_sent, created_at`,
      [userId, title, category, content, contact || null, appVersion || null, platform || null]
    );
    ticket = inserted.rows[0];
  } catch (err) {
    logger.error('[feedback] 工单入库失败', { error: err.message, userId, category });
    return res.status(500).json({ error: 'Failed to submit feedback', code: 'FEEDBACK_STORE_FAILED' });
  }

  // ===== 以下全部是「尽力而为」：任何异常都不得影响上面那次成功入库的结果 =====

  // 提交人信息用于邮件回访（查不到就只带用户 ID，不阻断）
  let submitter = null;
  try {
    const r = await pool.query('SELECT id, email, phone, nickname FROM users WHERE id = $1', [userId]);
    submitter = r.rows[0] || null;
  } catch (err) {
    logger.warn('[feedback] 读取提交人信息失败（邮件退化为仅用户 ID）', {
      error: err.message,
      userId,
    });
  }

  let emailSent = false;
  let emailError = null;
  try {
    const mail = await sendFeedbackEmail({ ticket, user: submitter });
    emailSent = !!mail?.success;
    if (!emailSent) emailError = mail?.error || 'send_failed';
  } catch (err) {
    // sendFeedbackEmail 自身已收敛异常，这里是最后一道保险
    emailError = err?.message || 'send_exception';
  }

  try {
    await pool.query('UPDATE feedback_tickets SET email_sent = $2, email_error = $3 WHERE id = $1', [
      ticket.id,
      emailSent,
      emailError ? String(emailError).slice(0, EMAIL_ERROR_MAX) : null,
    ]);
  } catch (err) {
    logger.error('[feedback] 发信结果回写失败（工单仍在库）', { error: err.message, ticketId: ticket.id });
  }

  logger.info('[feedback] 收到新的应用内反馈', {
    ticketId: ticket.id,
    userId,
    category,
    emailSent,
  });

  return res.json({
    ok: true,
    id: ticket.id,
    status: ticket.status,
    createdAt: ticket.created_at,
    emailSent,
  });
});

export default router;

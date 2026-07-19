import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { authenticateToken } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

const router = Router();

// 受保护路由：需要先登录（Bearer JWT）
const protect = [authenticateToken, csrfProtection, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}];

const MAX_CONTENT = 5_000_000; // 分享内容上限 ~5MB
const MAX_TITLE = 200;
const MAX_TYPE = 50;
const TOKEN_BYTES = 10; // → 20 hex chars

function getRequestOrigin(req) {
  // 优先使用前端真实 origin（含协议和端口），nginx 反向代理时通常透传
  const origin = req.get('origin');
  if (origin) return origin;
  // 否则从 Host 头推导；注意 req.protocol 在 nginx 后可能是 http，可配 X-Forwarded-Proto
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

function buildShareUrl(req, token) {
  // 生产环境可配置干净的短域名，如 https://clipsync.example.com/s/
  const configuredBase = process.env.SHARE_LINK_BASE_URL;
  if (configuredBase) return configuredBase + token;
  // 默认使用本机服务地址 + 公开端点路径
  return `${getRequestOrigin(req)}/api/shared-links/public/${token}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSharePage({ title, content, contentType, views, createdAt }) {
  const safeTitle = escapeHtml(title || 'ClipSync Share');
  const safeContent = escapeHtml(content);
  let body = '';
  if (contentType === 'image' && content.startsWith('data:image')) {
    body = `<img src="${escapeHtml(content)}" alt="shared image" style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08);">`;
  } else if (contentType === 'link') {
    body = `<a href="${escapeHtml(content)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all;color:#2563eb;">${safeContent}</a>`;
  } else {
    body = `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;line-height:1.6;color:#1f2937;background:#f9fafb;padding:16px;border-radius:8px;border:1px solid #e5e7eb;">${safeContent}</pre>`;
  }
  const meta = [
    views !== undefined ? `${views} view${views === 1 ? '' : 's'}` : '',
    createdAt ? `Created ${new Date(createdAt).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; background: #ffffff; color: #111827; }
    .wrap { max-width: 720px; margin: 48px auto; padding: 0 24px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
    header svg { width: 28px; height: 28px; }
    header h1 { font-size: 20px; font-weight: 600; margin: 0; }
    .title { font-size: 18px; font-weight: 500; margin-bottom: 16px; color: #111827; }
    .content { margin-bottom: 16px; }
    .meta { font-size: 13px; color: #6b7280; }
    footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 13px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      <h1>ClipSync</h1>
    </header>
    ${title ? `<div class="title">${safeTitle}</div>` : ''}
    <div class="content">${body}</div>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
    <footer>Shared securely with ClipSync · <a href="/" style="color:#6b7280;">clipsync.io</a></footer>
  </div>
</body>
</html>`;
}

// POST /api/shared-links — 创建一条分享链接（内容 at-rest 加密）
router.post('/', ...protect, apiLimiter, async (req, res) => {
  try {
    const { content, title, contentType, expiresInHours } = req.body || {};
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > MAX_CONTENT) {
      return res.status(413).json({ error: 'content too large' });
    }
    const safeTitle = typeof title === 'string' ? title.slice(0, MAX_TITLE) : null;
    const safeType = typeof contentType === 'string' ? contentType.slice(0, MAX_TYPE) : 'text';

    let expiresAt = null;
    if (typeof expiresInHours === 'number' && expiresInHours > 0) {
      expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const contentEncrypted = encrypt(content); // iv:authTag:ciphertext
    const preview = content.slice(0, 200);

    const { rows } = await pool.query(
      `INSERT INTO shared_links (user_id, token, title, content_encrypted, content_preview, content_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, token, title, content_type, views, created_at, expires_at`,
      [req.userId, token, safeTitle, contentEncrypted, preview, safeType, expiresAt],
    );
    const r = rows[0];
    res.status(201).json({
      id: r.id,
      token: r.token,
      url: buildShareUrl(req, r.token),
      title: r.title,
      contentType: r.content_type,
      views: r.views,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    });
  } catch (err) {
    logger.error('[sharedLinks] create failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/shared-links — 列出当前用户全部分享链接（按创建时间倒序）
router.get('/', ...protect, apiLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, token, content_preview, content_type, views, created_at, expires_at
       FROM shared_links
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId],
    );
    const list = rows.map((r) => ({
      id: r.id,
      title: r.title || r.content_preview || '(无标题)',
      url: buildShareUrl(req, r.token),
      contentType: r.content_type,
      preview: r.content_preview,
      views: r.views,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
    res.json({ links: list });
  } catch (err) {
    logger.error('[sharedLinks] list failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /api/shared-links/:id — 撤销一条分享链接（仅本人）
router.delete('/:id', ...protect, apiLimiter, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM shared_links WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    logger.error('[sharedLinks] delete failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/shared-links/public/:token — 公开访问（无登录），校验过期并自增 views，返回解密内容
router.get('/public/:token', apiLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { rows } = await pool.query(
      `UPDATE shared_links
       SET views = views + 1
       WHERE token = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING id, title, content_encrypted, content_type, views, created_at, expires_at`,
      [token],
    );
    if (rows.length === 0) {
      // 区分：不存在 vs 已过期
      const { rows: expired } = await pool.query(
        'SELECT 1 FROM shared_links WHERE token = $1 AND expires_at <= NOW()',
        [token],
      );
      const status = expired.length > 0 ? 410 : 404;
      const message = expired.length > 0 ? 'link expired' : 'not found';
      if (req.accepts('html')) {
        return res.status(status).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${status}</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 20px;"><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`);
      }
      return res.status(status).json({ error: message });
    }
    const r = rows[0];
    let content = '';
    try {
      content = decrypt(r.content_encrypted);
    } catch (e) {
      logger.error('[sharedLinks] decrypt failed', e);
      return res.status(500).json({ error: 'decrypt failed' });
    }

    // 浏览器打开时返回可读的 HTML 页面；API 调用返回 JSON
    if (req.accepts('html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderSharePage({
        title: r.title,
        content,
        contentType: r.content_type,
        views: r.views,
        createdAt: r.created_at,
      }));
    }

    res.json({
      id: r.id,
      title: r.title,
      content,
      contentType: r.content_type,
    });
  } catch (err) {
    logger.error('[sharedLinks] public fetch failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

export default router;

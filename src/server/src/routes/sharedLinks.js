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

function buildShareUrl(token) {
  const base = process.env.SHARE_LINK_BASE_URL || 'https://clipsync.io/s/';
  return base + token;
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
      url: buildShareUrl(r.token),
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
      url: buildShareUrl(r.token),
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
       RETURNING id, title, content_encrypted, content_type, expires_at`,
      [token],
    );
    if (rows.length === 0) {
      // 区分：不存在 vs 已过期
      const { rows: expired } = await pool.query(
        'SELECT 1 FROM shared_links WHERE token = $1 AND expires_at <= NOW()',
        [token],
      );
      return res.status(expired.length > 0 ? 410 : 404).json({ error: expired.length > 0 ? 'link expired' : 'not found' });
    }
    const r = rows[0];
    let content = '';
    try {
      content = decrypt(r.content_encrypted);
    } catch (e) {
      logger.error('[sharedLinks] decrypt failed', e);
      return res.status(500).json({ error: 'decrypt failed' });
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

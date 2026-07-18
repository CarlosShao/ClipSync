import { Router } from 'express';
import pool from '../db/pool.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/templates — 当前用户全部模板（按创建时间倒序）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, content, created_at, updated_at
       FROM clipboard_templates
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ data: rows });
  } catch (e) {
    logger.error('[templates] GET list failed', { error: e.message });
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /api/templates — 新建模板
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Template name is required' });
    }
    const safeName = name.trim().slice(0, 200);
    const safeContent = typeof content === 'string' ? content : '';
    const { rows } = await pool.query(
      `INSERT INTO clipboard_templates (user_id, name, content)
       VALUES ($1, $2, $3)
       RETURNING id, name, content, created_at, updated_at`,
      [req.userId, safeName, safeContent]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    logger.error('[templates] POST create failed', { error: e.message });
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PUT /api/templates/:id — 更新模板（name 与/或 content 可选）
router.put('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, content } = req.body || {};
    const fields = [];
    const params = [];
    let idx = 1;

    if (typeof name === 'string' && name.trim()) {
      fields.push(`name = $${idx++}`);
      params.push(name.trim().slice(0, 200));
    }
    if (typeof content === 'string') {
      fields.push(`content = $${idx++}`);
      params.push(content);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    fields.push('updated_at = NOW()');
    params.push(req.userId, id);

    const { rows } = await pool.query(
      `UPDATE clipboard_templates
       SET ${fields.join(', ')}
       WHERE user_id = $${idx} AND id = $${idx + 1}::uuid
       RETURNING id, name, content, created_at, updated_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(rows[0]);
  } catch (e) {
    logger.error('[templates] PUT update failed', { error: e.message });
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/templates/:id — 删除模板
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      `DELETE FROM clipboard_templates
       WHERE user_id = $1 AND id = $2::uuid`,
      [req.userId, id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.status(204).end();
  } catch (e) {
    logger.error('[templates] DELETE failed', { error: e.message });
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;

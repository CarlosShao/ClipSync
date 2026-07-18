import { Router } from 'express';
import pool from '../db/pool.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

// 变量名必须与前端 VAR_PATTERN 的标识符规则一致：
// 字母或下划线开头，可跟字母/数字/下划线。
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_NAME = 60;
const MAX_VALUE = 10000;

// GET /api/template-variables — 当前用户全部全局变量（按名称排序，便于展示稳定）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, value, created_at, updated_at
       FROM template_variables
       WHERE user_id = $1
       ORDER BY name ASC`,
      [req.userId]
    );
    res.json({ data: rows });
  } catch (e) {
    logger.error('[templateVariables] GET list failed', { error: e.message });
    res.status(500).json({ error: 'Failed to load template variables' });
  }
});

// PUT /api/template-variables — 按 (user_id, name)  upsert 一个变量
// body: { name: string, value?: string }
router.put('/', apiLimiter, async (req, res) => {
  try {
    const { name, value } = req.body || {};
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Variable name must be a valid identifier' });
    }
    const safeName = name.slice(0, MAX_NAME);
    const safeValue = typeof value === 'string' ? value.slice(0, MAX_VALUE) : '';

    const { rows } = await pool.query(
      `INSERT INTO template_variables (user_id, name, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING id, name, value, created_at, updated_at`,
      [req.userId, safeName, safeValue]
    );
    res.status(200).json(rows[0]);
  } catch (e) {
    logger.error('[templateVariables] PUT upsert failed', { error: e.message });
    res.status(500).json({ error: 'Failed to save template variable' });
  }
});

// DELETE /api/template-variables/:name — 删除指定变量
router.delete('/:name', apiLimiter, async (req, res) => {
  try {
    const { name } = req.params;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid variable name' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM template_variables
       WHERE user_id = $1 AND name = $2`,
      [req.userId, name]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Template variable not found' });
    }
    res.status(204).end();
  } catch (e) {
    logger.error('[templateVariables] DELETE failed', { error: e.message });
    res.status(500).json({ error: 'Failed to delete template variable' });
  }
});

export default router;

import { Router } from 'express';
import pool from '../db/pool.js';
import { validateSearch } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/search-history - 当前用户的搜索历史（按最近搜索时间倒序）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const result = await pool.query(
      `SELECT id, keyword, created_at, updated_at
       FROM search_history
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [req.userId, limit]
    );
    res.json({ items: result.rows, count: result.rowCount });
  } catch (err) {
    logger.error('Get search history error:', err);
    res.status(500).json({ error: 'Failed to fetch search history' });
  }
});

// POST /api/search-history - 记录一次搜索；重复关键词只顶到列表最前
router.post('/', apiLimiter, async (req, res) => {
  try {
    const keyword = validateSearch(req.body?.keyword, 100);
    if (!keyword) {
      return res.status(400).json({ error: 'Keyword is required' });
    }
    const result = await pool.query(
      `INSERT INTO search_history (user_id, keyword)
       VALUES ($1, $2)
       ON CONFLICT (user_id, keyword)
       DO UPDATE SET updated_at = NOW()
       RETURNING id, keyword, created_at, updated_at`,
      [req.userId, keyword]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('Record search history error:', err);
    res.status(500).json({ error: 'Failed to record search history' });
  }
});

// DELETE /api/search-history - 清空当前用户全部搜索历史
router.delete('/', apiLimiter, async (req, res) => {
  try {
    await pool.query('DELETE FROM search_history WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Clear search history error:', err);
    res.status(500).json({ error: 'Failed to clear search history' });
  }
});

export default router;

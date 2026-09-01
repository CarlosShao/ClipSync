import { Router } from 'express';
import pool from '../db/pool.js';
import { isValidUUID, validateSearch } from '../validation/validator.js';
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

// DELETE /api/search-history - 清空当前用户全部搜索历史；
// 携带 ?keyword= 时仅删除该关键词的单条记录（G4 单条删除：客户端本地镜像条目
// 可能尚未持有服务端行 id，按关键词删除兜底；keyword 与全清互斥）。
// 写入路径经 validateSearch 的 HTML 实体转义且该转义不幂等，故按
// 「转义后 + 原始」两种形态匹配（ANY 数组），保证含特殊字符的关键词也能命中。
router.delete('/', apiLimiter, async (req, res) => {
  try {
    const rawKeyword = req.query.keyword;
    if (rawKeyword !== undefined) {
      const raw = String(rawKeyword).trim().substring(0, 100);
      const candidates = [...new Set([validateSearch(raw, 100), raw].filter(Boolean))];
      if (candidates.length === 0) {
        return res.status(400).json({ error: 'Keyword is required' });
      }
      await pool.query(
        'DELETE FROM search_history WHERE user_id = $1 AND keyword = ANY($2::text[])',
        [req.userId, candidates]
      );
      return res.json({ ok: true });
    }
    await pool.query('DELETE FROM search_history WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Clear search history error:', err);
    res.status(500).json({ error: 'Failed to clear search history' });
  }
});

// DELETE /api/search-history/:id - 删除单条历史（按行 id；WHERE 同时限定
// user_id，跨用户 id 一律 404，保证用户隔离）
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const result = await pool.query(
      'DELETE FROM search_history WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Search history not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('Delete search history error:', err);
    res.status(500).json({ error: 'Failed to delete search history' });
  }
});

export default router;

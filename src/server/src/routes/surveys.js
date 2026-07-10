/**
 * Survey routes — NPS / CSAT feedback
 */

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * POST /api/surveys
 * Submit a survey response (NPS score + optional feedback)
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { type, score, feedback } = req.body;

    if (!type || score === undefined || score === null) {
      return res.status(400).json({ error: 'Missing required fields: type, score' });
    }

    if (typeof score !== 'number' || score < 0 || score > 10) {
      return res.status(400).json({ error: 'Score must be a number between 0 and 10' });
    }

    const result = await pool.query(
      `INSERT INTO surveys (user_id, type, score, feedback, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, type, score, feedback, created_at`,
      [req.user.userId, type, score, feedback || null]
    );

    logger.info(`[Surveys] New ${type} response: score=${score} from user ${req.user.userId}`);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('[Surveys] Submit failed:', { error: error.message });
    res.status(500).json({ error: 'Failed to submit survey' });
  }
});

/**
 * GET /api/surveys/stats
 * Get survey statistics (admin or aggregated)
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         type,
         COUNT(*) as total,
         ROUND(AVG(score)::numeric, 1) as avg_score,
         COUNT(*) FILTER (WHERE score >= 9) as promoters,
         COUNT(*) FILTER (WHERE score >= 7 AND score <= 8) as passives,
         COUNT(*) FILTER (WHERE score <= 6) as detractors
       FROM surveys
       GROUP BY type`
    );
    res.json(result.rows);
  } catch (error) {
    logger.error('[Surveys] Stats failed:', { error: error.message });
    res.status(500).json({ error: 'Failed to get survey stats' });
  }
});

/**
 * GET /api/surveys/my
 * Get current user's survey responses
 */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, score, feedback, created_at
       FROM surveys WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    logger.error('[Surveys] My surveys failed:', { error: error.message });
    res.status(500).json({ error: 'Failed to get surveys' });
  }
});

export default router;

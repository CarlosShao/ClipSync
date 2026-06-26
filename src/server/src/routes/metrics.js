import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /api/metrics
 * 获取服务指标（JSON格式）
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const stats = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    logger.error('Failed to get metrics:', err);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

/**
 * GET /api/metrics/prometheus
 * 获取Prometheus格式指标
 */
router.get('/prometheus', authenticateToken, async (req, res) => {
  try {
    let prometheusMetrics = '# HELP clipsync_uptime_seconds Server uptime in seconds\n';
    prometheusMetrics += `# TYPE clipsync_uptime_seconds gauge\n`;
    prometheusMetrics += `clipsync_uptime_seconds ${process.uptime()}\n`;

    prometheusMetrics += '# HELP clipsync_memory_rss_bytes Memory RSS in bytes\n';
    prometheusMetrics += `# TYPE clipsync_memory_rss_bytes gauge\n`;
    prometheusMetrics += `clipsync_memory_rss_bytes ${process.memoryUsage().rss}\n`;

    prometheusMetrics += '# HELP clipsync_memory_heap_used_bytes Memory heap used in bytes\n';
    prometheusMetrics += `# TYPE clipsync_memory_heap_used_bytes gauge\n`;
    prometheusMetrics += `clipsync_memory_heap_used_bytes ${process.memoryUsage().heapUsed}\n`;

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(prometheusMetrics);
  } catch (err) {
    logger.error('Failed to get Prometheus metrics:', err);
    res.status(500).send('Failed to get Prometheus metrics');
  }
});

export default router;

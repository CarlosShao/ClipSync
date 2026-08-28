import { Router } from 'express';
import crypto from 'crypto';
import { getRedisClient } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/ws/csrf-token — 签发一次性 WebSocket CSRF token
// 格式：64 位 hex（满足 ws/server.js 的 /^[a-f0-9]{64}$/ 校验）；
// 存储键：`csrf:{token}`（ws 校验读取的键；与 REST csrf 的 `csrf:token:{token}` 是两套键，勿混用）；
// TTL 60 秒，单次使用（ws 握手成功后由服务端删除）。
router.get('/csrf-token', async (req, res) => {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      // Redis 不可用时拒绝签发：生产环境 ws 侧 fail-closed，本端点不应发无效 token
      return res.status(503).json({ error: 'CSRF service unavailable' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await redis.setEx(`csrf:${token}`, 60, JSON.stringify({ userId: req.userId }));
    res.json({ csrfToken: token, expiresIn: 60 });
  } catch (err) {
    logger.error('WS CSRF token issue error:', { error: err.message });
    res.status(500).json({ error: 'Failed to issue CSRF token' });
  }
});

export default router;

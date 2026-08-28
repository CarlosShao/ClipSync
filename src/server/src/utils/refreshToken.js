import crypto from 'crypto';
import { getRedisClient } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

// Refresh token 存储与旋转（Redis）
// Key: rt:{token} → { userId, sessionId }，TTL 默认 30 天（REFRESH_TOKEN_TTL_DAYS 可调）
// 旋转采用 GETDEL 原子消费：并发重放时只有第一个请求成功，其余立即失效。
// 与 WS CSRF 的 `csrf:{token}`、REST CSRF 的 `csrf:token:{token}` 是独立键空间，勿混用。

const REFRESH_TTL_SECONDS = (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS) || 30) * 24 * 60 * 60;

/** 签发 refresh token（64 hex）。Redis 不可用时仍返回 token，但刷新将失败 → 用户重新登录，与现状一致。 */
export async function issueRefreshToken(userId, sessionId) {
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.setEx(`rt:${token}`, REFRESH_TTL_SECONDS, JSON.stringify({ userId, sessionId }));
    }
  } catch (err) {
    logger.error('[RefreshToken] issue failed (non-fatal):', { error: err.message });
  }
  return token;
}

/** 原子消费并旋转：返回 { userId, sessionId } 或 null（无效/已用/过期）。 */
export async function rotateRefreshToken(token) {
  const redis = await getRedisClient();
  if (!redis || !token) return null;
  try {
    const raw = await redis.getDel(`rt:${token}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.error('[RefreshToken] rotate error:', { error: err.message });
    return null;
  }
}

/** 吊销（登出等场景）。 */
export async function revokeRefreshToken(token) {
  try {
    const redis = await getRedisClient();
    if (redis && token) await redis.del(`rt:${token}`);
  } catch (err) {
    logger.error('[RefreshToken] revoke failed (non-fatal):', { error: err.message });
  }
}

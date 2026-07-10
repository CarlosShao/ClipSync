/**
 * Redis 客户端工具
 * 用于在生产环境中替代内存存储（csrfTokens, uploadSessions, connections）
 */

import redis from 'redis';
import config from '../config.js';
import { logger } from './logger.js';

let client = null;
let isConnected = false;

/**
 * 获取 Redis 客户端（单例模式）
 */
export async function getRedisClient() {
  if (client && isConnected) {
    return client;
  }

  if (!client) {
    client = redis.createClient({
      socket: {
        host: config.redis?.host || 'localhost',
        port: config.redis?.port || 6379,
      },
      password: config.redis?.password || undefined,
      database: config.redis?.database || 0,
    });

    client.on('error', (err) => {
      logger.error('Redis Client Error:', { error: err.message });
    });

    client.on('connect', () => {
      logger.info('Redis connected');
      isConnected = true;
    });

    client.on('disconnect', () => {
      logger.info('Redis disconnected');
      isConnected = false;
    });
  }

  if (!isConnected) {
    await client.connect();
    isConnected = true;
  }

  return client;
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedisClient() {
  if (client && isConnected) {
    await client.quit();
    client = null;
    isConnected = false;
  }
}

/**
 * 存储 CSRF 令牌到 Redis
 * Key: csrf:token:{token}
 * Value: JSON string { userId, sessionId, expiresAt, createdAt }
 * TTL: 24 hours
 */
export async function storeCsrfToken(token, data) {
  const client = await getRedisClient();
  const key = `csrf:token:${token}`;
  await client.setEx(key, 24 * 60 * 60, JSON.stringify(data));
}

/**
 * 获取 CSRF 令牌 from Redis
 */
export async function getCsrfToken(token) {
  const client = await getRedisClient();
  const key = `csrf:token:${token}`;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

/**
 * 删除 CSRF 令牌 from Redis
 */
export async function deleteCsrfToken(token) {
  const client = await getRedisClient();
  const key = `csrf:token:${token}`;
  await client.del(key);
}

/**
 * 存储上传会话到 Redis
 * Key: upload:session:{sessionId}
 * Value: JSON string { userId, deviceId, fileName, fileSize, chunks, expiresAt }
 * TTL: 24 hours
 */
export async function storeUploadSession(sessionId, data) {
  const client = await getRedisClient();
  const key = `upload:session:${sessionId}`;
  await client.setEx(key, 24 * 60 * 60, JSON.stringify(data));
}

/**
 * 获取上传会话 from Redis
 */
export async function getUploadSession(sessionId) {
  const client = await getRedisClient();
  const key = `upload:session:${sessionId}`;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

/**
 * 删除上传会话 from Redis
 */
export async function deleteUploadSession(sessionId) {
  const client = await getRedisClient();
  const key = `upload:session:${sessionId}`;
  await client.del(key);
}

/**
 * 存储 WebSocket 连接元数据到 Redis
 * Key: ws:connection:{userId}:{deviceId}
 * Value: JSON string { instanceId, connectedAt }
 * TTL: 1 hour (heartbeat 会续期)
 */
export async function storeWebSocketConnection(userId, deviceId, instanceId) {
  const client = await getRedisClient();
  const key = `ws:connection:${userId}:${deviceId}`;
  await client.setEx(key, 60 * 60, JSON.stringify({
    userId,
    deviceId,
    instanceId,
    connectedAt: Date.now(),
  }));
}

/**
 * 删除 WebSocket 连接元数据 from Redis
 */
export async function deleteWebSocketConnection(userId, deviceId) {
  const client = await getRedisClient();
  const key = `ws:connection:${userId}:${deviceId}`;
  await client.del(key);
}

/**
 * 获取用户的所有 WebSocket 连接（跨实例）
 */
export async function getUserWebSocketConnections(userId) {
  const client = await getRedisClient();
  if (!client) return [];
  
  // 使用 SCAN 替代 KEYS，避免阻塞 Redis
  const connections = [];
  const pattern = `ws:connection:${userId}:*`;
  
  for await (const key of client.scanIterator({
    MATCH: pattern,
    COUNT: 100,
  })) {
    const data = await client.get(key);
    if (data) {
      connections.push(JSON.parse(data));
    }
  }
  
  return connections;
}

/**
 * 清理过期数据（可选，Redis TTL 会自动清理）
 */
export async function cleanupExpiredData() {
  // Redis TTL 会自动清理过期数据，无需手动清理
  logger.info('Redis TTL auto cleanup enabled');
}

// ============================================
// 幂等性操作（Idempotency）
// Key: idempotency:{key}
// Value: JSON string { status, headers, body, timestamp }
// TTL: 24 hours
// ============================================

/**
 * 存储已处理请求的响应（幂等性保证）
 */
export async function storeProcessedRequest(key, data) {
  const client = await getRedisClient();
  const redisKey = `idempotency:${key}`;
  await client.setEx(redisKey, 24 * 60 * 60, JSON.stringify(data));
}

/**
 * 获取已处理的请求响应
 */
export async function getProcessedRequest(key) {
  const client = await getRedisClient();
  const redisKey = `idempotency:${key}`;
  const data = await client.get(redisKey);
  return data ? JSON.parse(data) : null;
}

/**
 * 删除已处理的请求记录
 */
export async function deleteProcessedRequest(key) {
  const client = await getRedisClient();
  const redisKey = `idempotency:${key}`;
  await client.del(redisKey);
}

// ============================================
// Token 黑名单（会话吊销 / 注销 / 账户停用）
// Key: bl:{jti}  (jti === sessionId)
// Value: '1'
// TTL: token 剩余有效期，避免 key 无限堆积
// 注意：Redis 不可用时所有方法降级返回（false），由 DB 层
// user_sessions.is_active 兜底（H2 修复：不能因 Redis 抖动让全站 403）
// ============================================

/**
 * 解析时长字符串为秒数（用于黑名单 TTL / token 有效期）
 * 支持：数字(秒) / "60s" / "30m" / "24h" / "7d"；非法返回 0
 */
export function parseDurationToSeconds(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return 0;
  const m = input.trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return n * mult;
}

/**
 * 将 jti 加入黑名单（会话吊销 / 注销 / 停用时立即使 token 失效）
 * @param {string} jti
 * @param {number} ttlSeconds - 应等于 token 剩余有效期（或完整有效期）
 * @returns {Promise<boolean>} 是否成功写入
 */
export async function blacklistJti(jti, ttlSeconds) {
  if (!jti) return false;
  const ttl = Math.floor(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  try {
    const client = await getRedisClient();
    if (!client) return false;
    await client.setEx(`bl:${jti}`, ttl, '1');
    return true;
  } catch (err) {
    logger.error('[redis] blacklistJti failed:', { error: err.message, jti });
    return false;
  }
}

/**
 * 查询 jti 是否已被黑名单（吊销）
 * @param {string} jti
 * @returns {Promise<boolean>} true=已吊销
 */
export async function isJtiBlacklisted(jti) {
  if (!jti) return false;
  try {
    const client = await getRedisClient();
    if (!client) return false; // Redis 不可用 → 降级为“未吊销”，由 DB session 活性兜底
    const val = await client.get(`bl:${jti}`);
    return val !== null;
  } catch (err) {
    logger.error('[redis] isJtiBlacklisted failed (degraded):', { error: err.message, jti });
    return false; // Redis 抖动时降级，避免全站 403（H2 修复）
  }
}

export default {
  getRedisClient,
  closeRedisClient,
  storeCsrfToken,
  getCsrfToken,
  deleteCsrfToken,
  storeUploadSession,
  getUploadSession,
  deleteUploadSession,
  storeWebSocketConnection,
  deleteWebSocketConnection,
  getUserWebSocketConnections,
  cleanupExpiredData,
  storeProcessedRequest,
  getProcessedRequest,
  deleteProcessedRequest,
  blacklistJti,
  isJtiBlacklisted,
  parseDurationToSeconds,
};

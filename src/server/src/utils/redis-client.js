/**
 * Redis 客户端工具
 * 用于在生产环境中替代内存存储（csrfTokens, uploadSessions, connections）
 */

import redis from 'redis';
import config from '../config.js';

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
      console.error('Redis Client Error:', err);
    });

    client.on('connect', () => {
      console.log('Redis connected');
      isConnected = true;
    });

    client.on('disconnect', () => {
      console.log('Redis disconnected');
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
  const pattern = `ws:connection:${userId}:*`;
  const keys = await client.keys(pattern);
  
  const connections = [];
  for (const key of keys) {
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
  console.log('Redis TTL auto cleanup enabled');
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
};

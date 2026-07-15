/**
 * 速率限制中间件（生产级修复版）
 * 
 * 功能：
 * 1. API调用限制（每IP）
 * 2. 验证码发送限制（每手机号）
 * 3. 登录失败限制（每账号）
 * 4. WebSocket连接限制（每用户）
 * 
 * 算法：Redis ZSET 滑动窗口（真正滑动窗口，无临界问题）
 * 降级：Redis 不可用时使用内存 ZSET（单实例可用，不允许放行）
 */

import { getRedisClient as getSharedRedisClient } from '../utils/redis-client.js';
import { logger } from '../utils/logger.js';

// 内存存储（Redis 不可用时的降级方案）
// 使用 Map<key, number[]> 存储时间戳列表
const memoryStores = {
  api: new Map(),
  sendCode: new Map(),
  loginFailed: new Map(),
};

/**
 * 清理过期记录（内存模式）
 */
function cleanupMemoryStore(store, windowMs) {
  const now = Date.now();
  for (const [key, timestamps] of store.entries()) {
    const validTimestamps = timestamps.filter(ts => now - ts < windowMs);
    if (validTimestamps.length === 0) {
      store.delete(key);
    } else {
      store.set(key, validTimestamps);
    }
  }
}

/**
 * Redis 滑动窗口限流（生产级正确实现）
 * 
 * 算法：使用 Redis 有序集合（ZSET）
 * 1. ZADD：添加当前请求时间戳
 * 2. ZREMRANGEBYSCORE：移除窗口外的时间戳
 * 3. ZCARD：统计窗口内请求数
 * 4. EXPIRE：设置 key 过期时间（避免内存泄漏）
 * 
 * 优点：
 * - 真正的滑动窗口（无临界问题）
 * - 使用流水线保证原子性
 * - 精确控制速率
 */
async function checkRateLimitRedis(key, windowMs, max, storeName = 'api') {
  const client = await getSharedRedisClient();
  if (!client) {
    // Redis 不可用，降级到内存模式（不允许放行！）
    logger.warn('[RateLimiter] Redis unavailable, falling back to memory mode for key:', { key });
    return checkRateLimitMemory(key, windowMs, max, storeName);
  }

  const redisKey = `ratelimit:${storeName}:${key}`;
  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}:${Math.random().toString(36).substr(1, 6)}`;
  
  try {
    // 使用流水线保证原子性
    const pipeline = client.multi();
    
    // 1. 添加当前请求
    pipeline.zAdd(redisKey, { score: now, value: member });
    
    // 2. 移除窗口外的时间戳
    pipeline.zRemRangeByScore(redisKey, 0, windowStart);
    
    // 3. 统计窗口内请求数
    pipeline.zCard(redisKey);
    
    // 4. 设置过期时间（避免内存泄漏）
    pipeline.expire(redisKey, Math.ceil(windowMs / 1000));
    
    const results = await pipeline.exec();
    
    const count = results[2][1]; // ZCARD 的结果
    const resetTime = now + windowMs;
    
    return {
      allowed: count <= max,
      count: count,
      resetTime,
    };
  } catch (err) {
    logger.error('[RateLimiter] Redis operation failed:', { error: err.message });
    // Redis 操作失败，降级到内存模式
    return checkRateLimitMemory(key, windowMs, max, storeName);
  }
}

/**
 * 内存滑动窗口限流（降级方案）
 * 使用 Map<key, number[]> 存储时间戳列表
 * @param {string} storeName - 对应 memoryStores 的 key，实现各 limiter 独立计数
 */
function checkRateLimitMemory(key, windowMs, max, storeName = 'api') {
  const now = Date.now();
  const windowStart = now - windowMs;

  // 使用独立的 store，避免 strictLimiter/uploadLimiter 与 apiLimiter 互相污染
  const store = memoryStores[storeName] || memoryStores.api;

  // 获取或创建时间戳列表
  let timestamps = store.get(key) || [];
  
  // 移除窗口外的时间戳
  timestamps = timestamps.filter(ts => ts > windowStart);
  
  // 检查是否超限
  if (timestamps.length >= max) {
    store.set(key, timestamps);
    return {
      allowed: false,
      count: timestamps.length,
      resetTime: timestamps[0] + windowMs, // 最早的时间戳 + 窗口大小
    };
  }

  // 添加当前请求
  timestamps.push(now);
  store.set(key, timestamps);

  // 定期清理（避免内存泄漏）
  if (Math.random() < 0.01) { // 1% 概率触发清理
    cleanupMemoryStore(store, windowMs);
  }
  
  return {
    allowed: true,
    count: timestamps.length,
    resetTime: timestamps[0] + windowMs,
  };
}

/**
 * 通用速率限制中间件工厂
 */
function createRateLimiter(options) {
  const {
    windowMs = 60 * 1000,
    max = 100,
    message = 'Too many requests, please try again later',
    keyGenerator = (req) => req.ip || req.connection?.remoteAddress,
    storeName = 'api',
    skipSuccessfulRequests = false,
  } = options;
  
  const useRedis = process.env.NODE_ENV === 'production' && process.env.REDIS_HOST;
  const memoryStore = memoryStores[storeName];
  
  return async (req, res, next) => {
    // 测试环境跳过
    if (process.env.NODE_ENV === 'test' && storeName === 'api') {
      return next();
    }
    
    const key = keyGenerator(req);
    let result;
    
    if (useRedis) {
      result = await checkRateLimitRedis(key, windowMs, max, storeName);
    } else {
      result = checkRateLimitMemory(key, windowMs, max, storeName);
    }
    
    // 设置响应头
    res.set({
      'X-RateLimit-Limit': max,
      'X-RateLimit-Remaining': Math.max(0, max - result.count),
      'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
    });
    
    // 检查是否超限
    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({
        error: message,
        retryAfter,
      });
    }
    
    next();
  };
}

/**
 * API调用限流（每IP）
 * 默认：每分钟100次
 */
export const apiLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : createRateLimiter({
      windowMs: 60 * 1000,  // 1分钟
      max: 300,             // 300次（桌面端同步需要更多请求）
      message: 'API rate limit exceeded, please try again later',
      keyGenerator: (req) => {
        // 已登录请求按用户限流（C5 修复）；匿名请求回退到 IP（兼容配对/匿名路由）
        if (req.userId) return `user:${req.userId}`;
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip ||
               req.connection?.remoteAddress;
      },
      storeName: 'api',
    });

/**
 * 验证码发送限流（每手机号）
 * 默认：每小时5次
 */
export const sendCodeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,  // 1小时
  max: 5,                     // 5次
  message: 'Verification code rate limit exceeded, please try again in 1 hour',
  keyGenerator: (req) => {
    const phone = req.body?.phone;
    return phone ? `sendCode:${phone}` : 'sendCode:unknown';
  },
  storeName: 'sendCode',
});

/**
 * 登录失败限流（每账号）
 * 默认：每15分钟5次
 */
export const loginFailedLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 5,                     // 5次
  message: 'Too many login attempts, please try again in 15 minutes',
  keyGenerator: (req) => {
    const phone = req.body?.phone;
    return phone ? `loginFailed:${phone}` : 'loginFailed:unknown';
  },
  storeName: 'loginFailed',
});

/**
 * 登录成功后清除失败记录
 */
export function clearLoginFailed(phone) {
  getSharedRedisClient().then(client => {
    if (client) {
      const redisKey = `ratelimit:loginFailed:${phone}`;
      client.del(redisKey).catch(() => {});
    } else {
      // Redis 不可用，清除内存存储
      const key = `loginFailed:${phone}`;
      memoryStores.loginFailed.delete(key);
    }
  }).catch(() => {
    // Redis 不可用，清除内存存储
    const key = `loginFailed:${phone}`;
    memoryStores.loginFailed.delete(key);
  });
}

/**
 * WebSocket连接限流（每用户最多5个连接）
 * 注意：WebSocket连接对象无法序列化到Redis，此限流保持内存模式
 * 多实例部署时需配置Nginx会话粘性
 */
const wsConnections = new Map();

export function checkWsConnectionLimit(userId, deviceId) {
  const key = `ws:${userId}`;
  const now = Date.now();
  const windowMs = 60 * 1000;
  
  let record = wsConnections.get(key);
  if (!record || now - record.windowStart > windowMs) {
    record = {
      windowStart: now,
      devices: new Set(),
    };
    wsConnections.set(key, record);
  }
  
  if (record.devices.size >= 5 && !record.devices.has(deviceId)) {
    return false;
  }
  
  record.devices.add(deviceId);
  return true;
}

export function removeWsConnection(userId, deviceId) {
  const key = `ws:${userId}`;
  const record = wsConnections.get(key);
  
  if (record && record.devices) {
    record.devices.delete(deviceId);
    if (record.devices.size === 0) {
      wsConnections.delete(key);
    }
  }
}

/**
 * 严格限流（用于敏感操作）
 * 默认：每分钟10次
 */
export const strictLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many requests, please try again later',
  storeName: 'api',
});

/**
 * 文件上传限流
 * 默认：每分钟20次
 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'File upload rate limit exceeded, please try again later',
  storeName: 'api',
});

/**
 * 获取限流状态（用于调试）
 */
export async function getRateLimitStatus(storeName, key) {
  const client = await getSharedRedisClient();
  if (client) {
    // Redis 模式：直接查询 Redis
    const redisKey = `ratelimit:${key}`;
    const timestamps = await client.zRangeByScore(redisKey, Date.now() - 60000, Date.now());
    return {
      count: timestamps.length,
      resetTime: timestamps.length > 0 ? parseInt(timestamps[0].split(':')[0]) + 60000 : null,
    };
  }
  
  // Redis 不可用，查询内存存储
  const store = memoryStores[storeName];
  if (!store) return null;
  
  const timestamps = store.get(key);
  if (!timestamps) return null;
  
  const now = Date.now();
  const validTimestamps = timestamps.filter(ts => now - ts < 60000); // 默认1分钟窗口
  
  return {
    count: validTimestamps.length,
    resetTime: validTimestamps[0] ? timestamps[0] + 60000 : null,
  };
}

/**
 * 重置限流（用于测试）
 * 使用 scan() 替代 keys() 避免阻塞 Redis
 */
export async function resetRateLimit(storeName, key) {
  const client = await getSharedRedisClient();
  if (client) {
    const pattern = key ? `ratelimit:${key}` : 'ratelimit:*';
    // 使用 scan() 迭代删除，避免 keys() 阻塞 Redis
    let cursor = '0';
    let deletedCount = 0;
    do {
      const [nextCursor, foundKeys] = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: 100,
      });
      cursor = nextCursor;
      if (foundKeys.length > 0) {
        await client.del(foundKeys);
        deletedCount += foundKeys.length;
      }
    } while (cursor !== '0');
    logger.info('[RateLimiter] Reset rate limits', { pattern, deletedCount });
    return true;
  }
  
  // Redis 不可用，清除内存存储
  const store = memoryStores[storeName];
  if (!store) return false;
  
  if (key) {
    return store.delete(key);
  } else {
    store.clear();
    return true;
  }
}

export default {
  apiLimiter,
  sendCodeLimiter,
  loginFailedLimiter,
  clearLoginFailed,
  checkWsConnectionLimit,
  removeWsConnection,
  strictLimiter,
  uploadLimiter,
  getRateLimitStatus,
  resetRateLimit,
};

// Export factory function for creating custom rate limiters
export { createRateLimiter };

// Re-export getRedisClient for ws/server.js usage
export { getRedisClient as getRedisClient } from '../utils/redis-client.js';

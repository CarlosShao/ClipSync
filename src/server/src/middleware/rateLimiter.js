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

import Redis from 'redis';

// Redis客户端（单例）
let redisClient = null;
let redisAvailable = false;

async function getRedisClient() {
  if (!redisClient && process.env.REDIS_HOST) {
    try {
      redisClient = Redis.createClient({
        url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
        password: process.env.REDIS_PASSWORD || undefined,
      });
      redisClient.on('error', (err) => {
        console.error('[RateLimiter] Redis error:', err.message);
        redisAvailable = false;
      });
      redisClient.on('connect', () => {
        console.log('[RateLimiter] Redis connected');
        redisAvailable = true;
      });
      await redisClient.connect();
      redisAvailable = true;
    } catch (err) {
      console.error('[RateLimiter] Failed to connect to Redis:', err.message);
      redisAvailable = false;
    }
  }
  
  if (redisClient && !redisClient.isOpen) {
    try {
      await redisClient.connect();
      redisAvailable = true;
    } catch (err) {
      redisAvailable = false;
    }
  }
  
  return redisClient;
}

/**
 * 内存存储（Redis 不可用时的降级方案）
 * 使用 Map<key, number[]> 存储时间戳列表
 */
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
async function checkRateLimitRedis(key, windowMs, max) {
  const client = await getRedisClient();
  if (!client || !redisAvailable) {
    // Redis 不可用，降级到内存模式（不允许放行！）
    console.warn('[RateLimiter] Redis unavailable, falling back to memory mode for key:', key);
    return checkRateLimitMemory(key, windowMs, max);
  }
  
  const redisKey = `ratelimit:${key}`;
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
    console.error('[RateLimiter] Redis operation failed:', err.message);
    // Redis 操作失败，降级到内存模式
    return checkRateLimitMemory(key, windowMs, max);
  }
}

/**
 * 内存滑动窗口限流（降级方案）
 * 使用 Map<key, number[]> 存储时间戳列表
 */
function checkRateLimitMemory(key, windowMs, max) {
  const now = Date.now();
  const windowStart = now - windowMs;
  
  // 获取或创建时间戳列表
  let timestamps = memoryStores.api.get(key) || [];
  
  // 移除窗口外的时间戳
  timestamps = timestamps.filter(ts => ts > windowStart);
  
  // 检查是否超限
  if (timestamps.length >= max) {
    memoryStores.api.set(key, timestamps);
    return {
      allowed: false,
      count: timestamps.length,
      resetTime: timestamps[0] + windowMs, // 最早的时间戳 + 窗口大小
    };
  }
  
  // 添加当前请求
  timestamps.push(now);
  memoryStores.api.set(key, timestamps);
  
  // 定期清理（避免内存泄漏）
  if (Math.random() < 0.01) { // 1% 概率触发清理
    cleanupMemoryStore(memoryStores.api, windowMs);
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
    message = '请求过于频繁，请稍后再试',
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
      result = await checkRateLimitRedis(key, windowMs, max);
    } else {
      result = checkRateLimitMemory(key, windowMs, max);
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
      max: 100,             // 100次
      message: 'API请求过于频繁，请稍后再试',
      keyGenerator: (req) => {
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
  message: '验证码发送过于频繁，请1小时后再试',
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
  message: '登录失败次数过多，请15分钟后再试',
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
  if (process.env.NODE_ENV === 'production' && process.env.REDIS_HOST) {
    getRedisClient().then(client => {
      if (client) {
        const redisKey = `ratelimit:loginFailed:${phone}`;
        client.del(redisKey).catch(() => {});
      }
    }).catch(() => {});
  } else {
    // 内存模式：移除该手机号的所有时间戳
    const key = `loginFailed:${phone}`;
    memoryStores.loginFailed.delete(key);
  }
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
  message: '操作过于频繁，请稍后再试',
  storeName: 'api',
});

/**
 * 文件上传限流
 * 默认：每分钟20次
 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: '文件上传过于频繁，请稍后再试',
  storeName: 'api',
});

/**
 * 获取限流状态（用于调试）
 */
export function getRateLimitStatus(storeName, key) {
  if (process.env.NODE_ENV === 'production' && process.env.REDIS_HOST) {
    return null; // Redis状态需直接查询Redis
  }
  
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
 */
export function resetRateLimit(storeName, key) {
  if (process.env.NODE_ENV === 'production' && process.env.REDIS_HOST) {
    getRedisClient().then(client => {
      if (client) {
        const pattern = key ? `ratelimit:${key}` : 'ratelimit:*';
        client.keys(pattern).then(keys => {
          if (keys.length > 0) client.del(keys);
        }).catch(() => {});
      }
    }).catch(() => {});
    return true;
  }
  
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

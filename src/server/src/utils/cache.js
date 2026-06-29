import { getRedisClient } from '../middleware/rateLimiter.js';
import { logger } from './logger.js';

// 缓存 TTL 配置（秒）
const CACHE_TTL = {
  USER_INFO: 300,        // 5 分钟
  DEVICE_LIST: 120,      // 2 分钟
  SUBSCRIPTION: 600,     // 10 分钟
  CLIPBOARD_STATS: 60,   // 1 分钟
  EMPTY_RESULT: 30,      // 空结果缓存 30 秒（防止缓存穿透）
};

// 缓存键前缀
const CACHE_PREFIX = {
  USER: 'cache:user:',
  DEVICE: 'cache:device:',
  SUBSCRIPTION: 'cache:subscription:',
  STATS: 'cache:stats:',
  EMPTY: 'cache:empty:',  // 空结果缓存前缀（防止缓存穿透）
};

// 互斥锁 TTL（防止缓存击穿）
const CACHE_LOCK_TTL = 10; // 10 秒

/**
 * 获取缓存（带缓存击穿防护）
 * @param {string} key - 缓存键
 * @param {Function} fetchFn - 数据获取函数（当缓存未命中时调用）
 * @param {number} ttl - 缓存 TTL（秒）
 * @returns {Promise<any>} 数据
 */
export async function getCacheWithLock(key, fetchFn, ttl = 300) {
  // 1. 尝试从缓存获取
  let data = await getCache(key);
  if (data !== null) {
    // 检查是否是空结果缓存
    if (data === '__EMPTY__') {
      return null;
    }
    return data;
  }

  // 2. 缓存未命中，尝试获取锁
  const lockKey = `lock:${key}`;
  const lockAcquired = await acquireLock(lockKey, CACHE_LOCK_TTL);
  
  if (lockAcquired) {
    // 3. 获取锁成功，查询数据库
    try {
      data = await fetchFn();
      
      // 4. 缓存结果（包括空结果）
      if (data === null || data === undefined) {
        // 缓存空结果，防止缓存穿透
        await setCache(key, '__EMPTY__', CACHE_TTL.EMPTY_RESULT);
      } else {
        await setCache(key, data, ttl + getRandomOffset(ttl)); // 添加随机偏移，防止缓存雪崩
      }
      
      return data;
    } finally {
      // 5. 释放锁
      await releaseLock(lockKey);
    }
  } else {
    // 6. 获取锁失败，等待一段时间后重试
    await sleep(50); // 等待 50ms
    return await getCacheWithLock(key, fetchFn, ttl);
  }
}

/**
 * 获取缓存（简化版，不带锁）
 * @param {string} key - 缓存键
 * @returns {Promise<any|null>} 缓存值或 null
 */
export async function getCache(key) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return null;

    const value = await redisClient.get(key);
    if (!value) return null;

    return JSON.parse(value);
  } catch (err) {
    logger.warn('Cache get error', { key, error: err.message });
    return null;
  }
}

/**
 * 获取随机 TTL 偏移（防止缓存雪崩）
 * @param {number} ttl - 基础 TTL
 * @returns {number} 随机偏移量（0 ~ ttl * 0.2）
 */
function getRandomOffset(ttl) {
  return Math.floor(Math.random() * ttl * 0.2); // 随机 0~20% 偏移
}

/**
 * 睡眠函数
 * @param {number} ms - 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取分布式锁（防止缓存击穿）
 * @param {string} lockKey - 锁键
 * @param {number} ttl - 锁 TTL（秒）
 * @returns {Promise<boolean>} 是否获取成功
 */
async function acquireLock(lockKey, ttl) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return false;
    
    // 使用 SET NX EX 命令获取锁
    const result = await redisClient.set(lockKey, '1', {
      NX: true,
      EX: ttl,
    });
    
    return result === 'OK';
  } catch (err) {
    logger.warn('Acquire lock error', { lockKey, error: err.message });
    return false;
  }
}

/**
 * 释放分布式锁
 * @param {string} lockKey - 锁键
 * @returns {Promise<void>}
 */
async function releaseLock(lockKey) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return;
    
    await redisClient.del(lockKey);
  } catch (err) {
    logger.warn('Release lock error', { lockKey, error: err.message });
  }
}

/**
 * 设置缓存
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttl - 过期时间（秒）
 */
export async function setCache(key, value, ttl = 300) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return;

    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
  } catch (err) {
    logger.warn('Cache set error', { key, error: err.message });
  }
}

/**
 * 删除缓存
 * @param {string} key - 缓存键
 */
export async function deleteCache(key) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return;

    await redisClient.del(key);
  } catch (err) {
    logger.warn('Cache delete error', { key, error: err.message });
  }
}

/**
 * 删除匹配模式的缓存（使用 SCAN 避免阻塞 Redis）
 * @param {string} pattern - 匹配模式（如 "cache:user:*"）
 */
export async function deleteCachePattern(pattern) {
  try {
    const redisClient = await getRedisClient();
    if (!redisClient) return;

    // 使用 SCAN 迭代删除，避免 KEYS 命令阻塞 Redis
    const keys = [];
    for await (const key of redisClient.scanIterator({
      MATCH: pattern,
      COUNT: 100, // 每次扫描 100 个 key
    })) {
      keys.push(key);
      // 批量删除，每 100 个一批
      if (keys.length >= 100) {
        await redisClient.del(keys);
        keys.length = 0; // 清空数组
      }
    }
    // 删除剩余的 key
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    logger.warn('Cache delete pattern error', { pattern, error: err.message });
  }
}

// ============================================
// 用户信息缓存
// ============================================

/**
 * 获取用户信息缓存
 * @param {string} userId - 用户ID
 * @returns {Promise<Object|null>} 用户信息
 */
export async function getUserCache(userId) {
  return getCache(`${CACHE_PREFIX.USER}${userId}`);
}

/**
 * 设置用户信息缓存
 * @param {string} userId - 用户ID
 * @param {Object} userData - 用户数据
 */
export async function setUserCache(userId, userData) {
  return setCache(`${CACHE_PREFIX.USER}${userId}`, userData, CACHE_TTL.USER_INFO);
}

/**
 * 清除用户信息缓存
 * @param {string} userId - 用户ID
 */
export async function clearUserCache(userId) {
  return deleteCache(`${CACHE_PREFIX.USER}${userId}`);
}

// ============================================
// 设备列表缓存
// ============================================

/**
 * 获取设备列表缓存
 * @param {string} userId - 用户ID
 * @returns {Promise<Array|null>} 设备列表
 */
export async function getDeviceListCache(userId) {
  return getCache(`${CACHE_PREFIX.DEVICE}${userId}`);
}

/**
 * 设置设备列表缓存
 * @param {string} userId - 用户ID
 * @param {Array} devices - 设备列表
 */
export async function setDeviceListCache(userId, devices) {
  return setCache(`${CACHE_PREFIX.DEVICE}${userId}`, devices, CACHE_TTL.DEVICE_LIST);
}

/**
 * 清除设备列表缓存
 * @param {string} userId - 用户ID
 */
export async function clearDeviceListCache(userId) {
  return deleteCache(`${CACHE_PREFIX.DEVICE}${userId}`);
}

// ============================================
// 订阅信息缓存
// ============================================

/**
 * 获取订阅信息缓存
 * @param {string} userId - 用户ID
 * @returns {Promise<Object|null>} 订阅信息
 */
export async function getSubscriptionCache(userId) {
  return getCache(`${CACHE_PREFIX.SUBSCRIPTION}${userId}`);
}

/**
 * 设置订阅信息缓存
 * @param {string} userId - 用户ID
 * @param {Object} subscription - 订阅数据
 */
export async function setSubscriptionCache(userId, subscription) {
  return setCache(`${CACHE_PREFIX.SUBSCRIPTION}${userId}`, subscription, CACHE_TTL.SUBSCRIPTION);
}

/**
 * 清除订阅信息缓存
 * @param {string} userId - 用户ID
 */
export async function clearSubscriptionCache(userId) {
  return deleteCache(`${CACHE_PREFIX.SUBSCRIPTION}${userId}`);
}

// ============================================
// 统计数据缓存
// ============================================

/**
 * 获取统计数据缓存
 * @param {string} userId - 用户ID
 * @param {string} statsType - 统计类型
 * @returns {Promise<Object|null>} 统计数据
 */
export async function getStatsCache(userId, statsType) {
  return getCache(`${CACHE_PREFIX.STATS}${userId}:${statsType}`);
}

/**
 * 设置统计数据缓存
 * @param {string} userId - 用户ID
 * @param {string} statsType - 统计类型
 * @param {Object} stats - 统计数据
 */
export async function setStatsCache(userId, statsType, stats) {
  return setCache(`${CACHE_PREFIX.STATS}${userId}:${statsType}`, stats, CACHE_TTL.CLIPBOARD_STATS);
}

/**
 * 清除用户所有统计数据缓存
 * @param {string} userId - 用户ID
 */
export async function clearStatsCache(userId) {
  return deleteCachePattern(`${CACHE_PREFIX.STATS}${userId}:*`);
}

// ============================================
// 缓存中间件
// ============================================

/**
 * 创建缓存中间件
 * @param {Function} cacheKeyFn - 缓存键生成函数
 * @param {number} ttl - 缓存 TTL
 * @returns {Function} Express 中间件
 */
export function cacheMiddleware(cacheKeyFn, ttl = 300) {
  return async (req, res, next) => {
    try {
      const cacheKey = cacheKeyFn(req);
      const cachedData = await getCache(cacheKey);

      if (cachedData) {
        logger.debug('Cache hit', { key: cacheKey });
        return res.json(cachedData);
      }

      // 重写 res.json 以缓存响应
      const originalJson = res.json.bind(res);
      res.json = async (data) => {
        await setCache(cacheKey, data, ttl);
        return originalJson(data);
      };

      next();
    } catch (err) {
      logger.warn('Cache middleware error', { error: err.message });
      next();
    }
  };
}

export default {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  getUserCache,
  setUserCache,
  clearUserCache,
  getDeviceListCache,
  setDeviceListCache,
  clearDeviceListCache,
  getSubscriptionCache,
  setSubscriptionCache,
  clearSubscriptionCache,
  getStatsCache,
  setStatsCache,
  clearStatsCache,
  cacheMiddleware,
  CACHE_TTL,
  CACHE_PREFIX,
};

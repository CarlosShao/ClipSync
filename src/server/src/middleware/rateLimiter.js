/**
 * 速率限制中间件
 * 
 * 功能：
 * 1. API调用限制（每IP）
 * 2. 验证码发送限制（每手机号）
 * 3. 登录失败限制（每账号）
 * 4. WebSocket连接限制（每用户）
 * 
 * 注意：生产环境应使用Redis存储，当前使用内存存储
 */

/**
 * 内存存储（生产环境替换为Redis）
 */
const stores = {
  api: new Map(),           // API限流
  sendCode: new Map(),      // 验证码发送限流
  loginFailed: new Map(),   // 登录失败限流
  wsConnection: new Map(),  // WebSocket连接限流
};

/**
 * 清理过期记录
 */
function cleanupStore(store, windowMs) {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (now - record.windowStart > windowMs) {
      store.delete(key);
    }
  }
}

/**
 * 通用滑动窗口限流器
 */
function createRateLimiter(options) {
  const {
    windowMs = 60 * 1000,    // 时间窗口（毫秒）
    max = 100,                // 最大请求数
    message = '请求过于频繁，请稍后再试',
    keyGenerator = (req) => req.ip || req.connection.remoteAddress,
    store = stores.api,
    skipSuccessfulRequests = false,
  } = options;

  // 定期清理
  const cleanupInterval = setInterval(() => cleanupStore(store, windowMs), windowMs);

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();

    // 清理过期记录
    if (now - (store.get('__lastCleanup') || 0) > windowMs) {
      cleanupStore(store, windowMs);
      store.set('__lastCleanup', now);
    }

    // 获取或创建记录
    let record = store.get(key);
    if (!record || now - record.windowStart > windowMs) {
      record = {
        windowStart: now,
        count: 0,
      };
      store.set(key, record);
    }

    // 增加计数
    record.count++;

    // 设置响应头
    res.set({
      'X-RateLimit-Limit': max,
      'X-RateLimit-Remaining': Math.max(0, max - record.count),
      'X-RateLimit-Reset': new Date(record.windowStart + windowMs).toISOString(),
    });

    // 检查是否超限
    if (record.count > max) {
      const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
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
  ? (req, res, next) => next()  // Skip in test mode (other limiters still active)
  : createRateLimiter({
      windowMs: 60 * 1000,  // 1分钟
      max: 100,             // 100次
      message: 'API请求过于频繁，请稍后再试',
      keyGenerator: (req) => {
        // 支持代理
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip ||
               req.connection.remoteAddress;
      },
      store: stores.api,
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
  store: stores.sendCode,
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
  store: stores.loginFailed,
});

/**
 * 登录成功后清除失败记录
 */
export function clearLoginFailed(phone) {
  stores.loginFailed.delete(`loginFailed:${phone}`);
}

/**
 * WebSocket连接限流（每用户）
 * 默认：每用户最多5个连接
 */
export const wsConnectionLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1分钟
  max: 5,               // 5个连接
  message: 'WebSocket连接数过多',
  keyGenerator: (userId) => `ws:${userId}`,
  store: stores.wsConnection,
});

/**
 * 检查WebSocket连接数
 */
export function checkWsConnectionLimit(userId, deviceId) {
  const key = `ws:${userId}`;
  const now = Date.now();
  const windowMs = 60 * 1000;

  let record = stores.wsConnection.get(key);
  if (!record || now - record.windowStart > windowMs) {
    record = {
      windowStart: now,
      devices: new Set(),
    };
    stores.wsConnection.set(key, record);
  }

  // 检查是否已超过限制
  if (record.devices.size >= 5 && !record.devices.has(deviceId)) {
    return false; // 超过限制
  }

  record.devices.add(deviceId);
  return true;
}

/**
 * 移除WebSocket连接
 */
export function removeWsConnection(userId, deviceId) {
  const key = `ws:${userId}`;
  const record = stores.wsConnection.get(key);
  
  if (record && record.devices) {
    record.devices.delete(deviceId);
    if (record.devices.size === 0) {
      stores.wsConnection.delete(key);
    }
  }
}

/**
 * 严格限流（用于敏感操作）
 * 默认：每分钟10次
 */
export const strictLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1分钟
  max: 10,              // 10次
  message: '操作过于频繁，请稍后再试',
  store: stores.api,
});

/**
 * 文件上传限流
 * 默认：每分钟20次
 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1分钟
  max: 20,              // 20次
  message: '文件上传过于频繁，请稍后再试',
  store: stores.api,
});

/**
 * 获取限流状态（用于调试）
 */
export function getRateLimitStatus(storeName, key) {
  const store = stores[storeName];
  if (!store) return null;
  
  const record = store.get(key);
  if (!record) return null;
  
  return {
    windowStart: record.windowStart,
    count: record.count || record.devices?.size || 0,
  };
}

/**
 * 重置限流（用于测试）
 */
export function resetRateLimit(storeName, key) {
  const store = stores[storeName];
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
  wsConnectionLimiter,
  checkWsConnectionLimit,
  removeWsConnection,
  strictLimiter,
  uploadLimiter,
  getRateLimitStatus,
  resetRateLimit,
};

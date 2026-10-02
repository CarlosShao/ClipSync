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
import { getRuntimeLimits, getCachedRuntimeLimits } from '../utils/runtimeLimits.js';
import { logger } from '../utils/logger.js';

// 内存存储（Redis 不可用时的降级方案）
// 使用 Map<key, number[]> 存储时间戳列表
// CO-51：每个 limiter 独立桶——strictLimiter/uploadLimiter 与 apiLimiter 互不污染
const memoryStores = {
  api: new Map(),
  sendCode: new Map(),
  loginFailed: new Map(),
  upload: new Map(),
  strict: new Map(),
  // 未认证的验证码消费端点专用桶（/reset-password、/set-password）
  // 与 sendCode 隔离：发码额度不应被爆破尝试吃掉
  authCode: new Map(),
  // AN-07：管理台专用桶——adminLimiter / adminStrictLimiter 与客户端 API 的 apiLimiter/strictLimiter
  // 完全隔离计数，避免管理台高频巡检与客户端流量互相挤兑（CO-51 同原则）
  admin: new Map(),
  adminStrict: new Map(),
  // 应用内反馈工单（POST /api/feedback）：独立桶 + 独立阈值，避免与 strictLimiter
  // 的敏感操作额度互相挤兑（CO-51 同原则）
  feedback: new Map(),
  // 模型能力自检探测（POST /api/ai/model-settings/probe）：会真实打一次上游、消耗用户额度，
  // 因此独立桶 + 更严阈值（10 次/分/用户），且与 apiLimiter 分桶互不挤兑
  modelProbe: new Map(),
};

/**
 * 身份标识归一化（phone / email / account）：小写去空格 + 限长，避免键膨胀
 */
function normalizeIdentity(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  if (!v) return '';
  return v.length > 128 ? v.slice(0, 128) : v;
}

/**
 * 请求携带的身份标识：phone > email > account（登录接口用统一 account 字段）
 * 取不到返回空串——调用方必须退回 IP 分桶，绝不能共用一个全局桶
 */
function requestIdentity(req) {
  const body = req.body || {};
  return normalizeIdentity(body.phone) || normalizeIdentity(body.email) || normalizeIdentity(body.account);
}

/**
 * 客户端 IP：统一取 req.ip（配合 index.js 的 app.set('trust proxy', 1)），
 * 不自行解析可被伪造的 X-Forwarded-For。req.ip 缺失时用一次性随机键，
 * 保证任何情况下都不会退化成共享桶。
 */
function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || `unresolved:${Math.random().toString(36).slice(2, 10)}`;
}

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
  // slice 替代已废弃的 substr（String.prototype.substr 非标准且已标记废弃）
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  
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

    // ⚠️ 生产事故修复（2026-09-15 首次生产部署实测）：
    // node-redis v4+ 的 multi().exec() 返回**扁平结果数组**（如 [1,0,1,1]），
    // 而非旧版 ioredis 的 [err, value] 二元组。此处曾按 results[2][1] 取值，
    // 得到 undefined → count=undefined → `count <= max` 恒为 false
    // → **所有经 apiLimiter 的请求恒返回 429**（实测 x-ratelimit-remaining: NaN）。
    // 影响面：/api/app（含桌面端更新检查）、/api/subscriptions、/api/payments 等。
    // 之所以长期未暴露：dev/test 环境 NODE_ENV !== 'production'，走内存降级分支，
    // 该分支实现正确；只有生产（Redis 模式）才触发。
    const rawCount = Array.isArray(results) ? results[2] : undefined;
    const count = Number.isFinite(rawCount) ? rawCount : null;

    // 计数拿不到 = 限流状态不可信。fail-closed 会拦死全部流量（本次事故形态），
    // 故此处选择「告警 + 放行」：限流是保护措施，不应成为全站不可用的单点。
    if (count === null) {
      logger.error('[RateLimiter] Redis ZCARD 结果异常，本次放行以免全站 429', {
        key,
        results: JSON.stringify(results)?.slice(0, 120),
      });
      return { allowed: true, count: 0, resetTime: now + windowMs };
    }

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
    keyGenerator = (req) => clientIp(req),
    storeName = 'api',
    skipSuccessfulRequests = false,
    // CO-10：动态阈值键（system_configs）；未声明则用固定 max
    limitKey = null,
  } = options;

  const useRedis = process.env.NODE_ENV === 'production' && process.env.REDIS_HOST;
  const memoryStore = memoryStores[storeName];

  return async (req, res, next) => {
    // P0-C/C1：原此处的 `if (NODE_ENV === 'test' && storeName === 'api') return next()` 已删除。
    // 测试环境的隔离手段不是「关掉限流」，而是 resetAllRateLimitStores()（见 tests/setup.js
    // 的 beforeEach）——用例之间清零计数，用例之内阈值真实生效。

    // CO-10：运行时阈值——每次限流检查取当前快照（getRuntimeLimits 自带 5s TTL 缓存，
    // 命中缓存时只有一次 Promise resolve 的开销；读库失败 fail-closed 回退默认值）。
    // rate_limit_disabled=true → 该 limiter 整体放行，不计数、不写响应头。
    // ⚠ 这是**产品功能**（管理台 system_configs 总闸，CO-11 已禁止在生产写 true），
    //   不是环境旁路：它读的是库里的配置，与 NODE_ENV 无关。
    const snapshot = await getRuntimeLimits();
    if (snapshot.disabled) return next();
    const effectiveMax = limitKey ? (snapshot[limitKey] ?? max) : max;

    const key = keyGenerator(req);
    let result;

    if (useRedis) {
      result = await checkRateLimitRedis(key, windowMs, effectiveMax, storeName);
    } else {
      result = checkRateLimitMemory(key, windowMs, effectiveMax, storeName);
    }

    // 设置响应头
    res.set({
      'X-RateLimit-Limit': effectiveMax,
      'X-RateLimit-Remaining': Math.max(0, effectiveMax - result.count),
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
 * P0-C/C1：此处原为 `process.env.NODE_ENV === 'test' ? (req,res,next)=>next() : createRateLimiter(...)`
 * ——测试环境导出的是一个**什么都不做的占位函数**，全仓穿过 /api/* 的用例因此
 * 从未证明过 apiLimiter 生效。现统一导出真实 limiter（测试隔离见 resetAllRateLimitStores）。
 */
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1分钟
  max: 300,             // 兜底默认；运行时读 rate_limit_api_per_min（CO-10）
  limitKey: 'apiPerMin',
  message: 'API rate limit exceeded, please try again later',
  keyGenerator: (req) => {
    // 已登录请求按用户限流（C5 修复）；匿名请求回退到 IP（兼容配对/匿名路由）
    if (req.userId) return `user:${req.userId}`;
    return clientIp(req);
  },
  storeName: 'api',
});

/**
 * 验证码发送限流（每手机号）
 * 默认：每小时5次
 */
export const sendCodeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,  // 1小时
  max: 5,                     // 兜底默认；运行时读 rate_limit_send_code_per_hour（CO-10）
  limitKey: 'sendCodePerHour',
  message: 'Verification code rate limit exceeded, please try again in 1 hour',
  keyGenerator: (req) => {
    // 取不到身份标识时按 IP 分桶，绝不落到共享的 unknown 桶
    // （旧实现下 5 个匿名请求即可锁死全站邮箱发码/找回密码）
    const identity = requestIdentity(req);
    return identity ? `sendCode:${identity}` : `sendCode:ip:${clientIp(req)}`;
  },
  storeName: 'sendCode',
});

/**
 * 登录失败限流（每账号）
 * 默认：每15分钟5次
 */
export const loginFailedLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 5,                     // 兜底默认；运行时读 rate_limit_login_failed_per_15min（CO-10）
  limitKey: 'loginFailedPer15Min',
  message: 'Too many login attempts, please try again in 15 minutes',
  keyGenerator: (req) => {
    const identity = requestIdentity(req);
    return identity ? `loginFailed:${identity}` : `loginFailed:ip:${clientIp(req)}`;
  },
  storeName: 'loginFailed',
});

/**
 * 未认证验证码消费端点的限流（/reset-password、/set-password）：
 * IP 桶 + 目标账号桶双重限制，防验证码爆破。
 * 固定阈值不走 runtimeLimits 动态键——避免管理台误配把爆破防线调没
 * （rate_limit_disabled 总开关仍生效）。
 */
export const authCodeIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts, please try again in 15 minutes',
  keyGenerator: (req) => `authCode:ip:${clientIp(req)}`,
  storeName: 'authCode',
});

export const authCodeAccountLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts for this account, please try again in 15 minutes',
  keyGenerator: (req) => `authCode:id:${requestIdentity(req) || clientIp(req)}`,
  storeName: 'authCode',
});

/**
 * 登录成功后清除失败记录
 */
export function clearLoginFailed(identifier) {
  const bucketKey = `loginFailed:${normalizeIdentity(identifier)}`;
  getSharedRedisClient().then(client => {
    if (client) {
      // 与 checkRateLimitRedis 的 `ratelimit:${storeName}:${key}` 命名保持一致
      client.del(`ratelimit:loginFailed:${bucketKey}`).catch(() => {});
    } else {
      // Redis 不可用，清除内存存储
      memoryStores.loginFailed.delete(bucketKey);
    }
  }).catch(() => {
    // Redis 不可用，清除内存存储
    memoryStores.loginFailed.delete(bucketKey);
  });
}

/**
 * WebSocket连接限流（每用户最多5个连接）
 * 注意：WebSocket连接对象无法序列化到Redis，此限流保持内存模式
 * 多实例部署时需配置Nginx会话粘性
 */
const wsConnections = new Map();

export function checkWsConnectionLimit(userId, deviceId) {
  // CO-10：限流总开关（同步快照）——disabled 时 WS 连接数限制放行
  if (getCachedRuntimeLimits().disabled) return true;

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
  storeName: 'strict',
});

/**
 * 应用内反馈工单限流（POST /api/feedback）
 * 每用户 5 条/分钟（匿名回退 IP 分桶）：反馈是人工处理的，正常用户不会连发，
 * 但接口是「写库 + 发邮件」的组合，必须挡住脚本刷屏（邮件通道也有配额）。
 */
export const feedbackLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many feedback submissions, please try again later',
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : clientIp(req)),
  storeName: 'feedback',
});

/**
 * 模型能力自检探测限流（POST /api/ai/model-settings/probe）
 * 每用户 10 次/分钟（匿名回退 IP 分桶）：该端点会**真实调用用户的模型供应商**一次
 * （消耗额度 + 上游可能限流），所以必须有独立、更严的桶；固定阈值不走 runtimeLimits
 * 动态键 —— 自检是低频操作，不允许被管理台配置放大。
 */
export const modelProbeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many model probe requests, please try again later',
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : clientIp(req)),
  storeName: 'modelProbe',
});

/**
 * AN-07：管理台专用限流（/api/admin 全量挂载，见 index.js）
 * 比公共 API 更严的敏感口径：按 IP 100 次/分钟（固定阈值，不走 runtimeLimits 动态键——
 * 防止管理台误操作把自己的防线调高/关闭；rate_limit_disabled 总开关仍生效）。
 * 与 apiLimiter 的 store 隔离，不影响客户端 API 现有限流；按 IP 而非用户计数，
 * 避免单个被盗管理员凭据在多出口 IP 下绕过阈值。
 */
export const adminLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Admin API rate limit exceeded, please try again later',
  keyGenerator: (req) => clientIp(req),
  storeName: 'admin',
});

/**
 * AN-07：管理台高危写操作限流（退款 / 强制下线 / 运维动作等，挂载见 routes/admin/index.js）。
 * 每 IP + URL 首段资源分桶 10 次/分钟：单类高危端点保持 strict 级别 10 次/分钟上限，
 * 分桶是为了同一管理员在多类高危操作间不互相挤兑（工单 AN-07：POST /api/admin/* 高危写操作额外挂更严限流）。
 */
export const adminStrictLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Sensitive admin operation rate limit exceeded, please try again later',
  keyGenerator: (req) => {
    const ip = clientIp(req);
    // 按 URL 首段资源分桶：/orders/xxx/refund → 'orders'、/ops/actions → 'ops'
    const segment = req.path.split('/').filter(Boolean)[0] || 'root';
    return `${ip}:${segment}`;
  },
  storeName: 'adminStrict',
});

/**
 * 文件上传限流
 * 默认：每分钟20次
 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,                    // 兜底默认；运行时读 rate_limit_upload_per_min（CO-10）
  limitKey: 'uploadPerMin',
  message: 'File upload rate limit exceeded, please try again later',
  storeName: 'upload',
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

/**
 * 清空全部内存限流桶（测试隔离用；由 tests/setup.js 的 beforeEach 调用）。
 *
 * ⚠ 这不是「把限流关掉」：中间件与阈值照常执行，只是用例之间的历史计数被清零，
 *   等价于 `resetRateLimit(store)` 的一次性全量版。单个用例之内连续打满阈值依旧 429
 *   （见 tests/auth-s0-security.test.js / tests/middleware/runtime-limits.test.js）。
 *   生产环境走 Redis 分支时本函数无效果，也不会被调用。
 */
export function resetAllRateLimitStores() {
  for (const store of Object.values(memoryStores)) store.clear();
  wsConnections.clear();
}

export default {
  apiLimiter,
  sendCodeLimiter,
  loginFailedLimiter,
  authCodeIpLimiter,
  authCodeAccountLimiter,
  clearLoginFailed,
  checkWsConnectionLimit,
  removeWsConnection,
  strictLimiter,
  feedbackLimiter,
  modelProbeLimiter,
  uploadLimiter,
  adminLimiter,
  adminStrictLimiter,
  getRateLimitStatus,
  resetRateLimit,
  resetAllRateLimitStores,
};

// Export factory function for creating custom rate limiters
export { createRateLimiter };

// Re-export getRedisClient for ws/server.js usage
export { getRedisClient as getRedisClient } from '../utils/redis-client.js';

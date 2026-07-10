import crypto from 'crypto';
import logger from '../utils/logger.js';
import {
  storeProcessedRequest,
  getProcessedRequest,
  deleteProcessedRequest,
} from '../utils/redis-client.js';

/**
 * 幂等性保证中间件
 *
 * 防止重复处理相同的请求（特别是 Webhook）。
 * 生产环境使用 Redis 存储，开发环境使用内存回退。
 */

// 内存回退方案（当Redis不可用时）
const memoryProcessedRequests = new Map(); // key -> { response, timestamp }

// 是否使用Redis
const useRedis = process.env.NODE_ENV === 'production';

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24小时

/**
 * 清理过期的内存幂等性记录（仅内存模式需要，Redis TTL自动清理）
 */
function cleanExpiredMemoryRecords() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of memoryProcessedRequests.entries()) {
    if (now - value.timestamp > IDEMPOTENCY_TTL) {
      memoryProcessedRequests.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug('Cleaned expired idempotency records from memory', { count: cleaned });
  }
}

// 每小时清理一次内存记录
setInterval(cleanExpiredMemoryRecords, 60 * 60 * 1000);

/**
 * 存储已处理的请求（支持Redis和内存）
 */
async function saveProcessed(key, data) {
  if (useRedis) {
    try {
      await storeProcessedRequest(key, data);
    } catch (err) {
      logger.error('Failed to store idempotency key in Redis, falling back to memory', err);
      memoryProcessedRequests.set(key, data);
    }
  } else {
    memoryProcessedRequests.set(key, data);
  }
}

/**
 * 获取已处理的请求（支持Redis和内存）
 */
async function loadProcessed(key) {
  if (useRedis) {
    try {
      return await getProcessedRequest(key);
    } catch (err) {
      logger.error('Failed to get idempotency key from Redis, falling back to memory', err);
      return memoryProcessedRequests.get(key) || null;
    }
  }
  return memoryProcessedRequests.get(key) || null;
}

/**
 * 删除已处理的请求记录（同时清理Redis和内存）
 */
async function removeProcessed(key) {
  // 始终清理内存
  memoryProcessedRequests.delete(key);
  if (useRedis) {
    try {
      await deleteProcessedRequest(key);
    } catch (err) {
      logger.error('Failed to delete idempotency key from Redis', err);
    }
  }
}

/**
 * 生成幂等性键
 * @param {Object} req - Express 请求对象
 * @returns {string} 幂等性键
 */
function generateIdempotencyKey(req) {
  // 1. 优先使用请求头中的 Idempotency-Key
  const headerKey = req.headers['idempotency-key'];
  if (headerKey) {
    return `header-${headerKey}`;
  }

  // 2. 使用请求体中的唯一标识（如 orderNo, transactionId）
  const bodyKey = req.body?.orderNo || req.body?.transactionId || req.body?.id;
  if (bodyKey) {
    return `body-${bodyKey}`;
  }

  // 3. 使用请求签名（请求方法 + URL + 请求体哈希）
  const method = req.method;
  const url = req.originalUrl || req.url;
  const bodyHash = crypto.createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');
  return `sig-${method}-${url}-${bodyHash}`;
}

/**
 * 幂等性保证中间件（通用）
 * @param {Object} options - 配置选项
 * @param {number} options.ttl - 幂等性键的生存时间（毫秒），默认 24 小时
 * @param {boolean} options.sendCachedResponse - 是否返回缓存的响应，默认 true
 * @returns {Function} Express 中间件
 */
export function createIdempotencyMiddleware(options = {}) {
  const ttl = options.ttl || IDEMPOTENCY_TTL;
  const sendCachedResponse = options.sendCachedResponse !== false;
  // requireHeader：仅当客户端显式携带 Idempotency-Key 时才启用。
  // 避免对“body 签名相同”的合法请求（如用户主动重新复制同一内容、不同文件同大小）误判为重复。
  const requireHeader = options.requireHeader === true;

  return async (req, res, next) => {
    try {
      // requireHeader 模式下无 header 直接放行，不做任何幂等处理
      if (requireHeader && !req.headers['idempotency-key']) {
        return next();
      }

      const key = generateIdempotencyKey(req);

      // 检查是否已处理过
      const cached = await loadProcessed(key);
      if (cached) {
        // 检查是否过期
        if (Date.now() - cached.timestamp <= ttl) {
          logger.info('Idempotency: Returning cached response', { key });

          if (sendCachedResponse && cached.response) {
            // 返回缓存的响应
            res.status(cached.response.status);
            for (const [header, value] of Object.entries(cached.response.headers || {})) {
              res.setHeader(header, value);
            }
            return res.send(cached.response.body);
          } else {
            logger.info('Idempotency: Re-processing request', { key });
          }
        } else {
          // 已过期，删除并重新处理
          await removeProcessed(key);
          logger.info('Idempotency: Key expired, processing normally', { key });
        }
      }

      // 拦截响应，缓存结果（仅缓存成功响应 2xx，避免把 4xx/5xx 误当成“已处理”导致重试永远拿到错误）
      const originalSend = res.send;
      res.send = function(body) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const record = {
            response: {
              status: res.statusCode,
              headers: res.getHeaders(),
              body: body,
            },
            timestamp: Date.now(),
          };
          saveProcessed(key, record).catch((err) =>
            logger.error('Idempotency: Failed to cache response', err)
          );
          logger.info('Idempotency: Caching response', { key });
        }
        // 调用原始的 send 方法
        return originalSend.call(this, body);
      };

      next();
    } catch (err) {
      logger.error('Idempotency middleware error:', err);
      next();
    }
  };
}

/**
 * Webhook 专用幂等性中间件
 *
 * Webhook 通常使用 `transaction_id` 或 `event_id` 作为幂等性键。
 */
export function webhookIdempotencyMiddleware() {
  return async (req, res, next) => {
    try {
      // 从请求体中提取唯一标识
      const eventId =
        req.body?.transactionId ||   // 微信支付
        req.body?.trade_no ||       // 支付宝
        req.body?.id ||              // Stripe
        req.headers['x-request-id']; // 通用

      if (!eventId) {
        logger.warn('Webhook Idempotency: No event ID found, skipping');
        return next();
      }

      const key = `webhook-${eventId}`;

      // 检查是否已处理过
      const cached = await loadProcessed(key);
      if (cached) {
        if (Date.now() - cached.timestamp <= IDEMPOTENCY_TTL) {
          logger.info('Webhook Idempotency: Event already processed', { eventId, key });
          return res.status(200).json(cached.response.body);
        } else {
          await removeProcessed(key);
        }
      }

      // 拦截响应，缓存结果
      const originalJson = res.json;
      res.json = function(body) {
        // 缓存响应
        const record = {
          response: {
            status: res.statusCode,
            body: body,
          },
          timestamp: Date.now(),
        };
        saveProcessed(key, record).catch((err) =>
          logger.error('Webhook Idempotency: Failed to cache event', err)
        );

        logger.info('Webhook Idempotency: Caching event', { eventId });

        // 调用原始的 json 方法
        return originalJson.call(this, body);
      };

      next();
    } catch (err) {
      logger.error('Webhook Idempotency middleware error:', err);
      next();
    }
  };
}

/**
 * 手动标记请求为已处理（用于复杂场景）
 * @param {string} key - 幂等性键
 * @param {Object} response - 缓存的响应
 */
export async function markAsProcessed(key, response) {
  await saveProcessed(key, {
    response,
    timestamp: Date.now(),
  });
  logger.info('Manually marked as processed', { key });
}

/**
 * 检查请求是否已处理
 * @param {Object} req - Express 请求对象
 * @returns {Promise<boolean>} 是否已处理
 */
export async function isProcessed(req) {
  const key = generateIdempotencyKey(req);
  const cached = await loadProcessed(key);
  return !!cached && (Date.now() - cached.timestamp <= IDEMPOTENCY_TTL);
}

export default {
  createIdempotencyMiddleware,
  webhookIdempotencyMiddleware,
  markAsProcessed,
  isProcessed,
};

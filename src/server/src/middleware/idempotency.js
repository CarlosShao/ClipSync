import crypto from 'crypto';
import logger from '../utils/logger.js';

/**
 * 幂等性保证中间件
 * 
 * 防止重复处理相同的请求（特别是 Webhook）。
 * 使用 `Idempotency-Key` 请求头或请求体中的唯一标识。
 * 
 * 需要 Redis 或数据库来存储已处理的请求。
 * 当前使用内存 Map（生产环境应使用 Redis）。
 */

// 内存存储（生产环境应使用 Redis）
const processedRequests = new Map(); // key -> { response, timestamp }
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24小时

/**
 * 清理过期的幂等性记录
 */
function cleanExpiredRecords() {
  const now = Date.now();
  for (const [key, value] of processedRequests.entries()) {
    if (now - value.timestamp > IDEMPOTENCY_TTL) {
      processedRequests.delete(key);
    }
  }
}

// 每小时清理一次
setInterval(cleanExpiredRecords, 60 * 60 * 1000);

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
  
  return async (req, res, next) => {
    try {
      const key = generateIdempotencyKey(req);
      
      // 检查是否已处理过
      if (processedRequests.has(key)) {
        const cached = processedRequests.get(key);
        
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
            // 重新处理（但使用相同的幂等性键）
            logger.info('Idempotency: Re-processing request', { key });
          }
        } else {
          // 已过期，删除并记录
          processedRequests.delete(key);
          logger.info('Idempotency: Key expired, processing normally', { key });
        }
      }
      
      // 拦截响应，缓存结果
      const originalSend = res.send;
      res.send = function(body) {
        // 缓存响应
        processedRequests.set(key, {
          response: {
            status: res.statusCode,
            headers: res.getHeaders(),
            body: body,
          },
          timestamp: Date.now(),
        });
        
        logger.info('Idempotency: Caching response', { key });
        
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
 * Webhook 通常使用 ` transaction_id` 或 `event_id` 作为幂等性键。
 */
export function webhookIdempotencyMiddleware() {
  return async (req, res, next) => {
    try {
      // 从请求体中提取唯一标识
      const eventId = 
        req.body?.transactionId ||  // 微信支付
        req.body?.trade_no ||       // 支付宝
        req.body?.id ||              // Stripe
        req.headers['x-request-id'];  // 通用
      
      if (!eventId) {
        logger.warn('Webhook Idempotency: No event ID found, skipping');
        return next();
      }
      
      const key = `webhook-${eventId}`;
      
      // 检查是否已处理过
      if (processedRequests.has(key)) {
        const cached = processedRequests.get(key);
        
        if (Date.now() - cached.timestamp <= IDEMPOTENCY_TTL) {
          logger.info('Webhook Idempotency: Event already processed', { eventId, key });
          return res.status(200).json(cached.response.body);
        } else {
          processedRequests.delete(key);
        }
      }
      
      // 拦截响应，缓存结果
      const originalJson = res.json;
      res.json = function(body) {
        // 缓存响应
        processedRequests.set(key, {
          response: {
            status: res.statusCode,
            body: body,
          },
          timestamp: Date.now(),
        });
        
        logger.info('Webhook Idempotency: Caching event', { eventId, key });
        
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
export function markAsProcessed(key, response) {
  processedRequests.set(key, {
    response,
    timestamp: Date.now(),
  });
  logger.info('Manually marked as processed', { key });
}

/**
 * 检查请求是否已处理
 * @param {Object} req - Express 请求对象
 * @returns {boolean} 是否已处理
 */
export function isProcessed(req) {
  const key = generateIdempotencyKey(req);
  return processedRequests.has(key) && 
         (Date.now() - processedRequests.get(key).timestamp <= IDEMPOTENCY_TTL);
}

export default {
  createIdempotencyMiddleware,
  webhookIdempotencyMiddleware,
  markAsProcessed,
  isProcessed,
};

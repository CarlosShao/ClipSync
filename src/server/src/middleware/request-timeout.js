/**
 * 请求超时中间件
 * 
 * 功能：
 * 1. 设置每个请求的超时时间
 * 2. 超时后返回 504 Gateway Timeout
 * 3. 记录超时请求日志
 * 
 * 配置：
 * - 全局默认超时：30 秒
 * - 可针对特定路由设置不同超时
 */

import { logger } from '../utils/logger.js';

// 默认超时（毫秒）
const DEFAULT_TIMEOUT = 30000; // 30 秒

// 路由特定超时（毫秒）
const ROUTE_TIMEOUTS = {
  '/api/auth/login': 10000,          // 登录 10 秒
  '/api/auth/register': 10000,       // 注册 10 秒
  '/api/clipboard': 15000,           // 剪贴板操作 15 秒
  '/api/media/upload': 60000,         // 文件上传 60 秒
  '/api/sync/push': 20000,           // 同步推送 20 秒
  '/api/payments': 30000,            // 支付 30 秒
};

/**
 * 请求超时中间件
 * @param {number} timeout - 超时时间（毫秒），默认 30 秒
 */
export function requestTimeout(timeout = DEFAULT_TIMEOUT) {
  return (req, res, next) => {
    // 检查是否有路由特定的超时设置
    const routeTimeout = getRouteTimeout(req.path);
    const actualTimeout = routeTimeout || timeout;

    // 设置超时定时器
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('Request timeout', {
          method: req.method,
          url: req.url,
          ip: req.ip,
          timeout: actualTimeout,
          userId: req.userId || 'unauthenticated',
        });

        res.status(504).json({
          error: 'Request timeout',
          message: 'The request took too long to process. Please try again.',
          timeout: actualTimeout,
        });
      }
    }, actualTimeout);

    // 响应完成时清除定时器
    res.on('finish', () => {
      clearTimeout(timer);
    });

    res.on('close', () => {
      clearTimeout(timer);
    });

    next();
  };
}

/**
 * 根据请求路径获取超时设置
 * @param {string} path - 请求路径
 * @returns {number|null} 超时时间（毫秒），或 null 使用默认
 */
function getRouteTimeout(path) {
  // 精确匹配
  if (ROUTE_TIMEOUTS[path]) {
    return ROUTE_TIMEOUTS[path];
  }

  // 前缀匹配
  for (const [routePrefix, timeout] of Object.entries(ROUTE_TIMEOUTS)) {
    if (path.startsWith(routePrefix)) {
      return timeout;
    }
  }

  return null;
}

/**
 * 请求 ID 中间件（用于请求追踪）
 * 为每个请求生成唯一 ID，便于日志关联
 */
export function requestId() {
  return (req, res, next) => {
    // 从请求头获取请求 ID（如果有）
    const incomingId = req.headers['x-request-id'];
    const requestId = incomingId || generateRequestId();

    // 设置请求 ID
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    // 添加到日志上下文
    req.logger = {
      debug: (msg, meta = {}) => logger.debug(msg, { ...meta, requestId }),
      info: (msg, meta = {}) => logger.info(msg, { ...meta, requestId }),
      warn: (msg, meta = {}) => logger.warn(msg, { ...meta, requestId }),
      error: (msg, meta = {}) => logger.error(msg, { ...meta, requestId }),
    };

    next();
  };
}

/**
 * 生成请求 ID
 */
function generateRequestId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `req_${timestamp}_${random}`;
}

/**
 * 请求 ID 中间件（用于请求追踪）
 * 为每个请求生成唯一 ID，便于日志关联。
 *
 * CO-34：原 requestTimeout/ROUTE_TIMEOUTS 死代码已删除（从未挂载，超时策略由
 * 客户端 AbortSignal.timeout 与反向代理承担）。
 */

import { logger } from '../utils/logger.js';

/**
 * 请求 ID 中间件
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

/**
 * 结构化日志模块
 * 
 * 功能：
 * 1. 分级日志（debug, info, warn, error）
 * 2. 结构化输出（JSON格式）
 * 3. 请求日志中间件
 * 4. 错误日志收集
 * 5. 文件持久化（生产环境）
 */

import { createWriteStream, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || LOG_LEVELS.info;

// 日志文件传输（生产环境）
let logStream = null;
const logFilePath = process.env.LOG_FILE || join(__dirname, '../../logs/clipsync.log');

if (process.env.NODE_ENV === 'production') {
  try {
    const { mkdirSync } = await import('fs');
    const logDir = join(__dirname, '../../logs');
    mkdirSync(logDir, { recursive: true });
    
    logStream = createWriteStream(logFilePath, { flags: 'a' });
    logStream.on('error', (err) => {
      console.error('[Logger] Failed to write to log file:', err.message);
    });
  } catch (err) {
    console.error('[Logger] Failed to initialize log file:', err.message);
  }
}

/**
 * 格式化日志消息
 */
function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...meta,
  };

  return JSON.stringify(logEntry);
}

/**
 * 脱敏处理（防止敏感信息泄露）
 */
function sanitizeLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const sensitiveFields = ['password', 'token', 'secret', 'authorization', 'phone', 'email'];
  const sanitized = { ...obj };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      if (field === 'phone') {
        // 手机号脱敏：138****5678
        sanitized[field] = sanitized[field].replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
      } else {
        sanitized[field] = '***';
      }
    }
  }
  
  return sanitized;
}

/**
 * 写入日志（控制台 + 文件）
 */
function writeLog(level, message, meta = {}) {
  const formatted = formatLog(level, message, meta);
  
  // 控制台输出
  switch (level) {
    case 'debug':
      console.debug(formatted);
      break;
    case 'info':
      console.info(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'error':
      console.error(formatted);
      break;
  }
  
  // 文件输出（生产环境）
  if (logStream) {
    const sanitized = sanitizeLog(JSON.parse(formatted));
    logStream.write(JSON.stringify(sanitized) + '\n');
  }
}

/**
 * 日志器
 */
export const logger = {
  debug(message, meta = {}) {
    if (currentLevel <= LOG_LEVELS.debug) {
      writeLog('debug', message, meta);
    }
  },

  info(message, meta = {}) {
    if (currentLevel <= LOG_LEVELS.info) {
      writeLog('info', message, meta);
    }
  },

  warn(message, meta = {}) {
    if (currentLevel <= LOG_LEVELS.warn) {
      writeLog('warn', message, meta);
    }
  },

  error(message, meta = {}) {
    if (currentLevel <= LOG_LEVELS.error) {
      writeLog('error', message, meta);
    }
  },
};

/**
 * HTTP 请求日志中间件
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, url, ip } = req;

  // 记录请求开始
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    logger[level]('HTTP Request', {
      method,
      url,
      statusCode,
      duration: `${duration}ms`,
      ip: ip || req.headers['x-forwarded-for'] || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    });
  });

  next();
}

/**
 * 错误日志中间件
 */
export function errorLogger(err, req, res, next) {
  logger.error('Unhandled Error', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    method: req.method,
    url: req.url,
  });

  next(err);
}

/**
 * WebSocket 日志
 */
export const wsLogger = {
  connect(userId, deviceId) {
    logger.info('WebSocket Connect', { userId, deviceId });
  },

  disconnect(userId, deviceId) {
    logger.info('WebSocket Disconnect', { userId, deviceId });
  },

  message(userId, deviceId, type) {
    logger.debug('WebSocket Message', { userId, deviceId, type });
  },

  error(userId, deviceId, error) {
    logger.error('WebSocket Error', { userId, deviceId, error: error.message || error });
  },

  broadcast(userId, type, recipientCount) {
    logger.debug('WebSocket Broadcast', { userId, type, recipientCount });
  },
};

/**
 * 安全日志（用于审计）
 */
export const securityLogger = {
  loginSuccess(phone, userId) {
    logger.info('Login Success', { phone, userId });
  },

  loginFailed(phone, reason) {
    logger.warn('Login Failed', { phone, reason });
  },

  rateLimited(key, limit) {
    logger.warn('Rate Limited', { key, limit });
  },

  unauthorizedAccess(path, ip) {
    logger.warn('Unauthorized Access', { path, ip });
  },

  invalidInput(path, field, reason) {
    logger.warn('Invalid Input', { path, field, reason });
  },
};

export default {
  logger,
  requestLogger,
  errorLogger,
  wsLogger,
  securityLogger,
};

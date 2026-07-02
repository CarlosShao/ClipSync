import crypto from 'crypto';
import { storeCsrfToken, getCsrfToken, deleteCsrfToken } from '../utils/redis-client.js';

// 使用console代替logger，避免依赖问题
const logger = {
  debug: (msg, data) => console.debug(`[CSRF] ${msg}`, data),
  warn: (msg, data) => console.warn(`[CSRF] ${msg}`, data),
  info: (msg, data) => console.info(`[CSRF] ${msg}`, data),
  error: (msg, data) => console.error(`[CSRF] ${msg}`, data),
};

// CSRF令牌存储（生产环境使用Redis，开发环境使用内存）
const useRedis = process.env.NODE_ENV === 'production';

// 内存回退方案（当Redis不可用时）
const memoryCsrfTokens = new Map();

// 生成CSRF令牌（异步，支持Redis）
export async function generateCsrfToken(userId, sessionId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24小时过期
  
  const tokenData = {
    userId,
    sessionId,
    expiresAt,
    createdAt: Date.now()
  };
  
  if (useRedis) {
    try {
      await storeCsrfToken(token, tokenData);
    } catch (err) {
      logger.error('Failed to store CSRF token in Redis, falling back to memory', err);
      // 回退到内存
      memoryCsrfTokens.set(token, tokenData);
    }
  } else {
    memoryCsrfTokens.set(token, tokenData);
  }
  
  logger.debug('CSRF token generated', { userId, sessionId });
  return token;
}

// 验证CSRF令牌（异步，支持Redis）
export async function validateCsrfToken(token, userId, sessionId) {
  if (!token) {
    logger.warn('CSRF token missing');
    return false;
  }
  
  let tokenData = null;
  
  if (useRedis) {
    try {
      tokenData = await getCsrfToken(token);
    } catch (err) {
      logger.error('Failed to get CSRF token from Redis, falling back to memory', err);
      // 回退到内存
      tokenData = memoryCsrfTokens.get(token);
    }
  } else {
    tokenData = memoryCsrfTokens.get(token);
  }
  
  if (!tokenData) {
    logger.warn('CSRF token not found', { 
      token: typeof token === 'string' ? token.substring(0, 10) + '...' : String(token) 
    });
    return false;
  }
  
  // 检查是否过期
  if (Date.now() > tokenData.expiresAt) {
    if (useRedis) {
      try {
        await deleteCsrfToken(token);
      } catch (err) {
        logger.error('Failed to delete expired CSRF token from Redis', err);
      }
    } else {
      memoryCsrfTokens.delete(token);
    }
    logger.warn('CSRF token expired', { token: token.substring(0, 10) + '...' });
    return false;
  }
  
  // 检查用户ID是否匹配
  if (tokenData.userId !== userId) {
    logger.warn('CSRF token user mismatch', { 
      tokenUserId: tokenData.userId, 
      requestUserId: userId 
    });
    return false;
  }
  
  // 检查会话ID是否匹配（如果提供了）
  if (sessionId && tokenData.sessionId !== sessionId) {
    logger.warn('CSRF token session mismatch');
    return false;
  }
  
  // 使用后删除令牌（单次使用）
  if (useRedis) {
    try {
      await deleteCsrfToken(token);
    } catch (err) {
      logger.error('Failed to delete used CSRF token from Redis', err);
    }
  } else {
    memoryCsrfTokens.delete(token);
  }
  
  logger.debug('CSRF token validated successfully', { userId });
  return true;
}

// 清理过期令牌（仅内存模式需要，Redis TTL会自动清理）
function cleanupExpiredTokens() {
  if (useRedis) {
    // Redis TTL 会自动清理，无需手动清理
    return;
  }
  
  const now = Date.now();
  let cleaned = 0;
  
  for (const [token, data] of memoryCsrfTokens.entries()) {
    if (now > data.expiresAt) {
      memoryCsrfTokens.delete(token);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug('Cleaned up expired CSRF tokens', { count: cleaned });
  }
}

// CSRF保护中间件（异步）
export async function csrfProtection(req, res, next) {
  // 测试环境跳过CSRF检查
  if (process.env.NODE_ENV === 'test') {
    return next();
  }
  
  // 跳过GET、HEAD、OPTIONS请求（这些是安全的）
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // 🔑 关键修复：使用 Bearer JWT Token 的请求不需要 CSRF 保护
  // CSRF 攻击只对 Cookie 认证有效（浏览器自动发送 Cookie）。
  // Bearer Token 必须由 JS 显式添加到 header，跨站页面无法做到。
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return next();
  }
  
  // 从请求头或查询参数获取CSRF令牌
  const csrfToken = req.headers['x-csrf-token'] || 
                   (req.query && req.query.csrf_token) ||
                   (req.body && req.body._csrf);
  
  // 从认证信息获取用户ID
  const userId = req.userId || req.user?.userId || req.user?.id;
  const sessionId = req.sessionID || req.headers['x-session-id'];
  
  if (!userId) {
    // 如果没有用户ID，跳过CSRF检查（可能是未认证请求）
    return next();
  }
  
  const isValid = await validateCsrfToken(csrfToken, userId, sessionId);
  
  if (!isValid) {
    logger.warn('CSRF validation failed', { 
      userId, 
      path: req.path,
      method: req.method 
    });
    
    return res.status(403).json({ 
      error: 'Invalid or expired CSRF token',
      code: 'CSRF_INVALID'
    });
  }
  
  next();
}

// 获取CSRF令牌端点（异步）
export async function handleGetCsrfToken(req, res) {
  const userId = req.userId || req.user?.userId || req.user?.id;
  const sessionId = req.sessionID || req.headers['x-session-id'];
  
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const token = await generateCsrfToken(userId, sessionId);
  
  res.json({
    csrfToken: token,
    expiresIn: 24 * 60 * 60 // 24小时（秒）
  });
}

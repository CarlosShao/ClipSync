import jwt from 'jsonwebtoken';
import config from '../config.js';

export function authenticateToken(req, res, next) {
  // 测试环境跳过token验证，使用测试用户
  if (process.env.NODE_ENV === 'test') {
    req.user = {
      userId: '00000000-0000-0000-0000-000000000001', // 测试用户ID
      phone: '13900999999',
      sessionId: 'test-session-id',
    };
    req.userId = req.user.userId;
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    
    // 读取sessionId（用于会话管理）
    if (decoded.sessionId) {
      req.user.sessionId = decoded.sessionId;
    }
    
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token', detail: err.message });
  }
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
  } catch {
    // Token invalid, continue without auth
  }
  next();
}

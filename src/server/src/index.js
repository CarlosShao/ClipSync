import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import Redis from 'redis';
import { getRedisClient } from './middleware/rateLimiter.js';
import config from './config.js';
import { setupWebSocket, gracefulShutdown as gracefulShutdownWs } from './ws/server.js';
import { authenticateToken } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { metricsMiddleware, getMetrics, getPrometheusMetrics } from './middleware/metrics.js';
import { requestLogger, errorLogger, logger } from './utils/logger.js';
import { requestTimeout, requestId } from './middleware/request-timeout.js';
import authRoutes from './routes/auth.js';
import authVerifyRoutes from './routes/auth-verify.js';
import authPasswordRoutes from './routes/auth-password.js';
import authProfileRoutes from './routes/auth-profile.js';
import authSessionRoutes from './routes/auth-session.js';
import deviceRoutes, { pairingRouter } from './routes/device.js';
import clipboardRoutes from './routes/clipboard.js';
import mediaRoutes from './routes/media.js';
import syncRoutes from './routes/sync.js';
import { startCleanupScheduler } from './db/cleanup.js';
import pool from './db/pool.js';
import { csrfProtection, handleGetCsrfToken } from './middleware/csrf.js';
import chunkedUploadRoutes from './routes/chunked-upload.js';
import versionRoutes from './routes/versions.js';
import appRoutes from './routes/app.js';
import { subscriptionCheck, requireFeature, checkDeviceLimit, checkClipboardLimit, checkFileSizeLimit } from './middleware/subscriptionCheck.js';
import sessionRoutes from './routes/sessions.js';
import notificationRoutes from './routes/notifications.js';
import subscriptionRoutes from './routes/subscriptions.js';
import paymentRoutes from './routes/payments.js';
import invoiceRoutes from './routes/invoices.js';
import { enableQueryMonitoring, getSlowQueries, getPoolStatus } from './utils/query-monitor.js';
import { memoryMonitor } from './utils/db-retry.js';
import metricsRoutes from './routes/metrics.js';

const app = express();
const server = createServer(app);

// ============================================
// Security Headers
// ============================================
app.use((req, res, next) => {
  // 防止点击劫持
  res.setHeader('X-Frame-Options', 'DENY');
  // 防止MIME类型嗅探
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS保护
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // 引用策略
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 权限策略
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP（防XSS和数据注入）
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  // HSTS（生产环境启用）
  if (config.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ============================================
// Request ID（请求追踪）
// ============================================
app.use(requestId());

// ============================================
// CORS Configuration (must be BEFORE any API routes)
// ============================================
const corsOptions = {
  origin: function (origin, callback) {
    // 开发环境允许所有来源
    if (config.nodeEnv === 'development') {
      return callback(null, true);
    }

    // 生产环境：白名单
    const allowedOrigins = (config.cors?.origins || '').split(',').filter(Boolean);
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-csrf-token', 'x-csrf-token-v2'],
  // 开发环境用短缓存，避免改了配置后浏览器还缓存旧的失败结果
  maxAge: config.nodeEnv === 'development' ? 10 : 86400,
};
app.use(cors(corsOptions));

// ============================================
// CSRF Protection - placed after authenticateToken for protected routes
// ============================================

// CSRF令牌获取端点（必须在CORS中间件之后）
app.get('/api/csrf-token', authenticateToken, handleGetCsrfToken);

// ============================================
// Raw Body Saver (for webhook signature verification)
// ============================================
// 保存原始请求体用于Webhook签名验证（如Stripe）
app.use((req, res, next) => {
  if (req.path.includes('/webhooks/') || req.headers['stripe-signature']) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks).toString('utf8');
      next();
    });
  } else {
    next();
  }
});

// ============================================
// Body Parser with size limits
// ============================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// Disable X-Powered-By
app.disable('x-powered-by');

// ============================================
// Request Timeout Middleware
// ============================================
// 所有请求超时设置（防止挂起请求消耗资源）
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000; // 默认30秒

app.use((req, res, next) => {
  // 设置请求超时
  req.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      logger.warn('Request timeout', {
        path: req.path,
        method: req.method,
        timeout: REQUEST_TIMEOUT,
      });
      res.status(408).json({ error: 'Request timeout' });
    }
    req.destroy();
  });

  // 响应超时（如果请求处理时间超过限制）
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.warn('Response timeout', {
        path: req.path,
        method: req.method,
      });
      res.status(408).json({ error: 'Response timeout' });
    }
  }, REQUEST_TIMEOUT);

  res.on('finish', () => {
    clearTimeout(timeout);
  });

  next();
});

// ============================================
// Request Logging
// ============================================
// app.use(requestLogger);
app.use(metricsMiddleware);

// ============================================
// Memory Monitor (内存使用监控)
// ============================================
app.use(memoryMonitor);

// ============================================
// Response Compression（响应压缩 - 减少带宽占用）
// ============================================
app.use(compression({
  filter: (req, res) => {
    // 不压缩 WebSocket 升级请求
    if (req.headers['upgrade']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // 仅压缩大于 1KB 的响应
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Static Files (Terms of Service, Privacy Policy)
// ============================================
app.use(express.static(path.join(__dirname, '../../views')));

// ============================================
// Health Check（增强版 - 符合 Kubernetes 标准）
// ============================================
// 存活探针（Liveness Probe）：检查进程是否崩溃，总是返回 200
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 就绪探针（Readiness Probe）：检查依赖是否可用
app.get('/api/ready', async (req, res) => {
  const checks = {
    database: false,
    redis: false,
    filesystem: false,
  };

  const details = {};

  // 1. 检查数据库
  try {
    await pool.query('SELECT 1');
    checks.database = true;
    details.database = 'connected';
  } catch (err) {
    details.database = `error: ${err.message}`;
  }

  // 2. 检查 Redis (reuse existing client)
  if (process.env.REDIS_HOST) {
    try {
      const client = await getRedisClient();
      if (client) {
        const pong = await client.ping();
        checks.redis = true;
        details.redis = 'connected';
      } else {
        details.redis = 'client not available';
      }
    } catch (err) {
      details.redis = `error: ${err.message}`;
    }
  } else {
    checks.redis = true; // Redis 未配置，视为通过
    details.redis = 'not configured';
  }

  // 3. 检查文件系统（上传目录）
  try {
    const fs = await import('fs/promises');
    await fs.access(config.upload.dir, fs.constants.W_OK);
    checks.filesystem = true;
    details.filesystem = 'writable';
  } catch (err) {
    details.filesystem = `error: ${err.message}`;
  }

  // 判断是否就绪
  const isReady = Object.values(checks).every(v => v === true);
  const statusCode = isReady ? 200 : 503;

  res.status(statusCode).json({
    status: isReady ? 'ready' : 'not ready',
    timestamp: new Date().toISOString(),
    checks,
    details,
  });
});

// ============================================
// Metrics (JSON + Prometheus)
// ============================================
app.get('/api/metrics', (req, res) => {
  res.json(getMetrics());
});

app.get('/api/metrics/prometheus', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(getPrometheusMetrics());
});

// ============================================
// Admin API（慢查询、连接池状态）
// ============================================
app.get('/api/admin/slow-queries', authenticateToken, async (req, res) => {
  // ✅ Red Team 修复 P0-4: 管理员权限检查
  // 方案：检查 users.is_admin 字段（需在数据库中 ALTER TABLE ADD COLUMN is_admin BOOLEAN DEFAULT FALSE）
  // 临时方案：检查 JWT 中的管理员声明（需手动设置 JWT secret 为特定值）
  // 生产环境建议使用专门的管理员认证中间件
  try {
    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.userId]);
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch (err) {
    logger.error('Admin check failed:', { error: err.message });
    return res.status(500).json({ error: 'Admin check failed' });
  }
  try {
    const limit = parseInt(req.query.limit) || 20;
    const minTime = parseInt(req.query.minTime) || 1000;
    const slowQueries = await getSlowQueries(limit, minTime);
    const poolStatus = await getPoolStatus();

    res.json({
      slowQueries,
      poolStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to get slow queries:', { error: err.message });
    res.status(500).json({ error: 'Failed to get slow queries' });
  }
});

// ============================================
// API Routes（全局速率限制）
// ============================================
app.use('/api/auth', authRoutes);
app.use('/api/auth', authVerifyRoutes);
app.use('/api/auth', authPasswordRoutes);
app.use('/api/auth', authProfileRoutes);
app.use('/api/auth', authSessionRoutes);
// 二维码扫码配对：init 需登录(Bearer)，redeem 匿名(扫码设备无 token) → 独立挂载，不挂全局 authenticateToken/csrf
// 必须注册在下方认证版 /api/devices 之前，否则匿名 redeem 会被全局 authenticateToken 拦截返回 401
app.use('/api/devices', apiLimiter, pairingRouter);

app.use('/api/devices', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, checkDeviceLimit, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, deviceRoutes);
app.use('/api/clipboard', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, clipboardRoutes);
app.use('/api/media', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, mediaRoutes);
app.use('/api/sync', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, syncRoutes);

app.use('/api/upload', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, chunkedUploadRoutes);

app.use('/api/versions', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, versionRoutes);

app.use('/api/app', apiLimiter, appRoutes);

// 会话管理路由
app.use('/api/sessions', authenticateToken, sessionRoutes);

// 通知偏好路由
app.use('/api/notifications', authenticateToken, notificationRoutes);

// 订阅管理路由
app.use('/api/subscriptions', apiLimiter, subscriptionRoutes);

// 支付管理路由
app.use('/api/payments', apiLimiter, authenticateToken, csrfProtection, paymentRoutes);

// 发票管理路由
app.use('/api/invoices', apiLimiter, authenticateToken, csrfProtection, invoiceRoutes);

// ============================================
// 404 Handler
// ============================================
app.use((req, res) => {
  logger.warn('404 Not Found', { method: req.method, url: req.url, ip: req.ip });
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================
// Error Handler
// ============================================
app.use(errorLogger);
app.use((err, req, res, next) => {
  // CORS错误
  if (err.message === 'CORS not allowed') {
    return res.status(403).json({ error: 'CORS request rejected' });
  }

  // JSON解析错误
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  // 请求体过大
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  // 其他错误
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
  });
});

// ============================================
// Setup WebSocket & Start Server (skip in test environment)
// ============================================
let wss = null;
if (process.env.NODE_ENV !== 'test') {
  wss = setupWebSocket(server);

  server.listen(config.port, config.host, () => {
    logger.info('ClipSync Server started', {
      version: '0.3.0',
      host: config.host,
      port: config.port,
      env: config.nodeEnv,
      pid: process.pid,
    });

    logger.info(`
  ╔══════════════════════════════════════════╗
  ║          ClipSync Server v0.2.0          ║
  ╠══════════════════════════════════════════╣
  ║  HTTP:  http://${config.host}:${config.port}          ║
  ║  WS:    ws://${config.host}:${config.port}/ws          ║
  ║  Env:   ${config.nodeEnv.padEnd(27)}║
  ╚══════════════════════════════════════════╝
    `);

    // Start periodic cleanup of expired items
    startCleanupScheduler();

    // 启用查询性能监控（非生产环境或明确启用时）
    if (config.nodeEnv !== 'production' || process.env.ENABLE_QUERY_MONITORING === 'true') {
      enableQueryMonitoring();
    }
  });
}

// ============================================
// Graceful Shutdown（增强版）
// ============================================
async function gracefulShutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // 1. 停止接受新连接
  server.close(() => {
    logger.info('HTTP server closed (no longer accepting connections)');
  });

  // 2. 通知所有 WebSocket 客户端准备重连
  try {
    await gracefulShutdownWs(10000); // 等待 10 秒让客户端重连
  } catch (err) {
    logger.warn('WebSocket graceful shutdown error:', { error: err.message });
  }

  // 3. 关闭 WebSocket 服务器
  wss.close(() => {
    logger.info('WebSocket server closed');
  });

  // 4. 关闭数据库连接池
  try {
    await pool.end();
    logger.info('Database pool closed');
  } catch (err) {
    logger.error('Error closing database pool:', { error: err.message });
  }

  // 5. 关闭 Redis 连接
  try {
    const { closeRedisClient } = await import('./utils/redis-client.js');
    await closeRedisClient();
    logger.info('Redis client closed');
  } catch (err) {
    logger.error('Error closing Redis client:', { error: err.message });
  }

  // 6. 关闭 WebSocket Redis Pub/Sub
  try {
    const { closeWsRedisPubSub } = await import('./ws/ws-redis-pubsub.js');
    await closeWsRedisPubSub();
    logger.info('WebSocket Redis Pub/Sub closed');
  } catch (err) {
    logger.error('Error closing WebSocket Redis Pub/Sub:', { error: err.message });
  }

  logger.info('Graceful shutdown complete, exiting...');
  process.exit(0);

  // 强制退出（10秒超时）
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获异常处理
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', {
    message: err.message,
    stack: err.stack,
  });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', {
    reason: reason?.toString() || reason,
  });
});

export { app, server };

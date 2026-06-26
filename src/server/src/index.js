import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { setupWebSocket } from './ws/server.js';
import { authenticateToken } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { metricsMiddleware, getMetrics, getPrometheusMetrics } from './middleware/metrics.js';
import { requestLogger, errorLogger, logger } from './utils/logger.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/device.js';
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
  // HSTS（生产环境启用）
  if (config.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ============================================
// CSRF Protection - placed after authenticateToken for protected routes
// ============================================

// CSRF令牌获取端点
app.get('/api/csrf-token', authenticateToken, handleGetCsrfToken);

// ============================================
// CORS Configuration
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400, // 预检请求缓存24小时
};
app.use(cors(corsOptions));

// ============================================
// Body Parser with size limits
// ============================================
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

// Disable X-Powered-By
app.disable('x-powered-by');

// ============================================
// Request Logging
// ============================================
// app.use(requestLogger);
app.use(metricsMiddleware);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Static Files (Terms of Service, Privacy Policy)
// ============================================
app.use(express.static(path.join(__dirname, '../../views')));

// ============================================
// Health Check（增强版）
// ============================================
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    version: '0.3.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: 'unknown',
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      },
    },
  };

  // 检查数据库连接
  try {
    await pool.query('SELECT 1');
    health.checks.database = 'ok';
  } catch (err) {
    health.checks.database = 'error';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
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
// API Routes（全局速率限制）
// ============================================
app.use('/api/auth', authRoutes);
app.use('/api/devices', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, checkDeviceLimit, (req, res, next) => {
  req.userId = req.user.userId;
  next();
}, deviceRoutes);
app.use('/api/clipboard', apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, checkClipboardLimit, (req, res, next) => {
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
app.use('/api/subscriptions', apiLimiter, authenticateToken, csrfProtection, subscriptionRoutes);

// 支付管理路由
app.use('/api/payments', apiLimiter, authenticateToken, csrfProtection, paymentRoutes);

// 发票管理路由
app.use('/api/invoices', apiLimiter, authenticateToken, csrfProtection, invoiceRoutes);

// ============================================
// 404 Handler
// ============================================
app.use((req, res) => {
  logger.warn('404 Not Found', { method: req.method, url: req.url, ip: req.ip });
  res.status(404).json({ error: '接口不存在' });
});

// ============================================
// Error Handler
// ============================================
app.use(errorLogger);
app.use((err, req, res, next) => {
  // CORS错误
  if (err.message === 'CORS not allowed') {
    return res.status(403).json({ error: '跨域请求被拒绝' });
  }

  // JSON解析错误
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体JSON格式无效' });
  }

  // 请求体过大
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }

  // 其他错误
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: config.nodeEnv === 'production' ? '服务器内部错误' : err.message,
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

    console.log(`
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
  });
}

// ============================================
// Graceful Shutdown
// ============================================
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // 停止接受新连接
  server.close(() => {
    logger.info('HTTP server closed');

    // 关闭WebSocket
    wss.close(() => {
      logger.info('WebSocket server closed');

      // 关闭数据库连接池
      pool.end(() => {
        logger.info('Database pool closed');
        process.exit(0);
      });
    });
  });

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

import { Router } from 'express';
import { logger } from './logger.js';

/**
 * 路由配置
 * 定义路由文件、路径前缀和中间件
 */
const routeConfigs = [
  // 认证相关路由
  { path: '/api/auth', file: './routes/auth.js' },
  { path: '/api/auth', file: './routes/auth-verify.js' },
  { path: '/api/auth', file: './routes/auth-password.js' },
  { path: '/api/auth', file: './routes/auth-profile.js' },
  { path: '/api/auth', file: './routes/auth-session.js' },

  // 核心功能路由
  { path: '/api/devices', file: './routes/device.js' },
  { path: '/api/clipboard', file: './routes/clipboard.js' },
  { path: '/api/media', file: './routes/media.js' },
  { path: '/api/sync', file: './routes/sync.js' },
  { path: '/api/upload', file: './routes/chunked-upload.js' },
  { path: '/api/versions', file: './routes/versions.js' },

  // 业务功能路由
  { path: '/api/app', file: './routes/app.js' },
  { path: '/api/sessions', file: './routes/sessions.js' },
  { path: '/api/notifications', file: './routes/notifications.js' },
  { path: '/api/subscriptions', file: './routes/subscriptions.js' },
  { path: '/api/payments', file: './routes/payments.js' },
  { path: '/api/invoices', file: './routes/invoices.js' },
  { path: '/api/metrics', file: './routes/metrics.js' },
];

/**
 * 动态加载路由模块
 * @param {string} filePath - 路由文件路径
 * @returns {Promise<Router>} Express Router
 */
async function loadRouteModule(filePath) {
  try {
    const module = await import(filePath);
    return module.default || module;
  } catch (err) {
    logger.error(`Failed to load route module: ${filePath}`, { error: err.message });
    return null;
  }
}

/**
 * 注册路由到 Express 应用
 * @param {Express} app - Express 应用实例
 * @param {Object} options - 配置选项
 * @param {Object} options.middlewares - 中间件映射
 * @param {boolean} options.enableLogging - 是否启用日志
 */
export async function registerRoutes(app, options = {}) {
  const { middlewares = {}, enableLogging = true } = options;

  let registeredCount = 0;
  let failedCount = 0;

  for (const config of routeConfigs) {
    try {
      const router = await loadRouteModule(config.file);

      if (!router) {
        failedCount++;
        continue;
      }

      // 获取中间件
      const routeMiddlewares = middlewares[config.path] || [];

      // 注册路由
      app.use(config.path, ...routeMiddlewares, router);

      registeredCount++;

      if (enableLogging) {
        logger.debug(`Registered route: ${config.path} -> ${config.file}`);
      }
    } catch (err) {
      failedCount++;
      logger.error(`Failed to register route: ${config.path}`, {
        file: config.file,
        error: err.message
      });
    }
  }

  logger.info(`Route registration completed: ${registeredCount} registered, ${failedCount} failed`);

  return { registeredCount, failedCount };
}

/**
 * 创建路由中间件映射
 * @param {Object} commonMiddlewares - 通用中间件
 * @returns {Object} 中间件映射
 */
export function createMiddlewareMap(commonMiddlewares = {}) {
  const {
    apiLimiter,
    authenticateToken,
    csrfProtection,
    subscriptionCheck,
    checkDeviceLimit,
    checkClipboardLimit,
  } = commonMiddlewares;

  return {
    // 需要认证的路由
    '/api/devices': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, checkDeviceLimit],
    '/api/clipboard': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck, checkClipboardLimit],
    '/api/media': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck],
    '/api/sync': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck],
    '/api/upload': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck],
    '/api/versions': [apiLimiter, authenticateToken, csrfProtection, subscriptionCheck],
    '/api/sessions': [authenticateToken],
    '/api/notifications': [authenticateToken],
    '/api/subscriptions': [apiLimiter, authenticateToken, csrfProtection],
    '/api/payments': [apiLimiter, authenticateToken, csrfProtection],
    '/api/invoices': [apiLimiter, authenticateToken, csrfProtection],
    '/api/metrics': [authenticateToken],

    // 不需要认证的路由
    '/api/auth': [],
    '/api/app': [],
  };
}

/**
 * 注册健康检查和系统路由
 * @param {Express} app - Express 应用实例
 */
export function registerSystemRoutes(app) {
  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '0.2.0',
    });
  });

  // 就绪检查
  app.get('/api/ready', async (req, res) => {
    try {
      // 检查数据库连接
      const { default: pool } = await import('../db/pool.js');
      await pool.query('SELECT 1');

      res.json({
        status: 'ready',
        services: {
          database: 'connected',
          redis: 'connected', // 可以添加实际检查
        }
      });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        error: err.message,
      });
    }
  });

  logger.debug('System routes registered');
}

export default {
  registerRoutes,
  createMiddlewareMap,
  registerSystemRoutes,
  routeConfigs,
};

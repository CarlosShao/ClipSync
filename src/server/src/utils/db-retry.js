/**
 * 数据库重试工具
 * 
 * 功能：
 * 1. 数据库连接失败时自动重试
 * 2. 指数退避策略
 * 3. 最大重试次数限制
 */

import { logger } from './logger.js';

/**
 * 执行数据库查询（带重试）
 * @param {Object} pool - 数据库连接池
 * @param {string} query - SQL 查询
 * @param {Array} params - 查询参数
 * @param {Object} options - 选项
 * @param {number} options.maxRetries - 最大重试次数（默认 3）
 * @param {number} options.baseDelay - 基础延迟（毫秒，默认 100）
 * @param {number} options.maxDelay - 最大延迟（毫秒，默认 5000）
 * @returns {Promise<Object>} 查询结果
 */
export async function executeWithRetry(pool, query, params = [], options = {}) {
  const { maxRetries = 3, baseDelay = 100, maxDelay = 5000 } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.query(query, params);
      return result;
    } catch (err) {
      lastError = err;

      // 判断是否可重试错误
      const isRetryable = isRetryableError(err);

      if (!isRetryable || attempt === maxRetries) {
        // 不可重试错误或已达最大重试次数
        throw err;
      }

      // 计算延迟（指数退避 + 抖动）
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * 0.2 * (Math.random() - 0.5); // ±20% 抖动
      const actualDelay = Math.floor(delay + jitter);

      logger.warn('Database query failed, retrying...', {
        attempt: attempt + 1,
        maxRetries,
        delay: actualDelay,
        error: err.message,
        query: query.substring(0, 100),
      });

      // 等待后重试
      await sleep(actualDelay);
    }
  }

  throw lastError;
}

/**
 * 判断是否为可重试错误
 * @param {Error} err - 错误对象
 * @returns {boolean} 是否可重试
 */
function isRetryableError(err) {
  const retryableCodes = [
    'ECONNREFUSED',   // 连接被拒绝
    'ETIMEDOUT',       // 连接超时
    'ECONNRESET',      // 连接重置
    '57P03',           // PostgreSQL: cannot connect now
    '08006',           // PostgreSQL: connection failure
    '08001',           // PostgreSQL: unable to establish connection
    '08004',           // PostgreSQL: server rejected connection
  ];

  const retryableMessages = [
    'connection terminated',
    'client has encountered a connection error',
    'Connection terminated unexpectedly',
  ];

  // 检查错误码
  if (err.code && retryableCodes.includes(err.code)) {
    return true;
  }

  // 检查错误消息
  if (err.message && retryableMessages.some(msg => err.message.includes(msg))) {
    return true;
  }

  return false;
}

/**
 * 睡眠函数
 * @param {number} ms - 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取内存使用情况（用于监控）
 * @returns {Object} 内存使用信息
 */
export function getMemoryUsage() {
  const memUsage = process.memoryUsage();

  return {
    rss: formatBytes(memUsage.rss),           // 常驻内存
    heapTotal: formatBytes(memUsage.heapTotal), // 堆总大小
    heapUsed: formatBytes(memUsage.heapUsed),   // 堆已使用
    external: formatBytes(memUsage.external),    // 外部内存
    arrayBuffers: formatBytes(memUsage.arrayBuffers), // ArrayBuffer
    heapUsedPercent: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(2) + '%',
    timestamp: new Date().toISOString(),
  };
}

/**
 * 格式化字节数
 * @param {number} bytes - 字节数
 * @returns {string} 格式化字符串
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 内存使用监控中间件
 * 如果内存使用超过阈值，记录警告日志
 */
let lastMemoryWarning = 0;
const MEMORY_WARNING_INTERVAL = 60000; // 最少 1 分钟警告一次
const HEAP_USAGE_THRESHOLD = 0.85; // 堆使用率超过 85% 时警告

export function memoryMonitor(req, res, next) {
  // 每 100 个请求检查一次内存
  if (Math.random() < 0.01) {
    const memUsage = process.memoryUsage();
    const heapUsagePercent = memUsage.heapUsed / memUsage.heapTotal;

    if (heapUsagePercent > HEAP_USAGE_THRESHOLD) {
      const now = Date.now();
      if (now - lastMemoryWarning > MEMORY_WARNING_INTERVAL) {
        logger.warn('High memory usage detected', getMemoryUsage());
        lastMemoryWarning = now;

        // 如果堆使用率超过 95%，建议 GC
        if (heapUsagePercent > 0.95 && global.gc) {
          logger.info('Triggering garbage collection');
          global.gc();
        }
      }
    }
  }

  next();
}

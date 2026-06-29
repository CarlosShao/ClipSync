import pg from 'pg';
import config from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: parseInt(process.env.DB_POOL_MAX) || 20,                      // 最大连接数（可配置）
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,     // 空闲连接超时（30秒）
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT) || 2000, // 连接超时（2秒）
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000,          // 查询超时（30秒）
  keepAlive: true,               // 保持连接活跃
  // 注意：statement_timeout 不在 Pool 配置中，移到 connect 事件中
});

// 错误计数（用于稳定性判断）
let consecutiveDbErrors = 0;
const MAX_DB_ERRORS = 10;

pool.on('error', (err) => {
  consecutiveDbErrors++;
  logger.error('Unexpected error on idle client', {
    message: err.message,
    consecutiveErrors: consecutiveDbErrors
  });
  
  // 超过阈值，优雅退出（触发 gracefulShutdown）
  if (consecutiveDbErrors >= MAX_DB_ERRORS) {
    logger.error('Too many consecutive DB errors, shutting down gracefully');
    process.kill(process.pid, 'SIGTERM');
  }
});

// 成功连接时重置计数
pool.on('connect', (client) => {
  consecutiveDbErrors = 0;
  
  // 设置会话级超时（防止慢查询占用连接）
  // 测试环境禁用（避免干扰测试）
  if (process.env.NODE_ENV !== 'test') {
    client.query('SET SESSION statement_timeout = 30000'); // 30秒
  }
});

export default pool;

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
  max: parseInt(process.env.DB_POOL_MAX) || 50,                      // 最大连接数（可配置，默认 50，P3 修复）
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,     // 空闲连接超时（30秒）
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT) || 2000, // 连接超时（2秒）
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000,          // 查询超时（30秒）
  keepAlive: true,               // 保持连接活跃
  // 注意：statement_timeout 不在 Pool 配置中，移到 connect 事件中
});

// 连接级错误不应杀死进程（H4 修复）：短暂的 DB 抖动若触发全实例自杀会造成整体不可用。
// 改为只记录告警，依赖 pg Pool 自动重建连接；真正的持续故障交给编排器（k8s/docker）重启。
pool.on('error', (err) => {
  logger.error('[db] Unexpected error on idle client (auto-recovering):', {
    message: err.message,
  });
});

pool.on('connect', (client) => {
  // 设置会话级超时（防止慢查询占用连接）
  // 测试环境禁用（避免干扰测试）
  if (process.env.NODE_ENV !== 'test') {
    client.query('SET SESSION statement_timeout = 30000'); // 30秒
  }
});

export default pool;
export { pool };

/**
 * 查询性能监控工具
 * 
 * 功能：
 * 1. 监控 PostgreSQL 慢查询（通过 pg_stat_statements）
 * 2. 记录慢查询日志
 * 3. 提供慢查询分析报告接口
 */

import pool from '../db/pool.js';
import { logger } from './logger.js';

// 慢查询阈值（毫秒）
const SLOW_QUERY_THRESHOLD = 1000; // 1 秒

/**
 * 初始化查询性能监控
 * 需要在 PostgreSQL 中启用 pg_stat_statements 扩展
 */
export async function initQueryMonitoring() {
  try {
    // 检查 pg_stat_statements 是否已启用
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      );
    `);

    if (!result.rows[0].exists) {
      logger.warn('[QueryMonitor] pg_stat_statements extension not installed. Slow query monitoring disabled.');
      return false;
    }

    logger.info('[QueryMonitor] Query performance monitoring initialized');
    return true;
  } catch (err) {
    logger.error('[QueryMonitor] Failed to initialize:', { error: err.message });
    return false;
  }
}

/**
 * 获取慢查询列表
 * @param {number} limit - 返回前 N 条慢查询
 * @param {number} minTime - 最小执行时间（毫秒）
 * @returns {Promise<Array>} 慢查询列表
 */
export async function getSlowQueries(limit = 20, minTime = SLOW_QUERY_THRESHOLD) {
  try {
    const result = await pool.query(`
      SELECT 
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        rows,
        100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent
      FROM pg_stat_statements 
      WHERE mean_exec_time > $1
      ORDER BY mean_exec_time DESC
      LIMIT $2
    `, [minTime, limit]);

    return result.rows.map(row => ({
      query: row.query.substring(0, 200) + (row.query.length > 200 ? '...' : ''),
      calls: parseInt(row.calls),
      totalExecTime: parseFloat(row.total_exec_time).toFixed(2) + ' ms',
      meanExecTime: parseFloat(row.mean_exec_time).toFixed(2) + ' ms',
      rows: parseInt(row.rows),
      hitPercent: row.hit_percent ? parseFloat(row.hit_percent).toFixed(2) + '%' : 'N/A',
    }));
  } catch (err) {
    logger.error('[QueryMonitor] Failed to get slow queries:', { error: err.message });
    return [];
  }
}

/**
 * 重置查询统计（谨慎使用）
 */
export async function resetQueryStats() {
  try {
    await pool.query('SELECT pg_stat_statements_reset()');
    logger.info('[QueryMonitor] Query statistics reset');
    return true;
  } catch (err) {
    logger.error('[QueryMonitor] Failed to reset query stats:', { error: err.message });
    return false;
  }
}

/**
 * 获取数据库连接池状态
 */
export async function getPoolStatus() {
  try {
    const result = await pool.query(`
      SELECT 
        count(*) as total_connections,
        count(*) FILTER (WHERE state = 'active') as active_connections,
        count(*) FILTER (WHERE state = 'idle') as idle_connections,
        count(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction
      FROM pg_stat_activity 
      WHERE datname = current_database()
    `);

    return {
      total: parseInt(result.rows[0].total_connections),
      active: parseInt(result.rows[0].active_connections),
      idle: parseInt(result.rows[0].idle_connections),
      idleInTransaction: parseInt(result.rows[0].idle_in_transaction),
      poolSize: pool.totalCount,
      idlePool: pool.idleCount,
    };
  } catch (err) {
    logger.error('[QueryMonitor] Failed to get pool status:', { error: err.message });
    return null;
  }
}

/**
 * 查询性能中间件（记录慢查询）
 * 包装 pool.query 以监控查询执行时间
 */
let monitoringEnabled = false;

export function enableQueryMonitoring() {
  if (monitoringEnabled) return;

  const originalQuery = pool.query.bind(pool);

  pool.query = async (...args) => {
    const start = Date.now();
    try {
      const result = await originalQuery(...args);
      const duration = Date.now() - start;

      if (duration > SLOW_QUERY_THRESHOLD) {
        logger.warn('[QueryMonitor] Slow query detected', {
          duration: duration + 'ms',
          query: args[0]?.substring?.(0, 200) || 'unknown',
          params: args[1]?.slice?.(0, 5) || [],
        });
      }

      return result;
    } catch (err) {
      const duration = Date.now() - start;
      logger.error('[QueryMonitor] Query error', {
        duration: duration + 'ms',
        error: err.message,
        query: args[0]?.substring?.(0, 200) || 'unknown',
      });
      throw err;
    }
  };

  monitoringEnabled = true;
  logger.info('[QueryMonitor] Query monitoring enabled (slow query threshold: ' + SLOW_QUERY_THRESHOLD + 'ms)');
}

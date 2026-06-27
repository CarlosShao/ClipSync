/**
 * 健康检查路由（生产环境必需）
 * 
 * GET /api/health - 存活探针（Liveness Probe）
 * GET /api/ready - 就绪探针（Readiness Probe）
 */

import pool from '../db/pool.js';
import Redis from 'redis';
import config from '../config.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * 存活探针（Liveness Probe）
 * Kubernetes/Docker 用于检测进程是否崩溃
 * 此端点应始终返回 200（除非进程崩溃）
 */
export async function healthCheck(req, res) {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

/**
 * 就绪探针（Readiness Probe）
 * Kubernetes/Docker 用于检测实例是否准备好接收流量
 * 检查依赖是否可用（数据库、Redis、文件系统）
 */
export async function readyCheck(req, res) {
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

  // 2. 检查 Redis
  if (process.env.REDIS_HOST) {
    try {
      const client = Redis.createClient({
        url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
        password: process.env.REDIS_PASSWORD || undefined,
      });
      await client.connect();
      const pong = await client.ping();
      await client.quit();
      
      checks.redis = true;
      details.redis = 'connected';
    } catch (err) {
      details.redis = `error: ${err.message}`;
    }
  } else {
    checks.redis = true; // Redis 未配置，视为通过
    details.redis = 'not configured';
  }

  // 3. 检查文件系统（上传目录）
  try {
    const uploadDir = config.upload.dir || './uploads';
    await fs.access(uploadDir, fs.constants.W_OK);
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
}

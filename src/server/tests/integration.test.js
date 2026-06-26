import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pool from '../src/db/pool.js';
import Redis from 'redis';

describe('集成测试环境', () => {
  let redisClient;

  beforeAll(async () => {
    // 复用应用已有的数据库连接池（避免创建多余连接）
    // 验证数据库可用
    await pool.query('SELECT NOW()');

    // 连接 Redis（使用测试环境配置）
    redisClient = Redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
      password: process.env.REDIS_PASSWORD || undefined,
    });

    await redisClient.connect();
  });

  afterAll(async () => {
    if (redisClient) await redisClient.disconnect();
    // 注意：不关闭 pool，它由 index.js 的 gracefulShutdown 管理
  });

  it('应该能连接到PostgreSQL数据库', async () => {
    const result = await pool.query('SELECT NOW()');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].now).toBeDefined();
  });

  it('应该能连接到Redis', async () => {
    const pong = await redisClient.ping();
    expect(pong).toBe('PONG');
  });

  it('应该能查询用户表', async () => {
    const result = await pool.query('SELECT * FROM users LIMIT 1');
    expect(result.rows).toBeDefined();
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('应该能查询设备表', async () => {
    const result = await pool.query('SELECT * FROM devices LIMIT 1');
    expect(result.rows).toBeDefined();
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('应该能查询剪贴板项目表', async () => {
    const result = await pool.query('SELECT * FROM clipboard_items LIMIT 1');
    expect(result.rows).toBeDefined();
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('应该能执行Redis操作', async () => {
    await redisClient.set('test_key', 'test_value');
    const value = await redisClient.get('test_key');
    expect(value).toBe('test_value');
    await redisClient.del('test_key');
  });

  it('应该能执行数据库事务', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 插入测试用户
      const userResult = await client.query(
        "INSERT INTO users (phone, password_hash, nickname, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id",
        ['13800138000', 'test_hash', '事务测试用户']
      );

      expect(userResult.rows).toHaveLength(1);
      expect(userResult.rows[0].id).toBeDefined();

      await client.query('COMMIT');

      // 验证插入成功
      const verifyResult = await pool.query('SELECT id FROM users WHERE phone = $1', ['13800138000']);
      expect(verifyResult.rows).toHaveLength(1);

      // 清理测试数据（按外键顺序）
      await pool.query('DELETE FROM clipboard_items WHERE user_id = $1', [userResult.rows[0].id]);
      await pool.query('DELETE FROM devices WHERE user_id = $1', [userResult.rows[0].id]);
      await pool.query('DELETE FROM users WHERE phone = $1', ['13800138000']);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});

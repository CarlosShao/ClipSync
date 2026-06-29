import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pool from '../src/db/pool.js';
import Redis from 'redis';
import config from '../src/config.js';

describe('集成测试环境', () => {
  let redisClient;

  beforeAll(async () => {
    await pool.query('SELECT NOW()');
    
    redisClient = Redis.createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
      },
      password: config.redis.password || undefined,
    });
    
    await redisClient.connect();
  });

  afterAll(async () => {
    if (redisClient) await redisClient.disconnect();
  });

  it('应该能连接到PostgreSQL数据库', async () => {
    const result = await pool.query('SELECT NOW()');
    expect(result.rows).toHaveLength(1);
  });

  it('应该能连接到Redis', async () => {
    const pong = await redisClient.ping();
    expect(pong).toBe('PONG');
  });

  it('应该能查询用户表', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0);
  });

  it('应该能查询设备表', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM devices');
    expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0);
  });

  it('应该能查询剪贴板项目表', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM clipboard_items');
    expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0);
  });

  it('应该能执行Redis操作', async () => {
    await redisClient.set('test_key', 'test_value');
    const value = await redisClient.get('test_key');
    expect(value).toBe('test_value');
    await redisClient.del('test_key');
  });

  it('应该能执行数据库事务', async () => {
    const client = await pool.connect();
    // 使用较短的测试电话号码（不超过20字符）
    const testPhone = `138${Date.now().toString().slice(-8)}`;
    
    try {
      await client.query('BEGIN');
      
      const userResult = await client.query(
        'INSERT INTO users (phone, password_hash, nickname, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id',
        [testPhone, 'test_hash', 'test']
      );
      
      expect(userResult.rows).toHaveLength(1);
      const userId = userResult.rows[0].id;
      
      await client.query('COMMIT');
      
      // 验证插入成功
      const verifyResult = await client.query('SELECT id FROM users WHERE phone = $1', [testPhone]);
      expect(verifyResult.rows).toHaveLength(1);
      
      // 清理
      await client.query('DELETE FROM users WHERE phone = $1', [testPhone]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});

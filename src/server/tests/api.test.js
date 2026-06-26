import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import pool from '../src/db/pool.js';
import config from '../src/config.js';

let testUserId;
let testDeviceId;

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.warn('Database not available, skipping API tests');
    return;
  }
});

afterAll(async () => {
  if (testUserId) {
    await pool.query('DELETE FROM clipboard_items WHERE user_id = $1', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM devices WHERE user_id = $1', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

describe('Database Schema', () => {
  it('should have required tables', async () => {
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const tableNames = tables.rows.map(r => r.table_name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('devices');
    expect(tableNames).toContain('clipboard_items');
    expect(tableNames).toContain('verification_codes');
    expect(tableNames).toContain('device_sync_state');
  });

  it('should have correct columns in clipboard_items', async () => {
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'clipboard_items'
      ORDER BY ordinal_position
    `);

    const colNames = columns.rows.map(r => r.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('source_device_id');
    expect(colNames).toContain('content_type');
    expect(colNames).toContain('content_encrypted');
    expect(colNames).toContain('content_preview');
    expect(colNames).toContain('content_size');
    expect(colNames).toContain('is_favorite');
    expect(colNames).toContain('metadata');
    expect(colNames).toContain('created_at');
  });

  it('should have correct columns in users', async () => {
    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);

    const colNames = columns.rows.map(r => r.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('phone');
    expect(colNames).toContain('nickname');
    expect(colNames).toContain('avatar_url');
    expect(colNames).toContain('created_at');
  });

  it('should have correct columns in devices', async () => {
    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'devices'
      ORDER BY ordinal_position
    `);

    const colNames = columns.rows.map(r => r.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('device_name');
    expect(colNames).toContain('device_type');
    expect(colNames).toContain('platform');
    expect(colNames).toContain('is_online');
    expect(colNames).toContain('last_seen_at');
  });
});

describe('JWT Authentication', () => {
  it('should generate valid JWT token', () => {
    const payload = { userId: 'test-user-123', phone: '13800138000' };
    const token = jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' });

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const decoded = jwt.verify(token, config.jwt.secret);
    expect(decoded.userId).toBe('test-user-123');
    expect(decoded.phone).toBe('13800138000');
  });

  it('should reject invalid token', () => {
    expect(() => {
      jwt.verify('invalid-token', config.jwt.secret);
    }).toThrow();
  });

  it('should reject token with wrong secret', () => {
    const token = jwt.sign({ userId: 'test' }, 'wrong-secret');
    expect(() => {
      jwt.verify(token, config.jwt.secret);
    }).toThrow();
  });

  it('should include expiration in token', () => {
    const token = jwt.sign({ userId: 'test' }, config.jwt.secret, { expiresIn: '1h' });
    const decoded = jwt.verify(token, config.jwt.secret);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });
});

describe('Rate Limiter Module', () => {
  it('should export rate limiter middleware', async () => {
    const mod = await import('../src/middleware/rateLimiter.js');
    expect(typeof mod.apiLimiter).toBe('function');
  });
});

describe('Logger Module', () => {
  it('should export logger with required methods', async () => {
    const { logger } = await import('../src/utils/logger.js');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });
});

describe('WebSocket Module', () => {
  it('should export required functions', async () => {
    const { broadcastToUser, hasOnlineDevices, getOnlineDeviceCount } = await import('../src/ws/server.js');
    expect(typeof broadcastToUser).toBe('function');
    expect(typeof hasOnlineDevices).toBe('function');
    expect(typeof getOnlineDeviceCount).toBe('function');
  });
});

describe('Cleanup Scheduler', () => {
  it('should export startCleanupScheduler', async () => {
    const { startCleanupScheduler } = await import('../src/db/cleanup.js');
    expect(typeof startCleanupScheduler).toBe('function');
  });
});

describe('Config Module', () => {
  it('should load config correctly', async () => {
    const { default: cfg } = await import('../src/config.js');
    expect(cfg.port).toBeDefined();
    expect(cfg.db).toBeDefined();
    expect(cfg.jwt).toBeDefined();
    expect(cfg.jwt.secret).toBeDefined();
  });
});

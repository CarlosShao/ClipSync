import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pool from '../src/db/pool.js';
import config from '../src/config.js';
import jwt from 'jsonwebtoken';

describe('Subscription API - Database Tests', () => {
  let testUserId;
  let testDeviceId;

  beforeAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM user_subscriptions WHERE user_id IN (SELECT id FROM users WHERE phone LIKE \'+86138%\')');
    await pool.query('DELETE FROM payment_orders WHERE user_id IN (SELECT id FROM users WHERE phone LIKE \'+86138%\')');
    await pool.query('DELETE FROM clipboard_items WHERE user_id IN (SELECT id FROM users WHERE phone LIKE \'+86138%\')');
    await pool.query('DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE phone LIKE \'+86138%\')');
    await pool.query('DELETE FROM users WHERE phone LIKE \'+86138%\'');

    // 创建测试用户
    const res = await pool.query(`
      INSERT INTO users (phone, nickname)
      VALUES ('+8613812345678', 'Test User')
      RETURNING id
    `);
    testUserId = res.rows[0].id;

    // 创建测试设备
    const devRes = await pool.query(`
      INSERT INTO devices (user_id, device_name, platform, device_type, app_version)
      VALUES ($1, 'Test Device', 'windows', 'desktop', '1.0.0')
      RETURNING id
    `, [testUserId]);
    testDeviceId = devRes.rows[0].id;
  });

  afterAll(async () => {
    // 清理测试数据
    if (testUserId) {
      await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [testUserId]).catch(() => {});

      await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [testUserId]).catch(() => {});
      await pool.query('DELETE FROM clipboard_items WHERE user_id = $1', [testUserId]).catch(() => {});
      await pool.query('DELETE FROM devices WHERE user_id = $1', [testUserId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  describe('Subscription Plans', () => {
    it('should have subscription_plans table', async () => {
      const res = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'subscription_plans'
      `);
      expect(res.rows.length).toBe(1);
    });

    it('should have default subscription plans', async () => {
      const res = await pool.query(`
        SELECT * FROM subscription_plans WHERE is_active = true
      `);
      expect(res.rows.length).toBeGreaterThan(0);
    });
  });

  describe('User Subscriptions', () => {
    it('should have user_subscriptions table', async () => {
      const res = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_subscriptions'
      `);
      expect(res.rows.length).toBe(1);
    });

    it('should create subscription with encrypted token', async () => {
      // 获取一个套餐
      const planRes = await pool.query(`
        SELECT id FROM subscription_plans WHERE is_active = true LIMIT 1
      `);

      if (planRes.rows.length > 0) {
        const planId = planRes.rows[0].id;

        const res = await pool.query(`
          INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle, subscription_token_encrypted)
          VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 month', NOW(), NOW() + INTERVAL '1 month', 'monthly', 'encrypted_token_test')
          RETURNING id, status
        `, [testUserId, planId]);

        expect(res.rows.length).toBe(1);
        expect(res.rows[0].status).toBe('active');
      }
    });
  });

  describe('Payment Orders', () => {
    it('should have payment_orders table', async () => {
      const res = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'payment_orders'
      `);
      expect(res.rows.length).toBe(1);
    });

    it('should create payment order with encrypted token', async () => {
      // 获取一个套餐
      const planRes = await pool.query(`
        SELECT id FROM subscription_plans WHERE is_active = true LIMIT 1
      `);

      if (planRes.rows.length > 0) {
        const planId = planRes.rows[0].id;

        // 先创建一个订阅
        const subRes = await pool.query(`
          INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle)
          VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 month', NOW(), NOW() + INTERVAL '1 month', 'monthly')
          RETURNING id
        `, [testUserId, planId]);

        const subscriptionId = subRes.rows[0].id;

        const res = await pool.query(`
          INSERT INTO payment_orders (user_id, plan_id, order_no, amount, currency, payment_method, status, payment_token_encrypted)
          VALUES ($1, $2, 'TEST_ORDER_001', 9.99, 'CNY', 'wechat', 'pending', 'encrypted_payment_token')
          RETURNING id, status
        `, [testUserId, planId]);

        expect(res.rows.length).toBe(1);
        expect(res.rows[0].status).toBe('pending');
      }
    });
  });

  describe('Encryption Fields', () => {
    it('should have phone_encrypted field in users table', async () => {
      const res = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'phone_encrypted'
      `);
      expect(res.rows.length).toBe(1);
    });

    it('should have email_encrypted field in users table', async () => {
      const res = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'email_encrypted'
      `);
      expect(res.rows.length).toBe(1);
    });

    it('should have encryption_keys table', async () => {
      const res = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'encryption_keys'
      `);
      expect(res.rows.length).toBe(1);
    });
  });
});

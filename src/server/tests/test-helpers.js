/**
 * 测试专用工具库
 *
 * 核心设计：
 * 1. 数据库事务隔离 - 每个测试在独立事务中运行，afterEach ROLLBACK，零清理成本
 * 2. 顺序执行 - vitest.config.js 已设置 maxThreads:1，测试不并行
 * 3. 统一 app 实例 - 避免重复创建 WebSocket Server
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ============================================
// 数据库事务隔离
// ============================================

/**
 * 为测试提供专用数据库连接 + 事务支持
 *
 * 用法：
 *   const { client, pool } = await getTestDb();
 *   await client.query('BEGIN');
 *   // 使用 client.query(...) 执行所有数据库操作
 *   await client.query('ROLLBACK');  // afterEach 里回滚
 *   client.release();
 *
 * 注意：必须使用 client（专用连接）而不是 pool（连接池）来执行事务内的查询
 */
export async function getTestDb() {
  const pool = (await import('../src/db/pool.js')).default;
  const client = await pool.connect();
  return { client, pool };
}

/**
 * 在事务内执行测试函数的辅助包装器
 * 自动处理 BEGIN / ROLLBACK / client.release
 *
 * 用法：
 *   it('测试名称', async () => {
 *     await withTransaction(async ({ client, pool }) => {
 *       await client.query(`INSERT INTO users ...`);
 *       const res = await client.query(`SELECT * FROM users`);
 *       expect(res.rows).toHaveLength(1);
 *     });
 *   });
 */
export async function withTransaction(testFn) {
  const pool = (await import('../src/db/pool.js')).default;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await testFn({ client, pool });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ============================================
// 测试数据工厂（使用 client 而非 pool）
// ============================================

/**
 * 确保测试用户存在（使用专用连接）
 */
export async function ensureTestUser(client, phone, extras = {}) {
  const result = await client.query(`
    INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [phone, 'test_hash', extras.nickname || `test_${phone}`]);
  return result.rows[0].id;
}

/**
 * 创建测试设备
 */
export async function createTestDevice(client, userId, deviceName = '测试设备', options = {}) {
  const result = await client.query(`
    INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, is_online, created_at, last_seen_at)
    VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
    RETURNING id
  `, [
    userId,
    deviceName,
    options.deviceType || 'mobile',
    options.platform || 'ios',
    options.platformVersion || '1.0.0'
  ]);
  return result.rows[0].id;
}

/**
 * 创建剪贴板测试数据
 */
export async function createTestClipboardItem(client, userId, sourceDeviceId, content = '测试内容') {
  const result = await client.query(`
    INSERT INTO clipboard_items (
      user_id, source_device_id,
      content_type, content_encrypted, content_preview, content_size,
      metadata, is_favorite, created_at, updated_at
    ) VALUES ($1, $2, 'text', $3, $4, LENGTH($5), $6, false, NOW(), NOW())
    RETURNING id
  `, [
    userId,
    sourceDeviceId,
    content,  // content_encrypted - 测试环境直接存明文
    content.substring(0, 50),
    content,
    JSON.stringify({})
  ]);
  return result.rows[0].id;
}

/**
 * 清理指定手机号的所有测试数据（用于 afterAll）
 * 只清理指定手机号，不影响其他测试文件
 */
export async function cleanupTestData(pool, phone) {
  const userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (userResult.rows.length === 0) return;
  const userId = userResult.rows[0].id;

  // 按外键依赖顺序删除（只用实际存在的表）
  // device_sync_state 通过 device_id 关联，需要先查 devices
  try {
    await pool.query(`DELETE FROM device_sync_state WHERE device_id IN (SELECT id FROM devices WHERE user_id = $1)`, [userId]);
  } catch (e) {
    console.warn(`清理表 device_sync_state 失败: ${e.message}`);
  }

  for (const table of ['file_versions', 'clipboard_items', 'devices']) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    } catch (e) {
      console.warn(`清理表 ${table} 失败: ${e.message}`);
    }
  }

  try {
    await pool.query('DELETE FROM verification_codes WHERE phone = $1', [phone]);
  } catch (e) {
    console.warn(`清理表 verification_codes 失败: ${e.message}`);
  }

  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  } catch (e) {
    console.warn(`清理表 users 失败: ${e.message}`);
  }
}

// ============================================
// Express App 单例（避免重复创建 WebSocket Server）
// ============================================

let _cachedApp = null;
let _cachedServer = null;

/**
 * 获取测试用 Express app 单例
 * 第一次调用时加载 index.js，后续调用返回缓存实例
 */
export async function getTestApp() {
  if (_cachedApp) return { app: _cachedApp, server: _cachedServer };

  // 动态导入，让 index.js 的副作用只执行一次
  const mod = await import('../src/index.js');
  _cachedApp = mod.app;
  _cachedServer = mod.server;
  return { app: _cachedApp, server: _cachedServer };
}

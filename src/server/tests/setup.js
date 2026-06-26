import { beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载测试环境变量
dotenv.config({ path: path.join(__dirname, '../.env.test') });

let _pool = null;

// 全局测试设置 - 只执行一次
beforeAll(async () => {
  console.log('🧪 测试环境初始化...');

  // 预加载数据库连接池，确保连接可用
  const { default: pool } = await import('../src/db/pool.js');
  _pool = pool;

  // 验证数据库连接
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ 数据库连接正常');
  } catch (err) {
    console.error('❌ 数据库连接失败:', err.message);
    throw err;
  }

  // 清理可能残留的旧测试数据
  try {
    await pool.query(`DELETE FROM users WHERE phone LIKE '13800%' OR phone LIKE '13900%'`);
    console.log('✅ 旧测试数据已清理');
  } catch (err) {
    // 表可能不存在，忽略清理错误
    console.warn('⚠️ 测试数据清理跳过:', err.message);
  }
});

afterAll(async () => {
  console.log('🧪 测试环境清理...');

  // 关闭所有残留的 WebSocket 连接（避免进程无法退出）
  try {
    const { connections } = await import('../src/ws/server.js');
    for (const [userId, userDevices] of connections) {
      for (const [deviceId, ws] of userDevices) {
        try { ws.terminate(); } catch (_) {}
      }
    }
    connections.clear();
  } catch (_) {}

  // 数据库连接池不在此关闭（由 index.js 的 gracefulShutdown 处理）
  console.log('✅ 测试环境已清理');
});

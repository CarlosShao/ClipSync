import { beforeAll, afterAll, beforeEach } from 'vitest';
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
  //
  // ⚠ 删除顺序是正确性的一部分（P0-C/C1 暴露）：clipboard_items 上挂着
  //   AFTER DELETE 触发器 fn_clipboard_deletion_tombstone，它向 clipboard_deletions
  //   写入 (user_id, item_id) 墓碑行。直接 `DELETE FROM users …` 时，PG 级联删到
  //   clipboard_items 会触发该触发器，而它引用的 user_id 正是**同一语句里正在被删除**的用户
  //   ⇒ clipboard_deletions_user_id_fkey 立即报 23503 ⇒ 整条清理语句回滚。
  //   旧写法把这个错误 catch 成一行 warn，于是清理从此静默失效，
  //   上一轮运行的 users/devices 行留在库里（表现：tests/performance.test.js
  //   撞 devices_user_id_device_name_key 唯一约束）。
  //   先把候选用户的下游行按外键安全顺序删掉（此刻 users 行仍在，墓碑外键成立），再删 users。
  //   注意候选集只含「13800…/13900…」这种用例自己造的手机号（feature-flags 的 13800990002 亦在其中，
  //   它本就是每轮现注册的），种子账号 028 超管是 13505… 前缀，不在删除范围内。
  try {
    const targets = `SELECT id FROM users WHERE phone LIKE '13800%' OR phone LIKE '13900%'`;
    // refund_requests.reviewed_by / system_configs.updated_by 是 NO ACTION，会卡住 users 删除
    await pool.query(`DELETE FROM refund_requests WHERE user_id IN (${targets})`);
    await pool.query(`DELETE FROM file_versions WHERE user_id IN (${targets})`);
    // clipboard_items 的删除会写墓碑，必须在 users 之前
    const items = await pool.query(`DELETE FROM clipboard_items WHERE user_id IN (${targets})`);
    const users = await pool.query(
      `DELETE FROM users WHERE phone LIKE '13800%' OR phone LIKE '13900%'`
    );
    console.log(`✅ 旧测试数据已清理（clipboard_items ${items.rowCount} 行 / users ${users.rowCount} 行）`);
  } catch (err) {
    // 表可能不存在，忽略清理错误
    console.warn('⚠️ 测试数据清理跳过:', err.message);
  }
});

// P0-C/C1：限流器不再有 NODE_ENV==='test' 旁路，测试隔离改为「清零计数」而非「关掉中间件」。
// 用例之间清干净历史窗口（等价于各文件 beforeEach 里的 resetRateLimit('api')），
// 用例之内阈值真实生效——tests/auth-s0-security.test.js 与
// tests/middleware/runtime-limits.test.js 仍能在单个用例内打出真 429。
beforeEach(async () => {
  const { resetAllRateLimitStores } = await import('../src/middleware/rateLimiter.js');
  resetAllRateLimitStores();
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

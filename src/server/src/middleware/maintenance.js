// =============================================
// 维护模式强制中间件（方案三 WP-B · CO-20）
//
// 数据源：system_configs.maintenance_mode（'on' / 'off' 字符串 JSONB，
// 由管理台 PATCH /api/admin/configs/maintenance_mode 写入）。
//
// 生效链路：
//   1. 管理台写库后调用 invalidateMaintenanceCache()（configs.js PATCH 成功回调）
//      并向全部客户端广播 WS `maintenance.updated`；
//   2. maintenanceGuard 挂载在同步写链路（/api/clipboard、/api/sync、/api/media、
//      /api/upload、/api/ws）上，mode==='on' 时返回 503；
//   3. WS upgrade 本体（/ws）不经 Express 中间件链，由 ws/server.js 在 connection
//      握手入口调用 isMaintenanceOn() 检查（仅握手时查一次，非逐消息），维护中
//      ws.close(4003, 'Maintenance mode') 拒绝连接；
//   4. 白名单（不在上述覆盖范围）：/api/auth/*、/api/admin/*、/api/health、
//      /api/ready、/api/app/*、/api/metrics —— 登录、管理台与健康检查不受影响。
//
// 缓存策略：进程内 5s TTL（与 featureFlags.js 同款）。读库失败时放行并 warn
// —— 维护基础设施故障不应扩大故障面（fail-open，与限流的 fail-closed 方向相反）。
// =============================================

import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

const MAINTENANCE_TTL_MS = 5000;
let cache = { mode: null, at: 0 };

/** 归一化 JSONB config_value → 'on' | 'off'（未知/空值一律视为 off） */
function normalizeMode(raw) {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === 'on' || v === 'true' ? 'on' : 'off';
  }
  return 'off';
}

/** 读取 maintenance_mode（带 5s 进程内缓存）；缺行/缺表时视为 'off' */
export async function readMaintenanceMode() {
  const now = Date.now();
  if (cache.mode && now - cache.at < MAINTENANCE_TTL_MS) return cache.mode;
  const { rows } = await pool.query(
    `SELECT config_value FROM system_configs WHERE config_key = 'maintenance_mode'`
  );
  const mode = rows.length > 0 ? normalizeMode(rows[0].config_value) : 'off';
  cache = { mode, at: now };
  return mode;
}

/** 维护模式是否开启（读库失败按关闭处理，不阻塞业务） */
export async function isMaintenanceOn() {
  try {
    return (await readMaintenanceMode()) === 'on';
  } catch (err) {
    logger.warn('[maintenance] read failed, treating as off', { error: err.message });
    return false;
  }
}

/** 管理台写库后调用：立刻失效本进程缓存，下次读取直连库 */
export function invalidateMaintenanceCache() {
  cache = { mode: null, at: 0 };
}

/**
 * Express 中间件：维护开启时拦截请求。
 * 响应契约（CO-20）：503 { code: 5030, message, maintenance: true }
 * —— 客户端据 maintenance:true 显示维护横幅并暂停自动同步。
 */
export async function maintenanceGuard(req, res, next) {
  let on = false;
  try {
    on = await isMaintenanceOn();
  } catch (err) {
    // isMaintenanceOn 内部已兜底为 false，这里仅防御性放行
    logger.warn('[maintenance] guard read failed, allowing request', { error: err.message });
  }
  if (on) {
    return res.status(503).json({
      code: 5030,
      message: '系统维护中，请稍后重试',
      maintenance: true,
    });
  }
  return next();
}

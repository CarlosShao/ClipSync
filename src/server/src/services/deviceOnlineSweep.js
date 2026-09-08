import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

// ============================================
// AF-50 设备在线状态定时扫描（deviceOnlineSweep）
//
// 背景：devices.is_online 此前只有两条维护路径——
//   1. WS register（ws/server.js）→ is_online=true；
//   2. WS close 处理器 → is_online=false。
// close 处理器依赖进程存活：docker restart / kill / 崩溃 / OOM 等
// 非优雅退出时不会逐连接执行，is_online 残留 true（实测：桌面端
// last_seen_at 停在服务端重启时刻、is_online 长期为 t）；反向场景
// （客户端从未连上 WS）也没有任何基于 last_seen_at 的兜底纠正，
// 审计实测 4 台全 false、看板在线设备恒 0 即由此而来。
//
// 本扫描每 60s 将「仍标记在线但心跳超时」的设备置为离线：
//   UPDATE devices SET is_online=false
//   WHERE is_online=true AND last_seen_at < NOW() - interval
// 阈值读 system_configs.device_offline_timeout_minutes（迁移 056，
// 管理台可改），缺省/非法值回退 5 分钟。
// ============================================

const SWEEP_INTERVAL_MS = 60 * 1000;
const CONFIG_KEY = 'device_offline_timeout_minutes';
const DEFAULT_TIMEOUT_MINUTES = 5;

/** 解析 system_configs 中的阈值（JSONB：PATCH 落 to_jsonb(text) 恒为字符串）→ 正整数分钟，非法回退默认值 */
async function resolveTimeoutMinutes() {
  try {
    const { rows } = await pool.query(
      'SELECT config_value FROM system_configs WHERE config_key = $1',
      [CONFIG_KEY]
    );
    const raw = rows[0]?.config_value;
    const n =
      typeof raw === 'number' ? raw
      : typeof raw === 'string' ? parseInt(raw, 10)
      : NaN;
    if (Number.isFinite(n) && n > 0) return n;
    if (raw !== undefined && raw !== null) {
      logger.warn('[device-sweep] invalid timeout config, fallback to default', {
        key: CONFIG_KEY,
        raw: String(raw),
        fallback: DEFAULT_TIMEOUT_MINUTES,
      });
    }
  } catch (err) {
    logger.error('[device-sweep] failed to read timeout config, fallback to default', {
      error: err.message,
      fallback: DEFAULT_TIMEOUT_MINUTES,
    });
  }
  return DEFAULT_TIMEOUT_MINUTES;
}

/**
 * 执行一轮离线扫描：心跳超过阈值的「在线」设备置为离线。
 * 不回写 last_seen_at（该列语义为最后一次真实心跳时间，保留原值）。
 * @returns {{ swept: boolean, offlineCount: number }} swept=false 表示本轮因错误跳过
 */
export async function runDeviceOnlineSweep() {
  try {
    const timeoutMinutes = await resolveTimeoutMinutes();
    const { rows } = await pool.query(
      `UPDATE devices
       SET is_online = FALSE
       WHERE is_online = TRUE
         AND last_seen_at < NOW() - ($1 || ' minutes')::interval
       RETURNING id`,
      [String(timeoutMinutes)]
    );
    if (rows.length > 0) {
      logger.info('[device-sweep] marked stale devices offline', {
        count: rows.length,
        timeoutMinutes,
      });
    }
    return { swept: true, offlineCount: rows.length };
  } catch (err) {
    logger.error('[device-sweep] sweep failed', { error: err.message });
    return { swept: false, offlineCount: 0 };
  }
}

let sweepTimer = null;

/**
 * 启动设备离线扫描调度器（应用启动时调用一次）。
 * 每 60s 一轮；timer.unref() 不阻止进程退出。
 * 返回周期 timer（测试/运维可 clearInterval）。
 */
export function startDeviceOnlineSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    runDeviceOnlineSweep();
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  logger.info('[device-sweep] scheduler started', { intervalMs: SWEEP_INTERVAL_MS });
  return sweepTimer;
}

/** 停止扫描调度器（graceful shutdown 时调用），幂等。 */
export function stopDeviceOnlineSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info('[device-sweep] scheduler stopped');
  }
}

export default {
  runDeviceOnlineSweep,
  startDeviceOnlineSweep,
  stopDeviceOnlineSweep,
};

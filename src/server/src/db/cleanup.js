import pool from './pool.js';
import { logger } from '../utils/logger.js';

const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startCleanupScheduler() {
  // Run cleanup immediately, then every hour
  cleanupExpiredItems();
  setInterval(cleanupExpiredItems, CLEANUP_INTERVAL);
}

async function cleanupExpiredItems() {
  try {
    // Delete expired clipboard items
    const result = await pool.query(
      `DELETE FROM clipboard_items
       WHERE expires_at IS NOT NULL AND expires_at < NOW()
       RETURNING id`
    );

    if (result.rowCount > 0) {
      logger.info(`[Cleanup] Deleted ${result.rowCount} expired clipboard items`);
    }

    // Clean up old verification codes (older than 24 hours)
    const vcResult = await pool.query(
      `DELETE FROM verification_codes
       WHERE created_at < NOW() - INTERVAL '24 hours'
       RETURNING id`
    );

    if (vcResult.rowCount > 0) {
      logger.info(`[Cleanup] Deleted ${vcResult.rowCount} old verification codes`);
    }

    // Clean up old notification history (retention, default 90 days) —— P6 修复
    const NOTIFICATION_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_RETENTION_DAYS) || 90;
    const nhResult = await pool.query(
      `DELETE FROM notification_history
       WHERE created_at < NOW() - make_interval(days => $1)
       RETURNING id`,
      [NOTIFICATION_RETENTION_DAYS]
    );
    if (nhResult.rowCount > 0) {
      logger.info(`[Cleanup] Deleted ${nhResult.rowCount} old notification history records (retention ${NOTIFICATION_RETENTION_DAYS}d)`);
    }

    // Clean up old deletion tombstones (retention, default 30 days)
    // 墓碑仅服务于"断线窗口内删除感知"，保留 30 天足够；防止表无限增长
    const TOMBSTONE_RETENTION_DAYS = parseInt(process.env.TOMBSTONE_RETENTION_DAYS) || 30;
    const tbResult = await pool.query(
      `DELETE FROM clipboard_deletions
       WHERE deleted_at < NOW() - make_interval(days => $1)`,
      [TOMBSTONE_RETENTION_DAYS]
    );
    if (tbResult.rowCount > 0) {
      logger.info(`[Cleanup] Deleted ${tbResult.rowCount} old deletion tombstones (retention ${TOMBSTONE_RETENTION_DAYS}d)`);
    }
  } catch (err) {
    logger.error('[Cleanup] Error:', { error: err.message });
  }
}

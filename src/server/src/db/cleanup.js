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
  } catch (err) {
    logger.error('[Cleanup] Error:', { error: err.message });
  }
}

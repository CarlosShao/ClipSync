import pool from './pool.js';

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
      console.log(`[Cleanup] Deleted ${result.rowCount} expired clipboard items`);
    }

    // Clean up old verification codes (older than 24 hours)
    const vcResult = await pool.query(
      `DELETE FROM verification_codes
       WHERE created_at < NOW() - INTERVAL '24 hours'
       RETURNING id`
    );

    if (vcResult.rowCount > 0) {
      console.log(`[Cleanup] Deleted ${vcResult.rowCount} old verification codes`);
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}

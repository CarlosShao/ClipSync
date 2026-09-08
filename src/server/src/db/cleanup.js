import fs from 'fs/promises';
import path from 'path';
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

    // 审计日志先归档后删除（CO-32）：保留天数读 system_configs.audit_log_retention_days
    // （管理台系统参数卡片可调），默认 365；归档失败则跳过删除，宁可超期保留不丢数据。
    await archiveAndDeleteExpiredAuditLogs();
  } catch (err) {
    logger.error('[Cleanup] Error:', { error: err.message });
  }
}

// ───────────────────────── 审计日志归档（CO-32） ─────────────────────────

const AUDIT_ARCHIVE_DIR = path.resolve('logs', 'audit-archive');
const AUDIT_CSV_HEADER =
  'id,created_at,user_id,action,resource_type,resource_id,status,ip_address,user_agent,error_message,details';

/** 单元格转 CSV：全字段加引号，内部引号翻倍（details 为 JSON 文本，天然含逗号/引号） */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** Date → 'YYYYMMDD'（本地时区，按归档当天分文件） */
function formatArchiveDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 读 system_configs.audit_log_retention_days（JSONB 数字或字符串；非法值回退 365） */
async function readAuditRetentionDays() {
  const { rows } = await pool.query(
    `SELECT config_value FROM system_configs WHERE config_key = 'audit_log_retention_days'`
  );
  const days = parseInt(rows[0]?.config_value, 10);
  return Number.isFinite(days) && days > 0 ? days : 365;
}

/**
 * 归档并删除超期 audit_logs 行：
 *  1. 读保留天数（system_configs.audit_log_retention_days，默认 365）
 *  2. 捞出超期行 → 追加导出 CSV（logs/audit-archive/audit-YYYYMMDD.csv，logs 目录容器内已挂载）
 *  3. 按 id 精确删除已归档行（CSV 写失败时抛错 → 上层跳过删除，不丢审计数据）
 */
async function archiveAndDeleteExpiredAuditLogs() {
  let retentionDays;
  try {
    retentionDays = await readAuditRetentionDays();
  } catch (err) {
    // system_configs 不可达：跳过本轮（cleanup 整体已有 error 日志，这里补充语义）
    logger.warn('[Cleanup] audit retention read failed, skip archive this round', { error: err.message });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, created_at, user_id, action, resource_type, resource_id, status,
            ip_address::text AS ip_address, user_agent, error_message, details
     FROM audit_logs
     WHERE created_at < NOW() - make_interval(days => $1)
     ORDER BY created_at ASC`,
    [retentionDays]
  );
  if (rows.length === 0) return;

  const csvFile = path.join(AUDIT_ARCHIVE_DIR, `audit-${formatArchiveDate(new Date())}.csv`);
  const lines = rows.map((row) =>
    [
      row.id,
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      row.user_id,
      row.action,
      row.resource_type,
      row.resource_id,
      row.status,
      row.ip_address,
      row.user_agent,
      row.error_message,
      row.details == null ? '' : JSON.stringify(row.details),
    ]
      .map(csvCell)
      .join(',')
  );

  try {
    await fs.mkdir(AUDIT_ARCHIVE_DIR, { recursive: true });
    let content = lines.join('\n') + '\n';
    try {
      const existing = await fs.stat(csvFile);
      if (existing.size === 0) content = AUDIT_CSV_HEADER + '\n' + content;
    } catch {
      // 文件不存在：本文件首个数据块，写表头
      content = AUDIT_CSV_HEADER + '\n' + content;
    }
    await fs.appendFile(csvFile, content);
  } catch (err) {
    logger.error('[Cleanup] audit archive CSV write failed, skip delete', {
      file: csvFile,
      error: err.message,
    });
    return;
  }

  const ids = rows.map((r) => r.id);
  const delResult = await pool.query(`DELETE FROM audit_logs WHERE id = ANY($1)`, [ids]);
  logger.info(
    `[Cleanup] Archived ${rows.length} expired audit logs to ${csvFile} and deleted ${delResult.rowCount} rows (retention ${retentionDays}d)`
  );
}

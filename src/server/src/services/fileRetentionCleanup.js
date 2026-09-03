/**
 * 文件保留期自动清理定时任务（工单 F3.3）
 *
 * 背景：迁移 042 已为 subscription_plans 增加 file_retention_days
 * （Free=3 / Pro=30 / Enterprise=90 天）。文件条目（content_type='file'）
 * 超过其所属用户套餐保留期后，服务端应删除 DB 行 + 磁盘文件，
 * 否则 storage 配额与 uploads 磁盘只增不减。
 *
 * 调度模式（对齐 db/cleanup.js 与 utils/versionManager.js）：
 *   - 启动后延迟 5 分钟首跑（H1：给部署窗口留缓冲，避免服务启动即触发
 *     大批清理），之后每 60 分钟一轮；
 *   - timer.unref() 不阻止进程退出；
 *   - 任何异常 non-fatal：仅记日志计数，绝不抛出影响主流程。
 *
 * H1 存量保护基线：保留期语义只对功能上线后新产生的条目生效。首次运行
 * 在 file_sync_meta（极简 kv 表，服务 init 就地 CREATE TABLE IF NOT EXISTS，
 * 不依赖迁移文件）写入当前时间戳为 baseline 并跳过本轮条目清理（磁盘
 * 垃圾照常清扫）；此后仅清理 created_at >= baseline 且超保留期的条目，
 * 部署当天存量条目（旧文本正文/路径数组/落盘名三类）绝不批量删除。
 * 另：fileEncoding='text' 的条目一律跳过——历史文本正文条目字节在 DB、
 * 无磁盘文件，删了只丢数据。
 *
 * 清理口径：
 *   - 仅处理 content_type='file' 的条目；保留期 JOIN
 *     users → user_subscriptions(active, 取最新一条) → subscription_plans 读
 *     file_retention_days；无 active 订阅时兜底 Free 档（与 planLimits.js 口径一致）。
 *   - admin 不豁免：与其他用户一致按其有效套餐清理（工单倾向统一清理，
 *     避免管理员账号沦为永久存储旁路）。
 *   - 保守跳过：套餐行缺失或 file_retention_days 为 NULL / <=0 时该条目不清理。
 *   - 批删循环 DELETE ... WHERE id = ANY(本批 id)，每批 LIMIT 500，避免长事务。
 *   - 先删磁盘文件，再删 DB 行（顺序与 media.js DELETE 一致）。
 *
 * content_encrypted 三种存储形态（见 aiTools.js "存储形态" 注释）：
 *   A) data URL 内联 —— 字节在 DB，无磁盘文件，跳过 unlink；
 *   A2) 本地路径引用（JSON 数组字符串 / 裸路径）—— 字节在客户端设备，
 *       服务端无文件，跳过 unlink；
 *   B) 磁盘文件名（uuid+ext）—— uploads/files/ 下逐个 unlink。
 *   只有"安全文件名"形态才会 unlink：不含路径分隔符、非 data: 前缀、
 *   basename 归一化后等于自身，杜绝 path traversal 误删目录外文件。
 *
 * 顺带清扫两处磁盘泄漏（与 DB 无关，独立执行）：
 *   - uploads/chunks/<uploadId>/：分片上传中断遗留的遗弃目录（mtime > 24h 整目录删除；
 *     跳过 .multer-tmp 工作目录本身）；
 *   - uploads/chunks/.multer-tmp/ 与 uploads/tmp/：multer 落盘的临时文件
 *     （mtime > 24h 逐个删除；正常流程处理完会 rename/unlink，中断请求才会残留）。
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

// ── 目录常量（与 media.js / chunked-upload.js / storage.js 一致：src/server/uploads）──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_BASE = path.join(__dirname, '../../uploads');
const FILE_DIR = path.join(UPLOAD_BASE, 'files'); // file 条目落盘目录（media.js FILE_DIR）
const CHUNKS_DIR = path.join(UPLOAD_BASE, 'chunks'); // 分片上传目录（chunked-upload.js CHUNK_DIR）
const CHUNK_MULTER_TMP = path.join(CHUNKS_DIR, '.multer-tmp'); // 分片 multer 临时目录
const MEDIA_TMP_DIR = path.join(UPLOAD_BASE, 'tmp'); // media.js multer 上传临时目录

const RUN_INTERVAL = 60 * 60 * 1000; // 1 小时
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // H1：首轮延迟 5 分钟执行，降低部署窗口风险
const DELETE_BATCH = 500; // 每批删除上限，避免长事务
const ABANDONED_AGE_MS = 24 * 60 * 60 * 1000; // 磁盘遗留物判定阈值 24h
const BASELINE_KEY = 'file_retention_baseline'; // file_sync_meta 中的基线标记键

/**
 * 判断字符串是否是可安全 unlink 的"落盘文件名"。
 * 正常落盘名为 `${uuidv4()}${ext}`（media.js / chunked-upload.js），
 * 永不含路径分隔符；data URL、本地路径引用、含 .. 等一律拒绝。
 */
export function isSafeStoredFilename(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('data:') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.') &&
    path.basename(name) === name
  );
}

/**
 * 删除一个 file 条目对应的全部磁盘文件（可复用的 unlink 抽象）。
 * 覆盖：content_encrypted（B 形态落盘文件名）+ metadata.files[].fileId
 * （多文件条目契约：每个 fileId 也是 uploads/files/ 下的落盘文件名）。
 *
 * 与 media.js DELETE 一致：unlink 尽力而为，单个失败不中断、不抛出。
 *
 * @param {{contentEncrypted?: string|null, metadata?: unknown}} item
 * @returns {Promise<{deleted: number, errors: number}>}
 */
export async function deleteStoredClipFiles(item) {
  const names = new Set();

  // DB 行为 snake_case（SELECT content_encrypted）；兼容调用方传 camelCase 对象
  const main = item?.content_encrypted ?? item?.contentEncrypted;
  if (isSafeStoredFilename(main)) names.add(main);

  // 多文件条目：metadata.files[].fileId 同为 uploads/files/ 落盘文件名
  let meta = item?.metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta || '{}');
    } catch {
      meta = null;
    }
  }
  if (Array.isArray(meta?.files)) {
    for (const f of meta.files) {
      if (isSafeStoredFilename(f?.fileId)) names.add(f.fileId);
    }
  }

  let deleted = 0;
  let errors = 0;
  for (const name of names) {
    try {
      await fs.unlink(path.join(FILE_DIR, name));
      deleted++;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // 文件本就不存在（历史泄漏/已清理）：无需告警
      } else {
        errors++;
        logger.warn('[FileRetention] Failed to unlink stored file', {
          file: name,
          error: err?.message,
        });
      }
    }
  }
  return { deleted, errors };
}

/**
 * 查询 subscription_plans.file_retention_days 列是否已存在
 * （迁移 042 未跑时缺列；此时保守跳过 DB 清理，磁盘清扫照常）。
 * 每轮查一次（60min 粒度，开销可忽略），迁移补跑后自动恢复。
 */
async function hasRetentionColumn() {
  try {
    const res = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'subscription_plans'
          AND column_name = 'file_retention_days'
        LIMIT 1`
    );
    return res.rowCount > 0;
  } catch {
    return false; // 连 information_schema 都失败：保守视为缺列
  }
}

/**
 * H1（存量保护基线）：读取/初始化保留期清理基线。
 * 首次运行在 file_sync_meta 写入当前时间戳为 baseline；此后仅清理
 * created_at >= baseline 的过期条目，部署时的存量条目永不被批量删除。
 * 表结构极简（key TEXT PK, value TEXT），init 就地创建，不改迁移文件。
 *
 * @returns {Promise<Date|null>} 基线时间戳；首次运行返回刚写入的时间戳，
 *   DB 不可达等异常时返回 null（调用方保守跳过本轮条目清理）。
 */
async function ensureRetentionBaseline() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS file_sync_meta (key TEXT PRIMARY KEY, value TEXT)`
  );
  const existing = await pool.query(
    `SELECT value FROM file_sync_meta WHERE key = $1`,
    [BASELINE_KEY]
  );
  if (existing.rows.length > 0) {
    const ts = new Date(existing.rows[0].value);
    return Number.isNaN(ts.getTime()) ? null : ts;
  }
  // 首次运行：写入当前时间戳。ON CONFLICT DO UPDATE 保留先写者的原值
  // （并发双实例同时首次运行时，双方 RETURNING 拿到同一个已写入值）。
  const inserted = await pool.query(
    `INSERT INTO file_sync_meta (key, value)
     VALUES ($1, NOW()::text)
     ON CONFLICT (key) DO UPDATE SET value = file_sync_meta.value
     RETURNING value`,
    [BASELINE_KEY]
  );
  const ts = new Date(inserted.rows[0].value);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

/**
 * 查出一批超过保留期的 file 条目（不锁行，只做候选）。
 *
 * user_retention CTE：每用户取最新一条 active 订阅的套餐保留期；
 * 无 active 订阅 → sp_free 兜底 JOIN Free 行（与 planLimits.getPlanLimits 一致）。
 * 保留期为 NULL / <=0（未配置或异常配置）→ 条件不成立 → 保守跳过。
 *
 * H1 约束：
 *   - 仅候选 created_at >= baseline 的条目（基线前存量条目永不清理）；
 *   - fileEncoding='text' 的条目一律跳过（文本正文条目字节在 DB、
 *     无磁盘文件，删了只丢数据；完整转正后的多文件条目不受影响）。
 *
 * @param {number} limit 本批上限
 * @param {Date} baseline 存量保护基线（ensureRetentionBaseline 返回值）
 */
async function selectExpiredFileItems(limit, baseline) {
  const res = await pool.query(
    `WITH user_retention AS (
        SELECT DISTINCT ON (u.id)
               u.id AS user_id,
               COALESCE(sp.file_retention_days, sp_free.file_retention_days) AS retention_days
          FROM users u
          LEFT JOIN user_subscriptions us
            ON us.user_id = u.id AND us.status = 'active'
          LEFT JOIN subscription_plans sp
            ON us.plan_id = sp.id
          LEFT JOIN subscription_plans sp_free
            ON us.plan_id IS NULL AND sp_free.name = 'Free' AND sp_free.is_active = true
         ORDER BY u.id, us.created_at DESC NULLS LAST
      )
      SELECT ci.id, ci.user_id, ci.content_encrypted, ci.metadata
        FROM clipboard_items ci
        JOIN user_retention ur ON ur.user_id = ci.user_id
       WHERE ci.content_type = 'file'
         AND ur.retention_days IS NOT NULL
         AND ur.retention_days > 0
         AND ci.created_at >= $2::timestamptz
         AND (ci.metadata->>'fileEncoding') IS DISTINCT FROM 'text'
         AND ci.created_at < NOW() - make_interval(days => ur.retention_days)
       ORDER BY ci.created_at ASC
       LIMIT $1`,
    [limit, baseline]
  );
  return res.rows;
}

/**
 * 按保留期清理过期文件条目（一批一轮，直至无候选）。
 * 先删磁盘文件，再删 DB 行（与 media.js DELETE 顺序一致）。
 *
 * @param {Date} baseline 存量保护基线（仅清理基线之后产生的条目，H1）
 * @returns {Promise<{dbDeleted: number, filesDeleted: number, fileErrors: number, batches: number}>}
 */
async function cleanupExpiredFileItems(baseline) {
  const stats = { dbDeleted: 0, filesDeleted: 0, fileErrors: 0, batches: 0 };

  // 无上限循环保护：每批之间重查候选；候选数 < 批大小时自然终止
  for (;;) {
    const candidates = await selectExpiredFileItems(DELETE_BATCH, baseline);
    if (candidates.length === 0) break;
    stats.batches++;

    for (const item of candidates) {
      // 1) 先删磁盘（尽力而为）
      const { deleted, errors } = await deleteStoredClipFiles(item);
      stats.filesDeleted += deleted;
      stats.fileErrors += errors;
    }

    // 2) 再删 DB 行；RETURNING 统计真实删除数（竞态下用户可能已手动删除）
    const ids = candidates.map((r) => r.id);
    const delRes = await pool.query(
      `DELETE FROM clipboard_items WHERE id = ANY($1::uuid[]) RETURNING id`,
      [ids]
    );
    stats.dbDeleted += delRes.rowCount;

    if (delRes.rowCount < candidates.length) {
      logger.debug('[FileRetention] Some candidates vanished before DELETE (deleted concurrently)', {
        expected: candidates.length,
        deleted: delRes.rowCount,
      });
    }

    if (candidates.length < DELETE_BATCH) break;
  }

  return stats;
}

/**
 * 清扫分片上传遗弃目录与 multer 临时文件（mtime 超过 24h）。
 * 与 DB 无关，失败仅计数。
 *
 * @returns {Promise<{chunkDirsRemoved: number, tmpFilesRemoved: number, tmpErrors: number}>}
 */
async function cleanupAbandonedDiskArtifacts() {
  const stats = { chunkDirsRemoved: 0, tmpFilesRemoved: 0, tmpErrors: 0 };
  const cutoff = Date.now() - ABANDONED_AGE_MS;

  // 1) uploads/chunks/<uploadId>/：遗弃的分片目录（正常完成时 mergeChunks 已 rm；
  //    .multer-tmp 是常驻工作目录本身，跳过）
  try {
    const entries = await fs.readdir(CHUNKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.multer-tmp') continue;
      try {
        const st = await fs.stat(path.join(CHUNKS_DIR, entry.name));
        if (st.mtimeMs < cutoff) {
          await fs.rm(path.join(CHUNKS_DIR, entry.name), { recursive: true, force: true });
          stats.chunkDirsRemoved++;
        }
      } catch (err) {
        stats.tmpErrors++;
        logger.warn('[FileRetention] Failed to remove abandoned chunk dir', {
          dir: entry.name,
          error: err?.message,
        });
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      stats.tmpErrors++;
      logger.warn('[FileRetention] Failed to scan chunks dir', { error: err?.message });
    }
  }

  // 2) multer 临时文件：chunks/.multer-tmp（分片 `<uploadId>_<index>`）
  //    与 uploads/tmp（media 直传 `<uuid>.img.tmp` / `<uuid>.file.tmp`）
  for (const tmpDir of [CHUNK_MULTER_TMP, MEDIA_TMP_DIR]) {
    try {
      const entries = await fs.readdir(tmpDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          const st = await fs.stat(path.join(tmpDir, entry.name));
          if (st.mtimeMs < cutoff) {
            await fs.unlink(path.join(tmpDir, entry.name));
            stats.tmpFilesRemoved++;
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            stats.tmpErrors++;
            logger.warn('[FileRetention] Failed to remove stale tmp file', {
              dir: tmpDir,
              file: entry.name,
              error: err?.message,
            });
          }
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        stats.tmpErrors++;
        logger.warn('[FileRetention] Failed to scan tmp dir', { dir: tmpDir, error: err?.message });
      }
    }
  }

  return stats;
}

/**
 * 执行一轮完整清理（保留期过期条目 + 磁盘遗留物）。
 * 任何异常 non-fatal：内部捕获并计数，绝不抛出。
 *
 * @returns {Promise<object|null>} 统计结果；整体失败时返回 null
 */
export async function runFileRetentionCleanup() {
  const failures = [];
  let dbStats = null;
  let diskStats = null;

  // 1) DB 保留期清理（迁移 042 未跑 / 缺列时保守跳过；H1 基线不可用时保守跳过）
  try {
    // H1：先确保基线——首次运行写入当前时间戳并跳过本轮条目清理
    //（磁盘清扫在下方独立执行，不受影响）；基线读取失败（DB 异常）也跳过。
    let baseline = null;
    try {
      baseline = await ensureRetentionBaseline();
    } catch (err) {
      failures.push(`baseline: ${err?.message}`);
    }
    if (!baseline) {
      logger.warn('[FileRetention] Retention baseline unavailable (DB error?), skipping DB cleanup this round');
    } else if (await hasRetentionColumn()) {
      dbStats = await cleanupExpiredFileItems(baseline);
    } else {
      logger.warn('[FileRetention] subscription_plans.file_retention_days missing (migration 042 not applied?), skipping DB cleanup this round');
    }
  } catch (err) {
    failures.push(`db: ${err?.message}`);
  }

  // 2) 磁盘遗留物清扫（独立于 DB，DB 失败不阻塞）
  try {
    diskStats = await cleanupAbandonedDiskArtifacts();
  } catch (err) {
    failures.push(`disk: ${err?.message}`);
  }

  // 3) 汇总日志（有动作才输出 info，空轮保持安静）
  const hasAction =
    (dbStats && (dbStats.dbDeleted > 0 || dbStats.fileErrors > 0)) ||
    (diskStats && (diskStats.chunkDirsRemoved > 0 || diskStats.tmpFilesRemoved > 0 || diskStats.tmpErrors > 0));
  if (failures.length > 0) {
    logger.error('[FileRetention] Cleanup finished with errors (non-fatal)', {
      failures,
      dbStats,
      diskStats,
    });
  } else if (hasAction) {
    logger.info('[FileRetention] Cleanup done', { db: dbStats, disk: diskStats });
  } else {
    logger.debug('[FileRetention] Nothing to clean this round');
  }

  return failures.length > 0 ? null : { db: dbStats, disk: diskStats };
}

/**
 * 启动文件保留期清理调度器（应用启动时调用一次）。
 * H1：首轮延迟 5 分钟执行（原为启动立即跑——部署当天首轮即对存量条目
 * 做全量清理的窗口风险过大；基线机制只防"存量被删"，延迟首跑进一步
 * 降低"基线写入瞬间到首轮之间"的边界扰动），之后每 60 分钟一轮。
 * timer.unref() 不阻止进程退出。
 * 返回周期轮 timer（测试/运维可 clearInterval；首跑定时器同样 unref，
 * 5 分钟 << 60 分钟，必然先于首个周期 tick 发生）。
 */
export function startFileRetentionCleanup() {
  const firstRunTimer = setTimeout(() => {
    runFileRetentionCleanup();
  }, FIRST_RUN_DELAY_MS);
  if (typeof firstRunTimer.unref === 'function') firstRunTimer.unref();

  const timer = setInterval(() => {
    runFileRetentionCleanup();
  }, RUN_INTERVAL);

  // 不阻止进程退出（对齐 versionManager.startVersionCleanupScheduler）
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export default {
  startFileRetentionCleanup,
  runFileRetentionCleanup,
  deleteStoredClipFiles,
  isSafeStoredFilename,
};


import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 套餐配额模块（工单 F0.2）
 *
 * 职责：
 *  - getPlanLimits(userId)：一次 JOIN 查询 users → user_subscriptions → subscription_plans，
 *    汇出当前用户的上传/存储配额（阈值一律读 DB，admin 不受限）。
 *  - checkUploadQuota(userId, files, limits)：按四项校验上传请求
 *    （单文件大小 / 文件数 / 单次总大小 / 用户已用容量）。
 *  - quotaErrorMessage / quotaHttpBody：统一 413 响应体构造，供 media.js 与 chunked-upload.js 复用。
 *
 * 容错策略（避免迁移未跑 / DB 抖动导致上传接口 500）：
 *  - subscription_plans 新列 max_files_per_clip / file_retention_days 可能尚不存在：
 *    先查 information_schema（结果带 TTL 缓存）动态拼 SELECT，缺列时返回 NULL。
 *  - 主查询异常（连接失败等）：降级为 FALLBACK_LIMITS 并告警日志，不抛错（与原
 *    chunked-upload.js 内联查询的 fail-open 行为保持一致）。
 *  - 已用容量查询异常：跳过存储容量校验（fail-open），不阻塞上传。
 */

// ─────────────────────────────────────────────────────────────────────────────
// DB 缺值兜底（仅当 subscription_plans 无 'Free' 行或关键字段全为 NULL 时使用）。
// L-2：数值与迁移 042 Free 行保持一致，仅 DB 不可达兜底（原 128MB/5 文件/7 天
// 与迁移 Free 行 20MB/200MB/3 个/3 天互相矛盾）；正常路径阈值一律读 DB。
// ─────────────────────────────────────────────────────────────────────────────
const MB = 1024 * 1024;
const FALLBACK_LIMITS = {
  plan: 'Free',
  planId: null,
  isUnlimited: false,
  maxFileSizeBytes: 20 * MB,
  maxFilesPerClip: 3,
  maxPerClipBytes: 20 * MB, // 单次总大小上限 = 同单文件上限
  maxStorageBytes: 200 * MB,
  fileRetentionDays: 3,
};

// 套餐升级路径：Free→Pro、Pro→Enterprise、Enterprise→null（未知套餐名保守推荐 Pro）
const UPGRADE_PATH = { free: 'Pro', pro: 'Enterprise', enterprise: null };

// 413 错误消息映射（两个上传入口共用，保证 body 文案一致）
const QUOTA_ERROR_MESSAGES = {
  FILE_SIZE_EXCEEDED: 'File exceeds the maximum size allowed for your plan',
  TOO_MANY_FILES: 'Too many files for a single upload on your plan',
  FILE_TOTAL_EXCEEDED: 'Total upload size exceeds the limit for your plan',
  STORAGE_QUOTA_EXCEEDED: 'Storage quota exceeded, please delete files or upgrade your plan',
};

// ─────────────────────────────────────────────────────────────────────────────
// information_schema 列存在性缓存：迁移只在部署窗口执行，60s TTL 足够。
// 缓存失败状态也带 TTL，避免每次上传都多打一次 information_schema。
// ─────────────────────────────────────────────────────────────────────────────
const PLAN_COLUMN_TTL_MS = 60 * 1000;
let planColumnCache = { checkedAt: 0, hasMaxFilesPerClip: false, hasFileRetentionDays: false };

async function getPlanExtraColumns() {
  const now = Date.now();
  if (now - planColumnCache.checkedAt < PLAN_COLUMN_TTL_MS) {
    return planColumnCache;
  }
  try {
    const res = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'subscription_plans'
          AND column_name IN ('max_files_per_clip', 'file_retention_days')`
    );
    const names = new Set(res.rows.map((r) => r.column_name));
    planColumnCache = {
      checkedAt: now,
      hasMaxFilesPerClip: names.has('max_files_per_clip'),
      hasFileRetentionDays: names.has('file_retention_days'),
    };
  } catch (err) {
    // 查询失败：保守视为缺列（SELECT 用 NULL 占位），不缓存"成功"状态语义
    logger.warn('[planLimits] Failed to inspect subscription_plans columns, assuming legacy schema', {
      error: err.message,
    });
    planColumnCache = { checkedAt: now, hasMaxFilesPerClip: false, hasFileRetentionDays: false };
  }
  return planColumnCache;
}

/**
 * 查询用户当前套餐配额。
 * 一次 JOIN：users → user_subscriptions(active) → subscription_plans；
 * 无 active 订阅时经 sp_free 兜底 JOIN 到 Free 套餐行（仍是一次查询），
 * 保证 Free 用户阈值同样来自 DB 而非硬编码。
 *
 * @param {string} userId
 * @returns {Promise<{plan:string, planId:string|null, isUnlimited:boolean,
 *   maxFileSizeBytes:number|null, maxFilesPerClip:number|null,
 *   maxPerClipBytes:number|null, maxStorageBytes:number|null, fileRetentionDays:number|null}>}
 */
export async function getPlanLimits(userId) {
  try {
    const { hasMaxFilesPerClip, hasFileRetentionDays } = await getPlanExtraColumns();

    // 新列可能不存在（迁移未执行）：存在则读值，缺列用 NULL::integer 占位
    const maxFilesSel = hasMaxFilesPerClip
      ? 'COALESCE(sp.max_files_per_clip, sp_free.max_files_per_clip) AS max_files_per_clip'
      : 'NULL::integer AS max_files_per_clip';
    const retentionSel = hasFileRetentionDays
      ? 'COALESCE(sp.file_retention_days, sp_free.file_retention_days) AS file_retention_days'
      : 'NULL::integer AS file_retention_days';

    const res = await pool.query(
      `SELECT
         u.is_admin,
         us.plan_id,
         COALESCE(sp.name, sp_free.name) AS plan_name,
         COALESCE(sp.max_file_size_mb, sp_free.max_file_size_mb) AS max_file_size_mb,
         COALESCE(sp.max_storage_mb, sp_free.max_storage_mb)     AS max_storage_mb,
         ${maxFilesSel},
         ${retentionSel}
       FROM users u
       LEFT JOIN user_subscriptions us
         ON us.user_id = u.id AND us.status = 'active'
       LEFT JOIN subscription_plans sp
         ON us.plan_id = sp.id
       LEFT JOIN subscription_plans sp_free
         ON sp.id IS NULL AND sp_free.name = 'Free' AND sp_free.is_active = true
       WHERE u.id = $1
       ORDER BY us.created_at DESC NULLS LAST
       LIMIT 1`,
      [userId]
    );

    if (res.rows.length === 0) {
      // 用户不存在（理论上 authenticateToken 已过滤）：按 Free 兜底拒绝超额上传
      return { ...FALLBACK_LIMITS };
    }

    const row = res.rows[0];

    // admin 判定方式与原 chunked-upload.js 对齐（u.is_admin → 不受限）
    if (row.is_admin) {
      return {
        plan: 'Admin',
        planId: row.plan_id || null,
        isUnlimited: true,
        maxFileSizeBytes: null,
        maxFilesPerClip: null,
        maxPerClipBytes: null,
        maxStorageBytes: null,
        fileRetentionDays: null,
      };
    }

    const maxFileSizeMb = row.max_file_size_mb != null ? Number(row.max_file_size_mb) : null;
    const maxStorageMb = row.max_storage_mb != null ? Number(row.max_storage_mb) : null;
    const maxFileSizeBytes = maxFileSizeMb != null ? maxFileSizeMb * MB : null;

    return {
      plan: row.plan_name || 'Free',
      planId: row.plan_id || null,
      isUnlimited: false,
      maxFileSizeBytes,
      maxFilesPerClip: row.max_files_per_clip != null ? Number(row.max_files_per_clip) : null,
      maxPerClipBytes: maxFileSizeBytes, // 单次多文件总大小上限 = 同单文件上限
      maxStorageBytes: maxStorageMb != null ? maxStorageMb * MB : null,
      fileRetentionDays: row.file_retention_days != null ? Number(row.file_retention_days) : null,
    };
  } catch (err) {
    // 主查询失败（DB 不可达等）：降级兜底限值，保证上传入口不 500（与旧行为一致）
    logger.warn('[planLimits] Failed to fetch plan limits, falling back to safe defaults', {
      userId,
      error: err.message,
    });
    return { ...FALLBACK_LIMITS };
  }
}

/**
 * 用户已用文件容量 + 同口径文件条数（工单 F0.3，一次查询同时取 SUM 与 COUNT）。
 * 口径：content_type='file' 且 (metadata->>'fileEncoding') IS DISTINCT FROM 'text'，
 * 且 M-2：(metadata->>'localOnly') IS DISTINCT FROM 'true'——桌面端 413/失败兜底
 * 写入的 localOnly 占位条目无服务端字节但带 content_size，此前计入已用容量导致
 * 幽灵用量误拒后续上传；complete 转正后该键为 false，不受影响。
 * 与 checkUploadQuota 的容量校验完全一致；COUNT 与 SUM 共用同一 WHERE，天然同口径。
 * clipboard_items.metadata 为 JSONB（见 db/migrate.js），直接用 ->> 取键。
 *
 * @param {string} userId
 * @returns {Promise<{usedBytes:number, fileCount:number}|null>}
 *   成功返回 { usedBytes, fileCount }；查询失败返回 null（调用方自行决定降级语义：
 *   上传校验 fail-open 跳过校验，查询类接口返回 500）。
 */
export async function getUsedStorageStats(userId) {
  try {
    const res = await pool.query(
      `SELECT COALESCE(SUM(content_size), 0) AS used,
              COUNT(*) AS file_count
         FROM clipboard_items
        WHERE user_id = $1
          AND content_type = 'file'
          AND (metadata->>'fileEncoding') IS DISTINCT FROM 'text'
          AND (metadata->>'localOnly') IS DISTINCT FROM 'true'`,
      [userId]
    );
    return {
      usedBytes: Number(res.rows[0]?.used) || 0,
      fileCount: Number(res.rows[0]?.file_count) || 0,
    };
  } catch (err) {
    logger.warn('[planLimits] Failed to compute used storage stats', {
      userId,
      error: err.message,
    });
    return null;
  }
}

/**
 * 用户已用文件容量（字节）。旧接口，保留原签名与语义（工单 F0.2 调用方不受影响）。
 * 内部复用 getUsedStorageStats 的同一条 SQL，禁止再写一份容量统计。
 *
 * @returns {Promise<number|null>} 已用字节数；查询失败返回 null（调用方跳过容量校验）
 */
export async function getUsedStorageBytes(userId) {
  const stats = await getUsedStorageStats(userId);
  return stats == null ? null : stats.usedBytes;
}

/**
 * 校验上传请求是否超出套餐配额。
 *
 * @param {string} userId
 * @param {Array<{size:number, count?:number}>} files
 *   每个元素描述"size 字节的文件共 count 个"（count 缺省 1；单文件上传传 [{size}]）。
 * @param {object} limits getPlanLimits 的返回值
 * @returns {Promise<{allowed:boolean, code?:string, limitBytes?:number, currentBytes?:number,
 *   limitCount?:number, currentCount?:number, usedBytes?:number, plan:string, upgradeTo:string|null}>}
 */
export async function checkUploadQuota(userId, files, limits) {
  const plan = limits?.plan || 'Free';
  const base = { plan, upgradeTo: upgradeTarget(plan) };

  // admin / 无限套餐：不受限
  if (limits?.isUnlimited) {
    return { allowed: true, ...base };
  }

  // 归一化汇总：总文件数 / 总字节 / 最大单文件字节
  let totalFiles = 0;
  let totalBytes = 0;
  let maxSingleSize = 0;
  for (const f of Array.isArray(files) ? files : []) {
    const size = Number(f?.size) || 0;
    const count = Math.max(1, Number(f?.count) || 1);
    totalFiles += count;
    totalBytes += size * count;
    if (size > maxSingleSize) maxSingleSize = size;
  }

  // 1) 单文件大小
  if (limits?.maxFileSizeBytes != null && maxSingleSize > limits.maxFileSizeBytes) {
    return {
      allowed: false,
      code: 'FILE_SIZE_EXCEEDED',
      limitBytes: limits.maxFileSizeBytes,
      currentBytes: maxSingleSize,
      ...base,
    };
  }

  // 2) 单次文件数
  if (limits?.maxFilesPerClip != null && totalFiles > limits.maxFilesPerClip) {
    return {
      allowed: false,
      code: 'TOO_MANY_FILES',
      limitCount: limits.maxFilesPerClip,
      currentCount: totalFiles,
      ...base,
    };
  }

  // 3) 单次总大小（上限 = 同单文件上限）
  if (limits?.maxPerClipBytes != null && totalBytes > limits.maxPerClipBytes) {
    return {
      allowed: false,
      code: 'FILE_TOTAL_EXCEEDED',
      limitBytes: limits.maxPerClipBytes,
      currentBytes: totalBytes,
      ...base,
    };
  }

  // 4) 用户已用容量（used 查询失败时 fail-open，返回 null 跳过本校验）
  if (limits?.maxStorageBytes != null) {
    const used = await getUsedStorageBytes(userId);
    if (used != null && used + totalBytes > limits.maxStorageBytes) {
      return {
        allowed: false,
        code: 'STORAGE_QUOTA_EXCEEDED',
        limitBytes: limits.maxStorageBytes,
        currentBytes: totalBytes,
        usedBytes: used,
        ...base,
      };
    }
    return { allowed: true, usedBytes: used ?? undefined, ...base };
  }

  return { allowed: true, ...base };
}

/**
 * 按校验失败码返回统一错误消息。
 */
export function quotaErrorMessage(code) {
  return QUOTA_ERROR_MESSAGES[code] || 'Upload rejected by plan limits';
}

/**
 * 将 checkUploadQuota 的失败结果转换为 413 响应体：
 * { error, code, limit, current, plan, upgradeTo }（media.js 与 chunked-upload.js 共用，结构一致）。
 * 字节类校验 limit/current 为字节数；TOO_MANY_FILES 时为文件个数。
 */
export function quotaHttpBody(verdict) {
  const isCount = verdict?.code === 'TOO_MANY_FILES';
  return {
    error: quotaErrorMessage(verdict?.code),
    code: verdict?.code,
    limit: isCount ? verdict.limitCount : verdict.limitBytes,
    current: isCount ? verdict.currentCount : verdict.currentBytes,
    plan: verdict?.plan,
    upgradeTo: verdict?.upgradeTo,
  };
}

/**
 * Free→Pro、Pro→Enterprise、Enterprise→null；未知套餐名保守推荐 Pro。
 */
function upgradeTarget(planName) {
  const key = String(planName || 'Free').toLowerCase();
  return Object.prototype.hasOwnProperty.call(UPGRADE_PATH, key) ? UPGRADE_PATH[key] : 'Pro';
}

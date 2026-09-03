import { Router } from 'express';
import { getPlanLimits, getUsedStorageStats } from '../utils/planLimits.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/storage/usage（工单 F0.3）
 * 当前用户文件存储用量与套餐配额。
 *
 * 响应结构：
 * {
 *   usedBytes:   number,       // 已用字节（口径：content_type='file' 且非文本明文，
 *                              //   与 checkUploadQuota 容量校验完全一致）
 *   quotaBytes:  number|null,  // 套餐容量上限（字节，来自 getPlanLimits().maxStorageBytes）
 *   unlimited:   boolean,      // true 表示无限量（admin / 无上限套餐）
 *   fileCount:   number,       // 同口径的文件条数（与 usedBytes 同一 WHERE 条件）
 *   plan:        string        // 套餐名（Free/Pro/.../Admin，来自 getPlanLimits）
 * }
 *
 * 无限量形态约定：admin（isUnlimited=true）时 quotaBytes 返回 null 并携带 unlimited:true，
 * 不伪造一个巨大的数字上限；前端以 unlimited 判断是否隐藏配额进度条。
 * 注意：普通用户若 DB 中 max_storage_mb 为 NULL，quotaBytes 同样为 null 但 unlimited=false，
 * 语义是「配额未知」而非「无限」，与 admin 的情况可通过 unlimited 字段区分。
 *
 * 鉴权：由 index.js 挂载链保证（authenticateToken，未登录 401）；
 * 本路由仅处理业务逻辑。
 */
router.get('/usage', async (req, res) => {
  try {
    const userId = req.user.userId;

    // 配额与用量并行查询；两者互不依赖
    const [limits, stats] = await Promise.all([
      getPlanLimits(userId),
      getUsedStorageStats(userId),
    ]);

    // 用量查询失败（DB 异常）返回 500：本接口是纯查询，没有上传接口的
    // fail-open 语义——返回 null 当 0 会误导用户以为自己没用容量。
    if (stats == null) {
      return res.status(500).json({ error: 'Failed to compute storage usage' });
    }

    const unlimited = limits.isUnlimited === true;

    res.json({
      usedBytes: stats.usedBytes,
      quotaBytes: unlimited ? null : limits.maxStorageBytes,
      unlimited,
      fileCount: stats.fileCount,
      plan: limits.plan,
    });
  } catch (err) {
    logger.error('[storage] GET /usage error:', err);
    res.status(500).json({ error: 'Failed to get storage usage' });
  }
});

export default router;

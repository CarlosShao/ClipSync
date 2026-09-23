import { Router } from 'express';
import { isValidUUID, validatePagination } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { requireRole } from '../middleware/adminAuth.js';
import {
  createVersion,
  getVersionHistory,
  getVersionDetail,
  restoreVersion,
  getVersionStats,
  cleanupOldVersions,
  limitVersionsPerItem,
} from '../utils/versionManager.js';
import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /api/versions - 创建新版本
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { clipboardItemId, contentEncrypted, contentPreview, contentSize, metadata, sourceDeviceId, changeDescription } = req.body;

    // 验证必填字段
    if (!clipboardItemId) {
      return res.status(400).json({ error: 'clipboardItemId is required' });
    }

    if (!isValidUUID(clipboardItemId)) {
      return res.status(400).json({ error: 'Invalid clipboardItemId format' });
    }

    // 版本正文必填校验（P0-C/C1 拆旁路后 version.test.js 第一次真打进这个 handler 才暴露）：
    // 真正会撞 500 的只有 contentEncrypted —— file_versions.content_encrypted 是 NOT NULL，
    // 缺字段直接撞 PG 非空约束被 catch 兜成 500；contentSize 传了非数字则是 22P02 → 同样 500。
    // ⚠ 按 information_schema 实测更正（本次收尾核的）：content_preview 与 content_size
    //   都是 **NULLABLE 且有默认值**（''/0），并不像下面这条注释的初版所写是 NOT NULL；
    //   所以「缺这俩字段 → 500」不成立，把它们一并拒成 400 属于**主动收紧契约**而非修 bug。
    //   现状保留（本仓 desktop/admin-console 均无 POST /api/versions 的调用方，无存量伤害），
    //   是否放宽（缺失即按 DB 默认值收下）交 owner 定，见 docs/audit/…/_evidence/p0c-c1.md §9。
    if (typeof contentEncrypted !== 'string' || contentEncrypted.length === 0) {
      return res.status(400).json({ error: 'contentEncrypted is required' });
    }
    // content_preview / content_size 在库里是 NULLABLE 且有默认值（本次按 information_schema 实测核过），
    // 所以"缺字段"不会撞 500。初版把缺字段一并拒成 400 属主动收紧契约而非修 bug，现退回：
    // 只在调用方确实给了值时校验类型，缺失交给 DB 默认。防 500 的那部分（contentEncrypted 非空、
    // 给了值就必须是合法类型）原样保留。
    if (contentPreview !== undefined && contentPreview !== null && typeof contentPreview !== 'string') {
      return res.status(400).json({ error: 'contentPreview must be a string' });
    }
    let parsedContentSize = null;
    if (contentSize !== undefined && contentSize !== null) {
      parsedContentSize = Number(contentSize);
      if (!Number.isFinite(parsedContentSize) || parsedContentSize < 0) {
        return res.status(400).json({ error: 'contentSize must be a non-negative number' });
      }
    }
    if (sourceDeviceId !== undefined && sourceDeviceId !== null && !isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'Invalid sourceDeviceId format' });
    }

    // 验证剪贴板项属于当前用户
    const itemCheck = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [clipboardItemId, req.userId]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    // 来源设备同样必须属于当前用户，否则可把版本挂到他人设备上冒名
    if (sourceDeviceId) {
      const deviceCheck = await pool.query(
        'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
        [sourceDeviceId, req.userId]
      );
      if (deviceCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Source device not found' });
      }
    }

    const version = await createVersion({
      clipboardItemId,
      userId: req.userId,
      contentEncrypted,
      contentPreview,
      contentSize: parsedContentSize,
      metadata,
      sourceDeviceId,
      changeDescription,
    });

    res.status(201).json({
      id: version.id,
      versionNumber: version.version_number,
      changeDescription: version.change_description,
      createdAt: version.created_at,
    });
  } catch (err) {
    logger.error('Create version error:', { error: err.message });
    res.status(500).json({ error: 'Failed to create version' });
  }
});

// GET /api/versions/:clipboardItemId - 获取版本历史
router.get('/:clipboardItemId', apiLimiter, async (req, res) => {
  try {
    const { clipboardItemId } = req.params;

    if (!isValidUUID(clipboardItemId)) {
      return res.status(400).json({ error: 'Invalid clipboardItemId format' });
    }

    const { page = 1, limit = 20 } = req.query;
    const pagination = validatePagination(page, limit);

    const result = await getVersionHistory(clipboardItemId, req.userId, {
      page: pagination.page,
      limit: pagination.limit,
    });

    res.json(result);
  } catch (err) {
    logger.error('Get version history error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get version history' });
  }
});

// GET /api/versions/detail/:versionId - 获取版本详情
router.get('/detail/:versionId', apiLimiter, async (req, res) => {
  try {
    const { versionId } = req.params;

    if (!isValidUUID(versionId)) {
      return res.status(400).json({ error: 'Invalid versionId format' });
    }

    const version = await getVersionDetail(versionId, req.userId);

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json(version);
  } catch (err) {
    logger.error('Get version detail error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get version detail' });
  }
});

// POST /api/versions/restore/:versionId - 恢复到指定版本
router.post('/restore/:versionId', apiLimiter, async (req, res) => {
  try {
    const { versionId } = req.params;

    if (!isValidUUID(versionId)) {
      return res.status(400).json({ error: 'Invalid versionId format' });
    }

    const result = await restoreVersion(versionId, req.userId);

    res.json({
      message: 'Version restored successfully',
      item: {
        id: result.item.id,
        contentType: result.item.content_type,
        contentPreview: result.item.content_preview,
        contentSize: result.item.content_size,
        updatedAt: result.item.updated_at,
      },
      restoredFromVersion: result.restoredFromVersion,
      newVersionNumber: result.newVersionNumber,
    });
  } catch (err) {
    logger.error('Restore version error:', { error: err.message });
    if (err.message === 'Version not found' || err.message === 'Clipboard item not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// GET /api/versions/stats/overview - 获取版本统计信息
router.get('/stats/overview', apiLimiter, async (req, res) => {
  try {
    const stats = await getVersionStats(req.userId);
    res.json(stats);
  } catch (err) {
    logger.error('Get version stats error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get version stats' });
  }
});

// POST /api/versions/cleanup - 手动触发版本清理（全库运维操作，仅管理员；
// 桌面端/移动端无任何调用方，普通用户调用它只会删掉全体用户的历史）
router.post('/cleanup', requireRole(50), apiLimiter, async (req, res) => {
  try {
    const { retentionDays, maxVersionsPerItem } = req.body || {};
    // 服务端下限校验：0/负数/非数值一律拒绝，防止 {retentionDays:0} 清空全库版本
    const days = Number(retentionDays ?? 90);
    const maxPerItem = Number(maxVersionsPerItem ?? 50);
    if (!Number.isFinite(days) || days < 1 || !Number.isFinite(maxPerItem) || maxPerItem < 1) {
      return res.status(400).json({ error: 'retentionDays and maxVersionsPerItem must be numbers >= 1' });
    }

    const cleanedByAge = await cleanupOldVersions(days);
    const cleanedByCount = await limitVersionsPerItem(maxPerItem);

    res.json({
      message: 'Version cleanup completed',
      cleanedByAge,
      cleanedByCount,
      totalCleaned: cleanedByAge + cleanedByCount,
    });
  } catch (err) {
    logger.error('Cleanup versions error:', { error: err.message });
    res.status(500).json({ error: 'Version cleanup failed' });
  }
});

export default router;
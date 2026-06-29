import { Router } from 'express';
import { isValidUUID, validatePagination } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
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

    // 验证剪贴板项属于当前用户
    const itemCheck = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [clipboardItemId, req.userId]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    const version = await createVersion({
      clipboardItemId,
      userId: req.userId,
      contentEncrypted,
      contentPreview,
      contentSize,
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

// POST /api/versions/cleanup - 手动触发版本清理
router.post('/cleanup', apiLimiter, async (req, res) => {
  try {
    const { retentionDays = 90, maxVersionsPerItem = 50 } = req.body;

    const cleanedByAge = await cleanupOldVersions(retentionDays);
    const cleanedByCount = await limitVersionsPerItem(maxVersionsPerItem);

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
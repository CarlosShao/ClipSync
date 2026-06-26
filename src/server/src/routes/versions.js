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

const router = Router();

// POST /api/versions - 创建新版本
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { clipboardItemId, contentEncrypted, contentPreview, contentSize, metadata, sourceDeviceId, changeDescription } = req.body;

    // 验证必填字段
    if (!clipboardItemId) {
      return res.status(400).json({ error: 'clipboardItemId 不能为空' });
    }

    if (!isValidUUID(clipboardItemId)) {
      return res.status(400).json({ error: 'clipboardItemId 格式无效' });
    }

    // 验证剪贴板项属于当前用户
    const itemCheck = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [clipboardItemId, req.userId]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: '剪贴板项不存在' });
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
    console.error('Create version error:', err);
    res.status(500).json({ error: '创建版本失败' });
  }
});

// GET /api/versions/:clipboardItemId - 获取版本历史
router.get('/:clipboardItemId', apiLimiter, async (req, res) => {
  try {
    const { clipboardItemId } = req.params;

    if (!isValidUUID(clipboardItemId)) {
      return res.status(400).json({ error: 'clipboardItemId 格式无效' });
    }

    const { page = 1, limit = 20 } = req.query;
    const pagination = validatePagination(page, limit);

    const result = await getVersionHistory(clipboardItemId, req.userId, {
      page: pagination.page,
      limit: pagination.limit,
    });

    res.json(result);
  } catch (err) {
    console.error('Get version history error:', err);
    res.status(500).json({ error: '获取版本历史失败' });
  }
});

// GET /api/versions/detail/:versionId - 获取版本详情
router.get('/detail/:versionId', apiLimiter, async (req, res) => {
  try {
    const { versionId } = req.params;

    if (!isValidUUID(versionId)) {
      return res.status(400).json({ error: 'versionId 格式无效' });
    }

    const version = await getVersionDetail(versionId, req.userId);

    if (!version) {
      return res.status(404).json({ error: '版本不存在' });
    }

    res.json(version);
  } catch (err) {
    console.error('Get version detail error:', err);
    res.status(500).json({ error: '获取版本详情失败' });
  }
});

// POST /api/versions/restore/:versionId - 恢复到指定版本
router.post('/restore/:versionId', apiLimiter, async (req, res) => {
  try {
    const { versionId } = req.params;

    if (!isValidUUID(versionId)) {
      return res.status(400).json({ error: 'versionId 格式无效' });
    }

    const result = await restoreVersion(versionId, req.userId);

    res.json({
      message: '版本恢复成功',
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
    console.error('Restore version error:', err);
    if (err.message === '版本不存在' || err.message === '剪贴板项不存在') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: '恢复版本失败' });
  }
});

// GET /api/versions/stats/overview - 获取版本统计信息
router.get('/stats/overview', apiLimiter, async (req, res) => {
  try {
    const stats = await getVersionStats(req.userId);
    res.json(stats);
  } catch (err) {
    console.error('Get version stats error:', err);
    res.status(500).json({ error: '获取版本统计失败' });
  }
});

// POST /api/versions/cleanup - 手动触发版本清理
router.post('/cleanup', apiLimiter, async (req, res) => {
  try {
    const { retentionDays = 90, maxVersionsPerItem = 50 } = req.body;

    const cleanedByAge = await cleanupOldVersions(retentionDays);
    const cleanedByCount = await limitVersionsPerItem(maxVersionsPerItem);

    res.json({
      message: '版本清理完成',
      cleanedByAge,
      cleanedByCount,
      totalCleaned: cleanedByAge + cleanedByCount,
    });
  } catch (err) {
    console.error('Cleanup versions error:', err);
    res.status(500).json({ error: '版本清理失败' });
  }
});

export default router;
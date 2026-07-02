import { Router } from 'express';
import pool from '../db/pool.js';
import { broadcastToUser, sendNotification } from '../ws/server.js';
import { isValidUUID, isValidContentType, validatePagination, validateSearch, sanitizeString } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { checkClipboardLimit } from '../middleware/subscriptionCheck.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

const router = Router();

// Content type detection helper (rule-based for MVP)
function detectContentType(content, declaredType) {
  if (declaredType && ['text', 'image', 'file', 'link', 'code'].includes(declaredType)) {
    return declaredType;
  }
  if (!content || typeof content !== 'string') return 'text';

  const trimmed = content.trim();

  // URL detection
  if (/^https?:\/\//i.test(trimmed)) return 'link';

  // Code detection (common patterns)
  if (/[{}\[\]];?\s*$/.test(trimmed) ||
      /\b(function|const|let|var|class|import|export|return|if|for|while)\s/.test(trimmed) ||
      /^\s*(def |class |import |from |public |private )/.test(trimmed) ||
      /=>\s*[{(]/.test(trimmed) ||
      /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(trimmed)) {
    return 'code';
  }

  return 'text';
}

// GET /api/clipboard - List clipboard items (with pagination)
router.get('/', apiLimiter, async (req, res) => {
  try {
    const { page = 1, limit = 50, contentType, search, favorites } = req.query;

    // 验证分页参数
    const pagination = validatePagination(page, limit);
    const offset = (pagination.page - 1) * pagination.limit;

    let whereClause = 'WHERE ci.user_id = $1';
    const params = [req.userId];
    let paramIndex = 2;

    if (contentType) {
      if (!isValidContentType(contentType)) {
        return res.status(400).json({ error: 'Invalid contentType' });
      }
      whereClause += ` AND content_type = $${paramIndex}`;
      params.push(contentType);
      paramIndex++;
    }

    if (favorites === 'true') {
      whereClause += ' AND is_favorite = TRUE';
    }

    if (search) {
      const cleanSearch = validateSearch(search);
      if (cleanSearch) {
        // Use full-text search (tsvector) with fallback to ILIKE
        // tsvector search ranks results by relevance; ILIKE provides fallback for short queries
        if (cleanSearch.length >= 3) {
          // Full-text search with relevance ranking
          whereClause += ` AND (ci.search_vector @@ to_tsquery('simple', $${paramIndex}) OR ci.content_preview ILIKE $${paramIndex + 1})`;
          // Convert search terms: replace spaces with & for AND logic, append :* for prefix matching
          const tsQuery = cleanSearch
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => w + ':*')
            .join(' & ');
          params.push(tsQuery);
          params.push(`%${cleanSearch}%`);
          paramIndex += 2;
        } else {
          // Short query: use ILIKE only (tsvector needs at least 3 chars for meaningful results)
          whereClause += ` AND ci.content_preview ILIKE $${paramIndex}`;
          params.push(`%${cleanSearch}%`);
          paramIndex++;
        }
      }
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM clipboard_items ci ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get items
    const itemsResult = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
              ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at,
              d.device_name, d.platform
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       ${whereClause}
       ORDER BY ci.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pagination.limit, offset]
    );

    res.json({
      items: itemsResult.rows.map(item => ({
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        sourceDevice: {
          name: item.device_name,
          platform: item.platform,
        },
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    });
  } catch (err) {
    logger.error('List clipboard items error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get clipboard list' });
  }
});

// GET /api/clipboard/search - Full-text search with relevance ranking
router.get('/search', apiLimiter, async (req, res) => {
  try {
    const { q, contentType, page = 1, limit = 50 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search keyword must be at least 2 characters' });
    }

    const cleanSearch = sanitizeString(q.trim());
    const pagination = validatePagination(page, limit);
    const offset = (pagination.page - 1) * pagination.limit;

    let whereClause = 'WHERE ci.user_id = $1';
    const params = [req.userId];
    let paramIndex = 2;

    if (contentType) {
      if (!isValidContentType(contentType)) {
        return res.status(400).json({ error: 'Invalid contentType' });
      }
      whereClause += ` AND ci.content_type = $${paramIndex}`;
      params.push(contentType);
      paramIndex++;
    }

    // Full-text search using tsvector
    const tsQuery = cleanSearch
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => w + ':*')
      .join(' & ');

    whereClause += ` AND (ci.search_vector @@ to_tsquery('simple', $${paramIndex}) OR ci.content_preview ILIKE $${paramIndex + 1})`;
    params.push(tsQuery);
    params.push(`%${cleanSearch}%`);
    paramIndex += 2;

    // Get items with relevance ranking
    const itemsResult = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
              ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at,
              d.device_name, d.platform,
              ts_rank(ci.search_vector, to_tsquery('simple', $${paramIndex - 2})) AS relevance
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       ${whereClause}
       ORDER BY relevance DESC, ci.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pagination.limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM clipboard_items ci ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    res.json({
      items: itemsResult.rows.map(item => ({
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        relevance: parseFloat(item.relevance) || 0,
        sourceDevice: {
          name: item.device_name,
          platform: item.platform,
        },
      })),
      query: cleanSearch,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    });
  } catch (err) {
    logger.error('Full-text search error:', { error: err.message });
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/clipboard/:id - Get a single clipboard item (including encrypted content)
router.get('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `SELECT ci.*, d.device_name, d.platform
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       WHERE ci.id = $1 AND ci.user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    const item = result.rows[0];
    res.json({
      id: item.id,
      contentType: item.content_type,
      contentEncrypted: item.content_encrypted,
      contentPreview: item.content_preview,
      contentSize: item.content_size,
      metadata: item.metadata,
      isFavorite: item.is_favorite,
      expiresAt: item.expires_at,
      createdAt: item.created_at,
      sourceDevice: {
        id: item.source_device_id,
        name: item.device_name,
        platform: item.platform,
      },
    });
  } catch (err) {
    logger.error('Get clipboard item error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get clipboard item' });
  }
});

// POST /api/clipboard - Create a new clipboard item
router.post('/', apiLimiter, checkClipboardLimit, async (req, res) => {
  try {
    const { sourceDeviceId, contentType, contentEncrypted, contentPreview, contentSize, metadata, expiresAt } = req.body;

    // 验证必填字段
    if (!sourceDeviceId || !contentEncrypted) {
      return res.status(400).json({ error: 'sourceDeviceId and contentEncrypted are required' });
    }

    // 验证 UUID 格式
    if (!isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'Invalid sourceDeviceId format' });
    }

    // 验证内容大小（最大10MB）
    if (typeof contentEncrypted === 'string' && contentEncrypted.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Content too large, maximum size is 10MB' });
    }

    // Detect content type from preview or declared type
    const detectedType = detectContentType(contentPreview, contentType);
    if (!isValidContentType(detectedType)) {
      return res.status(400).json({ error: 'Invalid contentType. Valid values: text, image, file, link, code' });
    }

    // 清理预览内容
    const cleanPreview = contentPreview ? sanitizeString(contentPreview).substring(0, 1000) : '';

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id, device_name FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );

    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const result = await pool.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, content_type, content_preview, content_size, is_favorite, expires_at, created_at`,
      [req.userId, sourceDeviceId, detectedType, contentEncrypted, cleanPreview, contentSize || 0, JSON.stringify(metadata || {}), expiresAt || null]
    );

    const item = result.rows[0];

    // Update device sync state
    await pool.query(
      `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE
       SET last_synced_item_id = $2, last_sync_at = NOW()`,
      [sourceDeviceId, item.id]
    );

    // Broadcast new clipboard item to other devices of the same user
    broadcastToUser(req.userId, {
      type: 'new_clipboard',
      item: {
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        createdAt: item.created_at,
        sourceDeviceId,
      },
    });

    // Send notification for new sync
    sendNotification(req.userId, {
      title: 'New content synced',
      body: `${detectedType.toUpperCase()} content from ${deviceCheck.rows[0]?.device_name || 'Unknown device'}`,
      data: { itemId: item.id, contentType: detectedType },
    });

    // 审计日志：记录剪贴板创建
    await logAuditEvent(req.userId, AUDIT_ACTIONS.CLIPBOARD_CREATE, 'clipboard', item.id, {
      contentType: detectedType,
      sourceDeviceId,
      contentSize,
    }, req);

    res.status(201).json({
      id: item.id,
      contentType: item.content_type,
      contentPreview: item.content_preview,
      contentSize: item.content_size,
      isFavorite: item.is_favorite,
      expiresAt: item.expires_at,
      createdAt: item.created_at,
    });
  } catch (err) {
    logger.error('Create clipboard item error:', { error: err.message });
    res.status(500).json({ error: 'Failed to create clipboard item' });
  }
});

// PUT /api/clipboard/:id/favorite - Toggle favorite
router.put('/:id/favorite', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `UPDATE clipboard_items
       SET is_favorite = NOT is_favorite
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_favorite`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    res.json({ id: result.rows[0].id, isFavorite: result.rows[0].is_favorite });

    // Broadcast favorite change to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_favorite',
      itemId: result.rows[0].id,
      isFavorite: result.rows[0].is_favorite,
    });
  } catch (err) {
    logger.error('Toggle favorite error:', { error: err.message });
    res.status(500).json({ error: 'Failed to toggle favorite status' });
  }
});

// DELETE /api/clipboard/:id - Delete a clipboard item
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      'DELETE FROM clipboard_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    // 审计日志：记录剪贴板删除
    await logAuditEvent(req.userId, AUDIT_ACTIONS.CLIPBOARD_DELETE, 'clipboard', id, {
      contentType: null, // 已删除，无法获取
    }, req);

    res.json({ message: 'Clipboard item deleted' });

    // Broadcast deletion to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_deleted',
      itemId: id,
    });
  } catch (err) {
    logger.error('Delete clipboard item error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete clipboard item' });
  }
});

// DELETE /api/clipboard - Batch delete clipboard items
router.delete('/', apiLimiter, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required and cannot be empty' });
    }

    // 限制批量删除数量
    if (ids.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 items per batch delete' });
    }

    // 验证所有ID格式
    const invalidIds = ids.filter(id => !isValidUUID(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: 'One or more invalid ID formats' });
    }

    const result = await pool.query(
      `DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id`,
      [ids, req.userId]
    );

    res.json({ message: `${result.rowCount} records deleted`, deletedIds: result.rows.map(r => r.id) });

    // Broadcast batch deletion to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_deleted',
      itemIds: result.rows.map(r => r.id),
    });
  } catch (err) {
    logger.error('Batch delete error:', { error: err.message });
    res.status(500).json({ error: 'Batch delete failed' });
  }
});

// GET /api/clipboard/sync/:deviceId - Incremental sync (get items since last sync)
router.get('/sync/:deviceId', apiLimiter, async (req, res) => {
  try {
    const { deviceId } = req.params;

    // 验证设备ID格式
    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: 'Invalid device ID format' });
    }

    // 验证设备属于当前用户
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.userId]
    );

    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Get last sync state
    const syncState = await pool.query(
      'SELECT last_synced_item_id, last_sync_at FROM device_sync_state WHERE device_id = $1',
      [deviceId]
    );

    let sinceClause = '';
    const params = [req.userId];

    if (syncState.rows.length > 0 && syncState.rows[0].last_synced_item_id) {
      // Get items created after the last synced item
      sinceClause = `AND ci.created_at > (SELECT created_at FROM clipboard_items WHERE id = $2)`;
      params.push(syncState.rows[0].last_synced_item_id);
    }

    const result = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
              ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at,
              d.device_name, d.platform
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       WHERE ci.user_id = $1 ${sinceClause}
       ORDER BY ci.created_at DESC
       LIMIT 100`,
      params
    );

    // Update sync state
    if (result.rows.length > 0) {
      await pool.query(
        `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (device_id) DO UPDATE
         SET last_synced_item_id = $2, last_sync_at = NOW()`,
        [deviceId, result.rows[0].id]
      );
    }

    res.json({
      items: result.rows.map(item => ({
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        sourceDevice: {
          name: item.device_name,
          platform: item.platform,
        },
      })),
      hasMore: result.rows.length === 100,
    });
  } catch (err) {
    logger.error('Sync error:', { error: err.message });
    res.status(500).json({ error: 'Sync failed' });
  }
});

export default router;

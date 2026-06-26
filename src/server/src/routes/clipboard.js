import { Router } from 'express';
import pool from '../db/pool.js';
import { broadcastToUser, sendNotification } from '../ws/server.js';
import { isValidUUID, isValidContentType, validatePagination, validateSearch, sanitizeString } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';

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
        return res.status(400).json({ error: 'contentType 无效' });
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
    console.error('List clipboard items error:', err);
    res.status(500).json({ error: '获取剪贴板列表失败' });
  }
});

// GET /api/clipboard/search - Full-text search with relevance ranking
router.get('/search', apiLimiter, async (req, res) => {
  try {
    const { q, contentType, page = 1, limit = 50 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: '搜索关键词至少2个字符' });
    }

    const cleanSearch = sanitizeString(q.trim());
    const pagination = validatePagination(page, limit);
    const offset = (pagination.page - 1) * pagination.limit;

    let whereClause = 'WHERE ci.user_id = $1';
    const params = [req.userId];
    let paramIndex = 2;

    if (contentType) {
      if (!isValidContentType(contentType)) {
        return res.status(400).json({ error: 'contentType 无效' });
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
    console.error('Full-text search error:', err);
    res.status(500).json({ error: '搜索失败' });
  }
});

// GET /api/clipboard/:id - Get a single clipboard item (including encrypted content)
router.get('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      `SELECT ci.*, d.device_name, d.platform
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       WHERE ci.id = $1 AND ci.user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '剪贴板项不存在' });
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
    console.error('Get clipboard item error:', err);
    res.status(500).json({ error: '获取剪贴板项失败' });
  }
});

// POST /api/clipboard - Create a new clipboard item
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { sourceDeviceId, contentType, contentEncrypted, contentPreview, contentSize, metadata, expiresAt } = req.body;

    // 验证必填字段
    if (!sourceDeviceId || !contentEncrypted) {
      return res.status(400).json({ error: 'sourceDeviceId 和 contentEncrypted 不能为空' });
    }

    // 验证 UUID 格式
    if (!isValidUUID(sourceDeviceId)) {
      return res.status(400).json({ error: 'sourceDeviceId 格式无效' });
    }

    // 验证内容大小（最大10MB）
    if (typeof contentEncrypted === 'string' && contentEncrypted.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: '内容过大，最大支持10MB' });
    }

    // Detect content type from preview or declared type
    const detectedType = detectContentType(contentPreview, contentType);
    if (!isValidContentType(detectedType)) {
      return res.status(400).json({ error: `contentType 无效，可选值: text, image, file, link, code` });
    }

    // 清理预览内容
    const cleanPreview = contentPreview ? sanitizeString(contentPreview).substring(0, 1000) : '';

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id, device_name FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );

    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
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
      title: '新内容已同步',
      body: `${detectedType.toUpperCase()} 内容来自 ${deviceCheck.rows[0]?.device_name || '未知设备'}`,
      data: { itemId: item.id, contentType: detectedType },
    });

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
    console.error('Create clipboard item error:', err);
    res.status(500).json({ error: '创建剪贴板项失败' });
  }
});

// PUT /api/clipboard/:id/favorite - Toggle favorite
router.put('/:id/favorite', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      `UPDATE clipboard_items
       SET is_favorite = NOT is_favorite
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_favorite`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '剪贴板项不存在' });
    }

    res.json({ id: result.rows[0].id, isFavorite: result.rows[0].is_favorite });

    // Broadcast favorite change to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_favorite',
      itemId: result.rows[0].id,
      isFavorite: result.rows[0].is_favorite,
    });
  } catch (err) {
    console.error('Toggle favorite error:', err);
    res.status(500).json({ error: '切换收藏状态失败' });
  }
});

// DELETE /api/clipboard/:id - Delete a clipboard item
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'ID格式无效' });
    }

    const result = await pool.query(
      'DELETE FROM clipboard_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '剪贴板项不存在' });
    }

    res.json({ message: '剪贴板项已删除' });

    // Broadcast deletion to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_deleted',
      itemId: id,
    });
  } catch (err) {
    console.error('Delete clipboard item error:', err);
    res.status(500).json({ error: '删除剪贴板项失败' });
  }
});

// DELETE /api/clipboard - Batch delete clipboard items
router.delete('/', apiLimiter, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids 数组不能为空' });
    }

    // 限制批量删除数量
    if (ids.length > 100) {
      return res.status(400).json({ error: '单次最多删除100条' });
    }

    // 验证所有ID格式
    const invalidIds = ids.filter(id => !isValidUUID(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: '存在无效的ID格式' });
    }

    const result = await pool.query(
      `DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id`,
      [ids, req.userId]
    );

    res.json({ message: `${result.rowCount} 条记录已删除`, deletedIds: result.rows.map(r => r.id) });

    // Broadcast batch deletion to other devices
    broadcastToUser(req.userId, {
      type: 'clipboard_deleted',
      itemIds: result.rows.map(r => r.id),
    });
  } catch (err) {
    console.error('Batch delete error:', err);
    res.status(500).json({ error: '批量删除失败' });
  }
});

// GET /api/clipboard/sync/:deviceId - Incremental sync (get items since last sync)
router.get('/sync/:deviceId', apiLimiter, async (req, res) => {
  try {
    const { deviceId } = req.params;

    // 验证设备ID格式
    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: '设备ID格式无效' });
    }

    // 验证设备属于当前用户
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.userId]
    );

    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
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
    console.error('Sync error:', err);
    res.status(500).json({ error: '同步失败' });
  }
});

export default router;

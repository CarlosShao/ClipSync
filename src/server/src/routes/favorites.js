import { Router } from 'express';
import pool from '../db/pool.js';
import { isValidUUID, sanitizeString } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { broadcastToUser } from '../ws/server.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ============================================
// 收藏夹（Collections）CRUD
// ============================================

// GET /api/favorites/collections - 获取用户所有收藏夹
router.get('/collections', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fc.id, fc.name, fc.icon, fc.sort_order, fc.created_at,
              COUNT(fci.item_id)::int AS item_count
       FROM favorite_collections fc
       LEFT JOIN favorite_collection_items fci ON fc.id = fci.collection_id
       WHERE fc.user_id = $1
       GROUP BY fc.id
       ORDER BY fc.sort_order, fc.created_at`,
      [req.userId]
    );
    res.json({ collections: result.rows });
  } catch (err) {
    logger.error('List collections error:', { error: err.message });
    res.status(500).json({ error: 'Failed to list collections' });
  }
});

// POST /api/favorites/collections - 创建收藏夹
router.post('/collections', apiLimiter, async (req, res) => {
  try {
    const { name, icon } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Collection name is required' });
    }
    const cleanName = sanitizeString(name.trim().substring(0, 100));
    const cleanIcon = (icon || '📁').substring(0, 10);

    // 获取当前最大 sort_order
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM favorite_collections WHERE user_id = $1',
      [req.userId]
    );

    const result = await pool.query(
      `INSERT INTO favorite_collections (user_id, name, icon, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, icon, sort_order, created_at`,
      [req.userId, cleanName, cleanIcon, maxOrder.rows[0].next_order]
    );

    res.status(201).json({ collection: result.rows[0] });
  } catch (err) {
    logger.error('Create collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to create collection' });
  }
});

// PUT /api/favorites/collections/:id - 更新收藏夹
router.put('/collections/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { name, icon, sortOrder } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      params.push(sanitizeString(name.trim().substring(0, 100)));
    }
    if (icon !== undefined) {
      updates.push(`icon = $${idx++}`);
      params.push(icon.substring(0, 10));
    }
    if (sortOrder !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      params.push(sortOrder);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(id, req.userId);

    const result = await pool.query(
      `UPDATE favorite_collections SET ${updates.join(', ')}
       WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING id, name, icon, sort_order, created_at`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Collection not found' });
    res.json({ collection: result.rows[0] });
  } catch (err) {
    logger.error('Update collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update collection' });
  }
});

// DELETE /api/favorites/collections/:id - 删除收藏夹
router.delete('/collections/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });

    const result = await pool.query(
      'DELETE FROM favorite_collections WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Collection not found' });
    res.json({ message: 'Collection deleted' });
  } catch (err) {
    logger.error('Delete collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete collection' });
  }
});

// ============================================
// 收藏夹内项目管理
// ============================================

// POST /api/favorites/collections/:id/items - 添加项目到收藏夹
router.post('/collections/:id/items', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { itemId } = req.body;
    if (!isValidUUID(id) || !isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // 验证收藏夹属于当前用户
    const col = await pool.query('SELECT id FROM favorite_collections WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (col.rows.length === 0) return res.status(404).json({ error: 'Collection not found' });

    // 获取当前最大 sort_order
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM favorite_collection_items WHERE collection_id = $1',
      [id]
    );

    await pool.query(
      `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection_id, item_id) DO NOTHING`,
      [id, itemId, maxOrder.rows[0].next_order]
    );

    res.json({ message: 'Item added to collection' });
  } catch (err) {
    logger.error('Add item to collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// DELETE /api/favorites/collections/:collectionId/items/:itemId - 从收藏夹移除项目
router.delete('/collections/:collectionId/items/:itemId', apiLimiter, async (req, res) => {
  try {
    const { collectionId, itemId } = req.params;
    if (!isValidUUID(collectionId) || !isValidUUID(itemId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const result = await pool.query(
      `DELETE FROM favorite_collection_items
       WHERE collection_id = $1 AND item_id = $2
       AND collection_id IN (SELECT id FROM favorite_collections WHERE user_id = $3)`,
      [collectionId, itemId, req.userId]
    );

    res.json({ message: 'Item removed from collection', deleted: result.rowCount > 0 });
  } catch (err) {
    logger.error('Remove item from collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// GET /api/favorites/collections/:id/items - 获取收藏夹内项目
router.get('/collections/:id/items', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });

    const result = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
              ci.metadata, ci.is_favorite, ci.favorited_at, ci.created_at,
              d.device_name, d.platform, fci.sort_order
       FROM favorite_collection_items fci
       JOIN clipboard_items ci ON fci.item_id = ci.id
       LEFT JOIN devices d ON ci.source_device_id = d.id
       WHERE fci.collection_id = $1 AND ci.user_id = $2
       ORDER BY fci.sort_order`,
      [id, req.userId]
    );

    res.json({ items: result.rows });
  } catch (err) {
    logger.error('List collection items error:', { error: err.message });
    res.status(500).json({ error: 'Failed to list items' });
  }
});

// ============================================
// 标签管理
// ============================================

// PUT /api/favorites/:id/tags - 设置项目标签
router.put('/:id/tags', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });

    // 清洗标签：去重、截断、限制数量
    const cleanTags = [...new Set(tags.map(t => String(t).trim().substring(0, 30)))].slice(0, 10);

    // 读取当前 metadata，更新 tags 字段
    const current = await pool.query(
      'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (current.rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    const meta = typeof current.rows[0].metadata === 'string'
      ? JSON.parse(current.rows[0].metadata)
      : (current.rows[0].metadata || {});
    meta.tags = cleanTags;

    await pool.query(
      'UPDATE clipboard_items SET metadata = $1 WHERE id = $2 AND user_id = $3',
      [JSON.stringify(meta), id, req.userId]
    );

    res.json({ tags: cleanTags });
  } catch (err) {
    logger.error('Set tags error:', { error: err.message });
    res.status(500).json({ error: 'Failed to set tags' });
  }
});

// GET /api/favorites/tags - 获取用户所有收藏项中使用的标签
router.get('/tags', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(metadata->'tags') = 'array' THEN metadata->'tags' ELSE '[]'::jsonb END
       ) AS tag
       FROM clipboard_items
       WHERE user_id = $1 AND is_favorite = TRUE
         AND metadata->'tags' IS NOT NULL
       ORDER BY tag`,
      [req.userId]
    );
    res.json({ tags: result.rows.map(r => r.tag) });
  } catch (err) {
    logger.error('List tags error:', { error: err.message });
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

export default router;

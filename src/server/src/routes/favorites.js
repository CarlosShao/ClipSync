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
      `SELECT fc.id, fc.name, fc.icon, fc.path::text AS path, fc.sort_order, fc.created_at,
              COUNT(ci.id)::int AS item_count
       FROM favorite_collections fc
       LEFT JOIN favorite_collection_items fci ON fc.id = fci.collection_id
       LEFT JOIN clipboard_items ci ON fci.item_id = ci.id AND ci.user_id = $1 AND ci.is_favorite = TRUE
       WHERE fc.user_id = $1
       GROUP BY fc.id, fc.path, fc.sort_order, fc.created_at
       ORDER BY fc.sort_order ASC, fc.path ASC`,
      [req.userId]
    );

    // 兜底：对 path 为空的记录补全为根节点路径（兼容迁移未覆盖的数据）
    for (const row of result.rows) {
      if (!row.path) {
        row.path = 'root.' + row.id.replace(/-/g, '_');
      }
    }
    res.json({ collections: result.rows });
  } catch (err) {
    logger.error('List collections error:', { error: err.message });
    res.status(500).json({ error: 'Failed to list collections' });
  }
});

// POST /api/favorites/collections - 创建收藏夹（支持 parentId 创建子收藏夹）
router.post('/collections', apiLimiter, async (req, res) => {
  try {
    const { name, icon, parentId } = req.body;
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

    let path;
    if (parentId) {
      // 子收藏夹：path = parent.path.col_<new_uuid>
      const parent = await pool.query(
        'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
        [parentId, req.userId]
      );
      if (parent.rows.length === 0) return res.status(404).json({ error: 'Parent collection not found' });
      const newId = 'xxxxxxxx_xxxx_4xxx_yxxx_xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
      path = parent.rows[0].path + '.col_' + newId;
    } else {
      // 根收藏夹：path = root.<sanitized_uuid>
      const newId = 'xxxxxxxx_xxxx_4xxx_yxxx_xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
      path = 'root.' + newId;
    }

    // 新收藏夹默认排在最前：将现有收藏夹 sort_order 整体 +1
    await pool.query(
      'UPDATE favorite_collections SET sort_order = sort_order + 1 WHERE user_id = $1',
      [req.userId]
    );

    const result = await pool.query(
      `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon, sort_order, path, created_at`,
      [req.userId, cleanName, cleanIcon, 0, path]
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

// DELETE /api/favorites/collections/:id - 删除收藏夹（级联删除所有子收藏夹）
router.delete('/collections/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });

    // 先获取目标收藏夹的 path，用于级联删除子级
    const target = await pool.query(
      'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (target.rows.length === 0) return res.status(404).json({ error: 'Collection not found' });

    // 级联删除：目标收藏夹及其所有后代（ltree path <@ 查询）
    await pool.query(
      'DELETE FROM favorite_collections WHERE path <@ $1 AND user_id = $2',
      [target.rows[0].path, req.userId]
    );

    res.json({ message: 'Collection and all descendants deleted' });
  } catch (err) {
    logger.error('Delete collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete collection' });
  }
});

// ============================================
// 收藏夹移动（层级变更）
// ============================================

// PUT /api/favorites/collections/:id/move - 移动收藏夹到新的父级
router.put('/collections/:id/move', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { parentId } = req.body;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });

    // 获取被移动的收藏夹
    const src = await pool.query(
      'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (src.rows.length === 0) return res.status(404).json({ error: 'Collection not found' });
    const srcPath = src.rows[0].path;

    let newParentPath;
    if (parentId) {
      // 移动到指定父级下
      const parent = await pool.query(
        'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
        [parentId, req.userId]
      );
      if (parent.rows.length === 0) return res.status(404).json({ error: 'Parent collection not found' });
      newParentPath = parent.rows[0].path;

      // 防止循环引用：目标不能是被移动节点的后代
      if (newParentPath.startsWith(srcPath + '.') || newParentPath === srcPath) {
        return res.status(400).json({ error: 'Cannot move collection into itself or its descendant' });
      }
    } else {
      // 移动到根级
      newParentPath = null;
    }

    // 计算新路径
    const newLeaf = 'col_' + 'xxxxxxxx_xxxx_4xxx_yxxx_xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
    const newPath = newParentPath
      ? newParentPath + '.' + newLeaf
      : 'root.' + newLeaf;

    // 计算路径前缀替换长度（srcPath 的层级数）
    const srcLevels = await pool.query('SELECT nlevel($1::ltree) AS n', [srcPath]);
    const srcNlevel = srcLevels.rows[0].n;
    const newNlevel = await pool.query('SELECT nlevel($1::ltree) AS n', [newPath]);
    const newPathNlevel = newNlevel.rows[0].n;

    // 更新被移动节点自身的路径
    await pool.query(
      'UPDATE favorite_collections SET path = $1, updated_at = NOW() WHERE id = $2',
      [newPath, id]
    );

    // 更新所有后代的路径：将 srcPath 前缀替换为 newPath
    if (srcNlevel > 0) {
      await pool.query(
        `UPDATE favorite_collections
         SET path = $1 || subpath(path, $2)
         WHERE path <@ $3 AND id != $4`,
        [newPath, srcNlevel, srcPath, id]
      );
    }

    // 返回更新后的节点
    const updated = await pool.query(
      'SELECT id, name, icon, sort_order, path, created_at FROM favorite_collections WHERE id = $1',
      [id]
    );
    res.json({ collection: updated.rows[0] });
  } catch (err) {
    logger.error('Move collection error:', { error: err.message });
    res.status(500).json({ error: 'Failed to move collection' });
  }
});

// PUT /api/favorites/collections/reorder - 批量更新收藏夹排序
router.put('/collections/reorder', apiLimiter, async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'orders array is required' });
    }

    // 验证所有 ID 是否属于当前用户
    const ids = orders.map(o => o.id).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid ids provided' });
    }
    const idCheck = await pool.query(
      'SELECT id FROM favorite_collections WHERE id = ANY($1::uuid[]) AND user_id = $2',
      [ids, req.userId]
    );
    if (idCheck.rows.length !== ids.length) {
      return res.status(403).json({ error: 'Some collections do not belong to current user' });
    }

    await pool.query('BEGIN');
    try {
      for (const o of orders) {
        if (!o.id || typeof o.sortOrder !== 'number') continue;
        await pool.query(
          'UPDATE favorite_collections SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
          [o.sortOrder, o.id, req.userId]
        );
      }
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.json({ message: 'Reorder applied' });
  } catch (err) {
    logger.error('Reorder collections error:', { error: err.message });
    res.status(500).json({ error: 'Failed to reorder collections' });
  }
});

// ============================================
// 收藏夹内项目管理
// ============================================

// POST /api/favorites/collections/:id/items - 添加项目到收藏夹（唯一归属：自动从其他收藏夹移除）
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

    // 唯一归属：先移除 item 在其他收藏夹中的关联
    await pool.query(
      'DELETE FROM favorite_collection_items WHERE item_id = $1 AND collection_id != $2',
      [itemId, id]
    );

    // 获取当前最大 sort_order
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM favorite_collection_items WHERE collection_id = $1',
      [id]
    );

    await pool.query(
      `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection_id, item_id) DO NOTHING
       RETURNING collection_id`,
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
    const { tags, tagColors } = req.body;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });

    // 清洗标签：去重、截断、限制数量
    const cleanTags = [...new Set(tags.map(t => String(t).trim().substring(0, 30)))].slice(0, 10);

    // 读取当前 metadata
    const current = await pool.query(
      'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (current.rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    const meta = typeof current.rows[0].metadata === 'string'
      ? JSON.parse(current.rows[0].metadata)
      : (current.rows[0].metadata || {});
    // 修复旧数据：tags 可能是 string 而非 array
    if (typeof meta.tags === 'string') {
      try { meta.tags = JSON.parse(meta.tags) } catch { meta.tags = [] }
    }
    meta.tags = cleanTags;

    // 合并 tagColors：保留已有的，新增/更新传入的
    if (tagColors && typeof tagColors === 'object') {
      meta.tagColors = { ...(meta.tagColors || {}), ...tagColors }
    }

    await pool.query(
      'UPDATE clipboard_items SET metadata = $1 WHERE id = $2 AND user_id = $3',
      [meta, id, req.userId]
    );

    res.json({ tags: cleanTags, tagColors: meta.tagColors || {} });
  } catch (err) {
    logger.error('Set tags error:', { error: err.message });
    res.status(500).json({ error: 'Failed to set tags' });
  }
});

// GET /api/favorites/tags - 获取用户所有收藏项中使用的标签（含颜色）
router.get('/tags', apiLimiter, async (req, res) => {
  try {
    // 1. 获取所有标签名
    const tagsResult = await pool.query(
      `SELECT DISTINCT jsonb_array_elements_text(
         CASE
           WHEN jsonb_typeof(metadata->'tags') = 'array' THEN metadata->'tags'
           WHEN jsonb_typeof(metadata->'tags') = 'string' THEN
             CASE WHEN (metadata->'tags')::text LIKE '[%' THEN (metadata->'tags')::jsonb ELSE '[]'::jsonb END
           ELSE '[]'::jsonb
         END
       ) AS tag
       FROM clipboard_items
       WHERE user_id = $1 AND is_favorite = TRUE
         AND metadata->'tags' IS NOT NULL
       ORDER BY tag`,
      [req.userId]
    );

    // 2. 从 metadata.tagColors 中提取所有标签颜色
    const tagColors = {}
    const colorsResult = await pool.query(
      `SELECT metadata FROM clipboard_items
       WHERE user_id = $1 AND is_favorite = TRUE
         AND metadata ? 'tagColors'
         AND jsonb_typeof(metadata->'tagColors') = 'object'`,
      [req.userId]
    );
    for (const row of colorsResult.rows) {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
      if (meta.tagColors && typeof meta.tagColors === 'object') {
        for (const [key, value] of Object.entries(meta.tagColors)) {
          tagColors[key] = value
        }
      }
    }

    const tags = tagsResult.rows.map(r => ({
      name: r.tag,
      color: tagColors[r.tag] || null
    }))

    res.json({ tags });
  } catch (err) {
    logger.error('List tags error:', { error: err.message });
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

// DELETE /api/favorites/tags/:tag - 从用户所有收藏项中删除一个标签
router.delete('/tags/:tag', apiLimiter, async (req, res) => {
  try {
    const { tag } = req.params;
    // 从所有属于当前用户的收藏项的 metadata.tags 中移除指定标签
    const result = await pool.query(
      `UPDATE clipboard_items
       SET metadata = jsonb_set(metadata, '{tags}', (metadata->'tags') - $2)
       WHERE user_id = $1
         AND is_favorite = TRUE
         AND metadata->'tags' ? $2`,
      [req.userId, tag]
    );
    res.json({ message: 'Tag deleted', deleted: result.rowCount });
  } catch (err) {
    logger.error('Delete tag error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// POST /api/favorites/migrate-hierarchy - 自动迁移：为已有数据库添加 ltree 层次结构支持
// 幂等安全：可重复调用，会补全缺失的 path 和 NOT NULL 约束
router.post('/migrate-hierarchy', apiLimiter, async (req, res) => {
  try {
    logger.info('[Migration] migrate-hierarchy called by user:', req.userId)

    // 启用 ltree 扩展
    await pool.query('CREATE EXTENSION IF NOT EXISTS ltree');
    logger.info('[Migration] ltree extension enabled')

    // 检查 path 列是否已存在
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'favorite_collections' AND column_name = 'path'`
    );
    logger.info('[Migration] path column exists:', colCheck.rows.length > 0)
    if (colCheck.rows.length === 0) {
      // 添加 path 列
      await pool.query('ALTER TABLE favorite_collections ADD COLUMN path ltree');
      logger.info('[Migration] path column added')
    }

    // 回填已有收藏夹为根节点（path 为 NULL 或空）
    const backfillResult = await pool.query(
      `UPDATE favorite_collections
       SET path = 'root.' || replace(id::text, '-', '_')::ltree
       WHERE path IS NULL`
    );
    logger.info('[Migration] backfilled rows:', backfillResult.rowCount)

    // 设置 NOT NULL 约束
    const nullCheck = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'favorite_collections' AND column_name = 'path'`
    );
    if (nullCheck.rows[0]?.is_nullable === 'YES') {
      await pool.query('ALTER TABLE favorite_collections ALTER COLUMN path SET NOT NULL');
      logger.info('[Migration] path column set NOT NULL')
    }

    // 创建 GIST 索引
    await pool.query('CREATE INDEX IF NOT EXISTS idx_favcol_path ON favorite_collections USING GIST(path)');

    // 创建 favorite_collection_items 的唯一索引
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_fci_unique_item ON favorite_collection_items(item_id)'
    );

    logger.info('ltree hierarchy migration applied successfully');
    res.json({ message: 'Migration applied successfully', status: 'done', backfilled: backfillResult.rowCount });
  } catch (err) {
    logger.error('Migration error:', { error: err.message });
    res.status(500).json({ error: 'Migration failed: ' + err.message });
  }
});

export default router;

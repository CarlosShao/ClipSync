// ============ aiTools 分域拆分：域 A collectionsTags（收藏夹/标签）处理器 ============
// 自 routes/aiTools.js 的 executeToolInner 各 case 体逐字迁移（纯重构，禁止改写业务逻辑）。
// 依赖：isValidUUID 复用自 ../shared.js；pool 直连 db 连接池；uuidv4 用于 ltree 节点 id 生成。
import { v4 as uuidv4 } from 'uuid'
import pool from '../../../db/pool.js'
import { isValidUUID } from '../shared.js'

export const collectionsTagsHandlers = {
  'batch_move_to_collection': async (args, userId, role) => {
    const { collection_id, item_ids } = args
    if (!collection_id || !isValidUUID(collection_id)) {
      return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'collection_id 必须为合法 UUID' }
    }
    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return { error: 'INVALID_ARGS', code: 'INVALID_ARGS', message: 'item_ids 必须为非空数组' }
    }
    const validIds = item_ids.filter((id) => isValidUUID(id))
    if (validIds.length === 0) {
      return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'item_ids 中没有合法的 UUID' }
    }
    const col = await pool.query(
      'SELECT id, name FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [collection_id, userId]
    )
    if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }

    const items = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
      [validIds, userId]
    )
    const matchedIds = items.rows.map((r) => r.id)
    if (matchedIds.length === 0) {
      return { error: 'ITEMS_NOT_FOUND', code: 'ITEMS_NOT_FOUND', message: '未找到属于当前用户的目标条目' }
    }

    // 唯一归属：先从其他收藏夹批量移除
    await pool.query(
      'DELETE FROM favorite_collection_items WHERE item_id = ANY($1) AND collection_id <> $2',
      [matchedIds, collection_id]
    )
    const maxOrderRes = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collection_items WHERE collection_id = $1',
      [collection_id]
    )
    const baseOrder = parseInt(maxOrderRes.rows[0]?.max_order || '0', 10)

    for (let i = 0; i < matchedIds.length; i++) {
      await pool.query(
        `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
         VALUES ($1, $2, $3) ON CONFLICT (collection_id, item_id) DO NOTHING`,
        [collection_id, matchedIds[i], baseOrder + i + 1]
      )
    }

    return {
      success: true,
      collection_id,
      collection_name: col.rows[0].name,
      moved_count: matchedIds.length,
      item_ids: matchedIds,
      note: `已成功将 ${matchedIds.length} 条数据移动到收藏夹 "${col.rows[0].name}"。`
    }
  },

  'get_collections': async (args, userId, role) => {
    const result = await pool.query(
      `SELECT id, name, icon, path::text AS path, sort_order,
              (SELECT COUNT(*)::int FROM favorite_collection_items fci WHERE fci.collection_id = fc.id) AS item_count
       FROM favorite_collections fc
       WHERE fc.user_id = $1
       ORDER BY sort_order ASC, path ASC`,
      [userId]
    )
    return { collections: result.rows, count: result.rowCount }
  },

  'get_tags': async (args, userId, role) => {
    const result = await pool.query(
      `
      SELECT DISTINCT tag
      FROM (
        SELECT jsonb_array_elements_text(metadata->'tags') AS tag
        FROM clipboard_items
        WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' IS NOT NULL
      ) t
      WHERE tag IS NOT NULL
      ORDER BY tag
      `,
      [userId]
    )
    return { tags: result.rows.map((r) => r.tag), count: result.rowCount }
  },

  'create_collection': async (args, userId, role) => {
    const { name, icon } = args
    if (!name || !String(name).trim()) {
      return { error: 'name is required' }
    }
    const cleanName = String(name).trim().slice(0, 100)
    const cleanIcon = (String(icon || '📁')).slice(0, 10)
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collections WHERE user_id = $1',
      [userId]
    )
    // path 为 ltree 列，标签不允许连字符：uuid 要去掉 '-'（对照 favorites.js 同款写法）
    const path = `root.${uuidv4().replace(/-/g, '_')}`
    const result = await pool.query(
      `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon, sort_order, created_at`,
      [userId, cleanName, cleanIcon, (maxOrder.rows[0].max_order || 0) + 1, path]
    )
    return { collection: result.rows[0] }
  },

  'create_sub_collection': async (args, userId, role) => {
    const { name, parent_id, icon, description } = args
    if (!name || !String(name).trim()) return { error: 'NAME_REQUIRED', code: 'NAME_REQUIRED' }
    if (!parent_id) return { error: 'PARENT_COLLECTION_NOT_FOUND', code: 'PARENT_COLLECTION_NOT_FOUND' }
    const cleanName = String(name).trim().slice(0, 100)
    const cleanIcon = String(icon || '📁').slice(0, 10)
    const parent = await pool.query(
      'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [parent_id, userId]
    )
    if (parent.rows.length === 0) {
      return { error: 'PARENT_COLLECTION_NOT_FOUND', code: 'PARENT_COLLECTION_NOT_FOUND' }
    }
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collections WHERE user_id = $1',
      [userId]
    )
    // ltree 标签不允许连字符：uuid 去 '-'（对照 favorites.js 同款写法）
    const path = `${parent.rows[0].path}.col_${uuidv4().replace(/-/g, '_')}`
    const result = await pool.query(
      `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon, sort_order, path, created_at`,
      [userId, cleanName, cleanIcon, (maxOrder.rows[0].max_order || 0) + 1, path]
    )
    return {
      collection: result.rows[0],
      note: description
        ? 'current 表结构无 description 列，描述仅在本次调用上下文可见（未落库）。'
        : undefined,
    }
  },

  'delete_collection': async (args, userId, role) => {
    // 破坏性工具（已在 DESTRUCTIVE_CONFIRM_NEEDED 登记，经确认门控后进入此处）。
    const { collection_id } = args
    if (!collection_id || !isValidUUID(collection_id)) {
      return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION', message: 'collection_id 必填且为合法 UUID' }
    }
    const target = await pool.query(
      'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [collection_id, userId]
    )
    if (target.rows.length === 0) {
      return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND', message: '收藏夹不存在或不属于当前用户' }
    }
    // ltree 级联删除：path <@ 目标（目标 + 所有后代），仅作用于当前用户
    const del = await pool.query(
      'DELETE FROM favorite_collections WHERE path <@ $1 AND user_id = $2',
      [target.rows[0].path, userId]
    )
    return {
      success: true,
      deleted: del.rowCount,
      collection_id,
      note: '已级联删除该收藏夹及其所有子收藏夹（ltree 后代）。剪贴板条目本身未删除。',
    }
  },

  'update_collection': async (args, userId, role) => {
    const { collection_id, name, icon, sort_order } = args
    if (!collection_id || !isValidUUID(collection_id)) {
      return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
    }
    const fields = []
    const params = []
    let p = 1
    if (name !== undefined) { fields.push(`name = $${p++}`); params.push(String(name).trim().slice(0, 100)) }
    if (icon !== undefined) { fields.push(`icon = $${p++}`); params.push(String(icon).slice(0, 10)) }
    if (sort_order !== undefined) { fields.push(`sort_order = $${p++}`); params.push(Number(sort_order)) }
    if (fields.length === 0) return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'name/icon/sort_order 至少提供一个' }
    fields.push('updated_at = NOW()')
    params.push(collection_id, userId)
    const result = await pool.query(
      `UPDATE favorite_collections SET ${fields.join(', ')} WHERE id = $${p++}::uuid AND user_id = $${p}
       RETURNING id, name, icon, sort_order, created_at, path`,
      params
    )
    if (result.rowCount === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
    return { collection: result.rows[0] }
  },

  'move_collection': async (args, userId, role) => {
    const { collection_id, parent_id } = args
    if (!collection_id || !isValidUUID(collection_id)) {
      return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
    }
    const src = await pool.query(
      'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [collection_id, userId]
    )
    if (src.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
    const srcPath = src.rows[0].path
    let newParentPath = null
    if (parent_id) {
      if (!isValidUUID(parent_id)) return { error: 'INVALID_PARENT', code: 'INVALID_PARENT' }
      const parent = await pool.query(
        'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
        [parent_id, userId]
      )
      if (parent.rows.length === 0) return { error: 'PARENT_NOT_FOUND', code: 'PARENT_NOT_FOUND' }
      newParentPath = parent.rows[0].path
      // 防循环引用：目标不能是被移动节点自身或其后代
      if (newParentPath === srcPath || newParentPath.startsWith(srcPath + '.')) {
        return { error: 'CIRCULAR_MOVE', code: 'CIRCULAR_MOVE', message: '不能把收藏夹移入自身或其子级（会形成循环引用）' }
      }
    }
    const newLeaf = `col_${uuidv4().replace(/-/g, '_')}`
    const newPath = newParentPath ? `${newParentPath}.${newLeaf}` : `root.${newLeaf}`
    const srcLv = await pool.query('SELECT nlevel($1::ltree) AS n', [srcPath])
    const srcN = srcLv.rows[0].n
    // B4：自身路径与后代路径的两次 UPDATE 必须原子生效——改用专用连接的显式事务，
    // 失败一起回滚，杜绝「父已移动、子树还挂旧前缀」的悬挂态。
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // 更新自身路径
      await client.query(
        'UPDATE favorite_collections SET path = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [newPath, collection_id, userId]
      )
      // 更新所有后代路径：把旧前缀替换为新前缀
      if (srcN > 0) {
        await client.query(
          `UPDATE favorite_collections SET path = $1 || subpath(path, $2), updated_at = NOW()
           WHERE path <@ $3 AND id != $4::uuid AND user_id = $5`,
          [newPath, srcN, srcPath, collection_id, userId]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    const updated = await pool.query(
      'SELECT id, name, icon, sort_order, path, created_at FROM favorite_collections WHERE id = $1',
      [collection_id]
    )
    return { collection: updated.rows[0] }
  },

  'reorder_collections': async (args, userId, role) => {
    const { orders } = args
    if (!Array.isArray(orders) || orders.length === 0) {
      return { error: 'ORDERS_REQUIRED', code: 'ORDERS_REQUIRED', message: 'orders 数组必填' }
    }
    const pairs = orders.filter((o) => o && isValidUUID(o.id) && typeof o.sortOrder === 'number')
    if (pairs.length === 0) return { error: 'NO_VALID_ORDERS', code: 'NO_VALID_ORDERS' }
    const ids = pairs.map((o) => o.id)
    const check = await pool.query(
      'SELECT id FROM favorite_collections WHERE id = ANY($1::uuid[]) AND user_id = $2',
      [ids, userId]
    )
    if (check.rows.length !== ids.length) {
      return { error: 'FOREIGN_COLLECTION', code: 'FOREIGN_COLLECTION', message: '部分收藏夹不属于当前用户' }
    }
    // B4：pool.query('BEGIN') 是伪事务（池化连接下每条语句可能落在不同连接），
    // 改为专用连接上的显式事务，保证批量 reorder 全部生效或全部不生效。
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const o of pairs) {
        await client.query(
          'UPDATE favorite_collections SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
          [o.sortOrder, o.id, userId]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return { success: true, reordered: pairs.length }
  },

  'get_collection_items': async (args, userId, role) => {
    const { collection_id } = args
    if (!collection_id || !isValidUUID(collection_id)) {
      return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
    }
    const result = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size, ci.metadata, ci.is_favorite,
              ci.favorited_at, ci.created_at, ci.protection_level,
              d.device_name, d.platform, fci.sort_order
       FROM favorite_collection_items fci
       JOIN clipboard_items ci ON fci.item_id = ci.id
       LEFT JOIN devices d ON ci.source_device_id = d.id
       WHERE fci.collection_id = $1 AND ci.user_id = $2
         AND COALESCE(ci.protection_level, 'none') = 'none'
       ORDER BY fci.sort_order`,
      [collection_id, userId]
    )
    // 空列表时仍要区分「收藏夹不存在」与「收藏夹为空」
    if (result.rowCount === 0) {
      const col = await pool.query(
        'SELECT id FROM favorite_collections WHERE id = $1 AND user_id = $2',
        [collection_id, userId]
      )
      if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
    }
    return { items: result.rows, count: result.rowCount }
  },

  'add_item_to_collection': async (args, userId, role) => {
    const { collection_id, item_id } = args
    if (!collection_id || !item_id || !isValidUUID(collection_id) || !isValidUUID(item_id)) {
      return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'collection_id 与 item_id 必填且为合法 UUID' }
    }
    const col = await pool.query(
      'SELECT id FROM favorite_collections WHERE id = $1 AND user_id = $2',
      [collection_id, userId]
    )
    if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
    const item = await pool.query(
      'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [item_id, userId]
    )
    if (item.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
    // 唯一归属：先从其他收藏夹移除
    await pool.query(
      'DELETE FROM favorite_collection_items WHERE item_id = $1 AND collection_id <> $2',
      [item_id, collection_id]
    )
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM favorite_collection_items WHERE collection_id = $1',
      [collection_id]
    )
    await pool.query(
      `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
       VALUES ($1, $2, $3) ON CONFLICT (collection_id, item_id) DO NOTHING`,
      [collection_id, item_id, maxOrder.rows[0].next_order]
    )
    return {
      success: true,
      collection_id,
      item_id,
      note: '已加入收藏夹；若条目曾属于其他收藏夹，已自动解除旧归属（唯一归属）。',
    }
  },

  'remove_item_from_collection': async (args, userId, role) => {
    const { collection_id, item_id } = args
    if (!collection_id || !item_id || !isValidUUID(collection_id) || !isValidUUID(item_id)) {
      return { error: 'INVALID_ID', code: 'INVALID_ID' }
    }
    const result = await pool.query(
      `DELETE FROM favorite_collection_items
       WHERE collection_id = $1 AND item_id = $2
         AND collection_id IN (SELECT id FROM favorite_collections WHERE user_id = $3)`,
      [collection_id, item_id, userId]
    )
    return {
      success: true,
      removed: result.rowCount > 0,
      collection_id,
      item_id,
      note: '仅解除收藏夹关联，未删除剪贴板条目本身。',
    }
  },

  'update_collection_tags': async (args, userId, role) => {
    const { clip_id, tags } = args
    if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
    if (!Array.isArray(tags)) return { error: 'TAGS_REQUIRED', code: 'TAGS_REQUIRED', message: 'tags 必须是数组' }
    const cleanTags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
    const current = await pool.query(
      'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
      [clip_id, userId]
    )
    if (current.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
    // 全量替换 metadata.tags
    await pool.query(
      `UPDATE clipboard_items
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tags}', $1::jsonb), updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [JSON.stringify(cleanTags), clip_id, userId]
    )
    return { success: true, clip_id, tags: cleanTags, note: '已全量替换该条目的标签列表。' }
  },

  'delete_tag': async (args, userId, role) => {
    const { tag } = args
    if (!tag || !String(tag).trim()) return { error: 'TAG_REQUIRED', code: 'TAG_REQUIRED' }
    const cleanTag = String(tag).trim().slice(0, 30)
    // 从所有收藏项级联移除该标签
    const result = await pool.query(
      `UPDATE clipboard_items
       SET metadata = jsonb_set(metadata, '{tags}', (metadata->'tags') - $2), updated_at = NOW()
       WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' ? $2`,
      [userId, cleanTag]
    )
    return { success: true, deleted: result.rowCount, tag: cleanTag, note: '已从所有收藏项中级联移除该标签。' }
  },
}
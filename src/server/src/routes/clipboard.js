import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool.js';
import { broadcastToUser, sendNotification } from '../ws/server.js';
import { isValidUUID, isValidContentType, validatePagination, validateSearch, sanitizeString } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { checkClipboardLimit } from '../middleware/subscriptionCheck.js';
import { createIdempotencyMiddleware } from '../middleware/idempotency.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

const router = Router();

// 幂等中间件（requireHeader：仅当客户端携带 Idempotency-Key 时才生效，防止网络重试产生重复写入）
const idempotencyMiddleware = createIdempotencyMiddleware({ requireHeader: true });

// 将字符串映射为一对 31 位正整数，用于 pg_advisory_xact_lock（跨实例共享的会话级锁，
// 保证“去重查询 → 插入”在并发下原子，且不永久阻断 5 分钟后的重新复制）
function advisoryLockKey(str) {
  const h = crypto.createHash('md5').update(str).digest();
  return [h.readUInt32BE(0) & 0x7fffffff, h.readUInt32BE(4) & 0x7fffffff];
}

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
    const { page = 1, limit = 50, contentType, search, favorites, all, deviceId, dateFrom, dateTo, tag, view } = req.query;

    // 验证分页参数
    const pagination = validatePagination(page, limit, { all: all === 'true' });
    const offset = (pagination.page - 1) * pagination.limit;
    const useLimit = pagination.limit < Infinity

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

    // Archive view: default hides archived items; view=archive shows only archived
    if (view === 'archive') {
      whereClause += ' AND ci.archived = TRUE';
    } else {
      whereClause += ' AND ci.archived = FALSE';
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

    // Advanced filters: device / date range / tag
    if (deviceId) {
      if (!isValidUUID(deviceId)) {
        return res.status(400).json({ error: 'Invalid deviceId' });
      }
      whereClause += ` AND ci.source_device_id = $${paramIndex}`;
      params.push(deviceId);
      paramIndex++;
    }

    if (dateFrom) {
      const df = new Date(dateFrom);
      if (isNaN(df.getTime())) {
        return res.status(400).json({ error: 'Invalid dateFrom' });
      }
      whereClause += ` AND ci.created_at >= $${paramIndex}`;
      params.push(df.toISOString());
      paramIndex++;
    }

    if (dateTo) {
      const dt = new Date(dateTo);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ error: 'Invalid dateTo' });
      }
      whereClause += ` AND ci.created_at <= $${paramIndex}`;
      params.push(dt.toISOString());
      paramIndex++;
    }

    if (tag) {
      const cleanTag = sanitizeString(String(tag).trim());
      if (cleanTag) {
        whereClause += ` AND ci.metadata->'tags' @> $${paramIndex}::jsonb`;
        params.push(JSON.stringify([cleanTag]));
        paramIndex++;
      }
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM clipboard_items ci ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get items
    const limitClause = useLimit ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : ''
    const itemsResult = await pool.query(
      `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
              ci.source_device_id, ci.metadata, ci.is_favorite, ci.favorited_at, ci.expires_at, ci.archived, ci.created_at,
              ci.protection_level,
              d.device_name, d.platform
       FROM clipboard_items ci
       LEFT JOIN devices d ON ci.source_device_id = d.id
       ${whereClause}
       ORDER BY ci.created_at DESC
       ${limitClause}`,
      useLimit ? [...params, pagination.limit, offset] : params
    );

    res.json({
      items: itemsResult.rows.map(item => ({
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        favoritedAt: item.favorited_at,
        archived: item.archived,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        protectionLevel: item.protection_level || 'none',
        sourceDevice: {
          id: item.source_device_id,
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
    // Archived items are excluded from search results
    whereClause += ' AND ci.archived = FALSE';
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
              ci.metadata, ci.is_favorite, ci.archived, ci.expires_at, ci.created_at,
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
        archived: item.archived,
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

// GET /api/clipboard/:id/content - Get clipboard item content only (lightweight)
router.get('/:id/content', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // 验证ID格式
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await pool.query(
      `SELECT content_encrypted FROM clipboard_items WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    res.json({ contentEncrypted: result.rows[0].content_encrypted });
  } catch (err) {
    logger.error('Get clipboard content error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get clipboard content' });
  }
});

// POST /api/clipboard - Create a new clipboard item
// C2+C4 修复：去重（所有类型）+ 事务原子（插入/同步状态/审计 在一个事务内）
router.post('/', apiLimiter, idempotencyMiddleware, checkClipboardLimit, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error('Create clipboard item: failed to acquire DB client', { error: err.message });
    return res.status(500).json({ error: 'Failed to create clipboard item' });
  }
  let item = null;
  let deviceName = 'Unknown device';
  let srcDeviceId = null;
  let shouldBroadcast = false;
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

    // 验证内容大小（最大10MB，与 express.json body 上限保持一致，P1 修复）
    if (typeof contentEncrypted === 'string' && contentEncrypted.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Content too large, maximum size is 10MB' });
    }

    // Detect content type from preview or declared type
    const detectedType = detectContentType(contentPreview, contentType);
    if (!isValidContentType(detectedType)) {
      return res.status(400).json({ error: 'Invalid contentType. Valid values: text, image, file, link, code' });
    }

    // 清理预览内容 — 只做截断，不做 HTML 转义（contentPreview 用于前端展示，非 HTML 执行）
    const cleanPreview = contentPreview ? String(contentPreview).substring(0, 5000) : '';

    // 非文件类型按密文哈希去重；文件类型用路径去重（content_hash 留空）
    const isFile = detectedType === 'file';
    const contentHash = isFile ? null : crypto.createHash('sha256').update(contentEncrypted).digest('hex');
    srcDeviceId = sourceDeviceId;

    // Verify device belongs to user
    const deviceCheck = await client.query(
      'SELECT id, device_name FROM devices WHERE id = $1 AND user_id = $2',
      [sourceDeviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    deviceName = deviceCheck.rows[0]?.device_name || 'Unknown device';

    // 开启事务（C4：保证 去重检查 → 插入 → 同步状态 → 审计 原子）
    await client.query('BEGIN');

    // 去重：用 pg_advisory_xact_lock 串行化同 key 的并发插入（跨实例共享，避免竞态产生重复）
    // 5 分钟窗口由应用层判断，避免永久阻断“重新复制相同内容”（唯一索引做不到这点）
    let existing = null;
    const dedupKey = isFile
      ? `${req.userId}:file:${metadata?.paths?.[0] || ''}`
      : `${req.userId}:${contentHash}`;
    const [lock1, lock2] = advisoryLockKey(dedupKey);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lock1, lock2]);

    if (isFile && metadata && metadata.paths && metadata.paths.length > 0) {
      const dup = await client.query(
        `SELECT id, created_at FROM clipboard_items
         WHERE user_id = $1 AND content_type = 'file'
           AND metadata->'paths' @> $2::jsonb
           AND created_at > NOW() - INTERVAL '5 minutes'
         LIMIT 1`,
        [req.userId, JSON.stringify([metadata.paths[0]])]
      );
      if (dup.rows.length > 0) existing = dup.rows[0];
    } else if (contentHash) {
      const dup = await client.query(
        `SELECT id, created_at FROM clipboard_items
         WHERE user_id = $1 AND content_type <> 'file' AND content_hash = $2
           AND created_at > NOW() - INTERVAL '5 minutes'
         LIMIT 1`,
        [req.userId, contentHash]
      );
      if (dup.rows.length > 0) existing = dup.rows[0];
    }

    if (existing) {
      await client.query('COMMIT');
      return res.status(200).json({
        id: existing.id,
        contentType: isFile ? 'file' : detectedType,
        contentPreview: cleanPreview,
        contentSize: contentSize || 0,
        isFavorite: false,
        expiresAt: null,
        createdAt: existing.created_at,
        duplicate: true,
      });
    }

    const result = await client.query(
      `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, content_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, content_type, content_preview, content_size, is_favorite, expires_at, created_at`,
      [req.userId, sourceDeviceId, detectedType, contentEncrypted, cleanPreview, contentSize || 0, JSON.stringify(metadata || {}), contentHash, expiresAt || null]
    );

    item = result.rows[0];

    // Update device sync state
    await client.query(
      `INSERT INTO device_sync_state (device_id, last_synced_item_id, last_sync_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE
       SET last_synced_item_id = $2, last_sync_at = NOW()`,
      [sourceDeviceId, item.id]
    );

    // 审计日志：记录剪贴板创建（在事务内，保证一致性）
    await logAuditEvent({
      userId: req.userId,
      action: AUDIT_ACTIONS.CLIPBOARD_CREATE,
      resourceType: 'clipboard',
      resourceId: item.id,
      details: {
        contentType: detectedType,
        sourceDeviceId,
        contentSize,
      },
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('User-Agent') || '',
    });

    await client.query('COMMIT');
    shouldBroadcast = true;
  } catch (err) {
    // 回滚，避免脏数据（C4）
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    logger.error('Create clipboard item error:', { error: err.message });
    return res.status(500).json({ error: 'Failed to create clipboard item' });
  } finally {
    client.release();
  }

  // 提交后的副作用：广播 + 通知（不在事务内，避免外部调用拖慢/失败导致回滚）
  broadcastToUser(req.userId, {
    type: 'new_clipboard',
    item: {
      id: item.id,
      contentType: item.content_type,
      contentPreview: item.content_preview,
      contentSize: item.content_size,
      createdAt: item.created_at,
      sourceDeviceId: srcDeviceId,
    },
  });

  sendNotification(req.userId, {
    notificationType: 'sync_complete',
    title: 'New content synced',
    body: `${item.content_type.toUpperCase()} content from ${deviceName}`,
    data: { itemId: item.id, contentType: item.content_type },
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
       SET is_favorite = NOT is_favorite,
           favorited_at = CASE WHEN NOT is_favorite THEN NOW() ELSE NULL END
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_favorite, favorited_at`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Clipboard item not found' });
    }

    // Clean up collection associations when unfavoriting
    if (!result.rows[0].is_favorite) {
      await pool.query('DELETE FROM favorite_collection_items WHERE item_id = $1', [id]);
    }

    res.json({
      id: result.rows[0].id,
      isFavorite: result.rows[0].is_favorite,
      favoritedAt: result.rows[0].favorited_at,
    });

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

// PUT /api/clipboard/:id/sensitive - Toggle manual sensitive flag on item metadata
router.put('/:id/sensitive', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { sensitive } = req.body;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format' });
    if (typeof sensitive !== 'boolean') return res.status(400).json({ error: 'sensitive must be a boolean' });

    const result = await pool.query(
      `UPDATE clipboard_items
       SET metadata = jsonb_set(metadata, '{sensitive}', $1::jsonb)
       WHERE id = $2 AND user_id = $3
       RETURNING id, metadata`,
      [JSON.stringify(sensitive), id, req.userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Clipboard item not found' });

    res.json({ id: result.rows[0].id, sensitive, metadata: result.rows[0].metadata });
  } catch (err) {
    logger.error('Toggle sensitive error:', { error: err.message });
    res.status(500).json({ error: 'Failed to toggle sensitive' });
  }
});

// PUT /api/clipboard/:id - Update item (content + metadata shallow-merge)
// Used by: per-item password protection, tag editing, server-side content re-encrypt.
// Metadata merge is shallow (jsonb ||) — only allowed keys are written.
router.put('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, contentPreview, contentSize, metadata, archived } = req.body;

    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format' });

    // Validate the metadata patch — only allow known keys (shallow merge)
    let metaPatch = null;
    if (metadata !== undefined) {
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        return res.status(400).json({ error: 'metadata must be an object' });
      }
      const allowed = ['protected', 'protectedAt', 'tags'];
      metaPatch = {};
      for (const key of allowed) {
        if (key in metadata) metaPatch[key] = metadata[key];
      }
      if ('protected' in metaPatch && typeof metaPatch.protected !== 'boolean') {
        return res.status(400).json({ error: 'protected must be a boolean' });
      }
      if ('tags' in metaPatch && !Array.isArray(metaPatch.tags)) {
        return res.status(400).json({ error: 'tags must be an array' });
      }
      if ('protectedAt' in metaPatch && metaPatch.protectedAt !== null && typeof metaPatch.protectedAt !== 'string') {
        return res.status(400).json({ error: 'protectedAt must be a string or null' });
      }
    }

    // Validate content fields
    if (content !== undefined && typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (contentPreview !== undefined && typeof contentPreview !== 'string') {
      return res.status(400).json({ error: 'contentPreview must be a string' });
    }
    if (contentSize !== undefined && (!Number.isInteger(contentSize) || contentSize < 0)) {
      return res.status(400).json({ error: 'contentSize must be a non-negative integer' });
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      return res.status(400).json({ error: 'archived must be a boolean' });
    }

    // Build dynamic SET clause
    const setClauses = [];
    const params = [id, req.userId];
    let p = 3;

    if (content !== undefined) {
      setClauses.push(`content_encrypted = $${p++}`);
      params.push(content);
    }
    if (contentPreview !== undefined) {
      setClauses.push(`content_preview = $${p++}`);
      params.push(contentPreview);
    }
    if (contentSize !== undefined) {
      setClauses.push(`content_size = $${p++}`);
      params.push(contentSize);
    }
    if (metaPatch !== null) {
      setClauses.push(`metadata = metadata || $${p}::jsonb`);
      params.push(JSON.stringify(metaPatch));
      p++;
    }
    if (archived !== undefined) {
      setClauses.push(`archived = $${p++}`);
      params.push(archived);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await pool.query(
      `UPDATE clipboard_items
       SET ${setClauses.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING id, content_type, content_preview, content_size, metadata, is_favorite, archived, source_device_id, created_at`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Clipboard item not found' });

    const item = result.rows[0];
    const payload = {
      id: item.id,
      contentType: item.content_type,
      contentPreview: item.content_preview,
      contentSize: item.content_size,
      metadata: item.metadata,
      isFavorite: item.is_favorite,
      archived: item.archived,
      sourceDeviceId: item.source_device_id,
      createdAt: item.created_at,
    };
    res.json(payload);

    broadcastToUser(req.userId, { type: 'clipboard_updated', item: payload });
  } catch (err) {
    logger.error('Update clipboard item error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update clipboard item' });
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

    // 清理关联数据：从收藏夹中移除已删除的条目
    await pool.query('DELETE FROM favorite_collection_items WHERE item_id = $1', [id]);

    // 审计日志：记录剪贴板删除
    await logAuditEvent({
      userId: req.userId,
      action: AUDIT_ACTIONS.CLIPBOARD_DELETE,
      resourceType: 'clipboard',
      resourceId: id,
      details: {
        contentType: null, // 已删除，无法获取
      },
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('User-Agent') || '',
    });

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
      `DELETE FROM clipboard_items WHERE id = ANY($1::uuid[]) AND user_id = $2 RETURNING id`,
      [ids, req.userId]
    );

    // 清理关联数据：从收藏夹中移除已删除的条目
    await pool.query('DELETE FROM favorite_collection_items WHERE item_id = ANY($1::uuid[])', [ids]);

    logger.info('Batch delete', { userId: req.userId, requested: ids.length, deleted: result.rowCount });
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
              ci.metadata, ci.is_favorite, ci.archived, ci.expires_at, ci.created_at,
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
        archived: item.archived,
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

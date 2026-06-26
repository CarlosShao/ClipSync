import { Router } from 'express';
import pool from '../db/pool.js';
import { broadcastToUser } from '../ws/server.js';
import { isValidUUID, validatePagination } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import * as jsdiff from 'jsdiff';

const router = Router();

/**
 * POST /api/sync/push - Push local changes to server (offline queue flush)
 *
 * Body:
 *   deviceId: string (required)
 *   changes: Array<{ id?, action: 'create'|'update'|'delete', data: {...}, clientTimestamp: string }>
 *
 * Response:
 *   results: Array<{ clientId, serverId?, status: 'ok'|'conflict'|'error', serverData? }>
 *   conflicts: Array of conflict items
 */
router.post('/push', apiLimiter, async (req, res) => {
  try {
    const { deviceId, changes } = req.body;

    if (!deviceId || !isValidUUID(deviceId)) {
      return res.status(400).json({ error: 'deviceId 无效' });
    }

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'changes 不能为空' });
    }

    if (changes.length > 50) {
      return res.status(400).json({ error: '单次最多同步50条' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
    }

    const results = [];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const change of changes) {
        const { id, action, data, clientTimestamp } = change;

        try {
          if (action === 'create') {
            // Insert new item
            const result = await client.query(
              `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id, content_type, content_preview, content_size, is_favorite, created_at`,
              [
                req.userId, deviceId,
                data.contentType || 'text',
                data.contentEncrypted || '',
                data.contentPreview || '',
                data.contentSize || 0,
                JSON.stringify(data.metadata || {}),
                data.expiresAt || null,
              ]
            );

            results.push({
              clientId: id || change.clientId,
              serverId: result.rows[0].id,
              status: 'ok',
            });
          } else if (action === 'update' && id) {
            // Check for conflicts: is server version newer?
            const existing = await client.query(
              'SELECT id, updated_at, is_favorite, content_preview FROM clipboard_items WHERE id = $1 AND user_id = $2',
              [id, req.userId]
            );

            if (existing.rows.length === 0) {
              results.push({ clientId: id, status: 'error', error: 'item not found' });
              continue;
            }

            const serverItem = existing.rows[0];
            const serverTime = new Date(serverItem.updated_at).getTime();
            const clientTime = new Date(clientTimestamp || 0).getTime();

            if (clientTime < serverTime) {
              // Conflict: server version is newer
              const serverData = await client.query(
                'SELECT * FROM clipboard_items WHERE id = $1', [id]
              );
              results.push({
                clientId: id,
                status: 'conflict',
                serverData: serverData.rows[0],
              });
              continue;
            }

            // Calculate diff for large text content (content_preview > 10KB)
            let contentDiff = data.contentDiff || null;
            if (!contentDiff && data.contentPreview && data.contentPreview.length > 10240) {
              try {
                const oldPreview = serverItem.content_preview || '';
                contentDiff = jsdiff.createPatch('content', oldPreview, data.contentPreview);
              } catch (diffErr) {
                logger.warn('Failed to calculate diff', { error: diffErr.message });
              }
            }

            // Apply update
            await client.query(
              `UPDATE clipboard_items SET
                content_encrypted = COALESCE($1, content_encrypted),
                content_preview = COALESCE($2, content_preview),
                content_size = COALESCE($3, content_size),
                content_diff = $4,
                metadata = COALESCE($5, metadata),
                is_favorite = COALESCE($6, is_favorite),
                updated_at = NOW()
               WHERE id = $7 AND user_id = $8`,
              [
                data.contentEncrypted,
                data.contentPreview,
                data.contentSize,
                contentDiff,
                data.metadata ? JSON.stringify(data.metadata) : null,
                data.isFavorite,
                id, req.userId,
              ]
            );

            results.push({ clientId: id, serverId: id, status: 'ok' });
          } else if (action === 'delete' && id) {
            const result = await client.query(
              'DELETE FROM clipboard_items WHERE id = $1 AND user_id = $2 RETURNING id',
              [id, req.userId]
            );

            results.push({
              clientId: id,
              status: result.rowCount > 0 ? 'ok' : 'error',
              error: result.rowCount === 0 ? 'item not found' : undefined,
            });
          }
        } catch (err) {
          results.push({
            clientId: id || change.clientId,
            status: 'error',
            error: err.message,
          });
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Broadcast new items to other devices
    const okCreates = results.filter(r => r.status === 'ok' && r.serverId);
    if (okCreates.length > 0) {
      // Fetch full item data for broadcast
      const itemIds = okCreates.map(r => r.serverId);
      const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
      const itemsResult = await pool.query(
        `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
                ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at, ci.updated_at,
                ci.source_device_id,
                d.device_name, d.platform
         FROM clipboard_items ci
         LEFT JOIN devices d ON ci.source_device_id = d.id
         WHERE ci.id IN (${placeholders})`,
        itemIds
      );

      // Broadcast to other devices of the same user
      const items = itemsResult.rows.map(item => ({
        id: item.id,
        contentType: item.content_type,
        contentPreview: item.content_preview,
        contentSize: item.content_size,
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        sourceDeviceId: item.source_device_id,
        sourceDevice: {
          name: item.device_name,
          platform: item.platform,
        },
      }));

      broadcastToUser(req.userId, {
        type: 'new_clipboard',
        items,
        sourceDeviceId: deviceId,
        timestamp: new Date().toISOString(),
      });
    }

    const conflicts = results.filter(r => r.status === 'conflict');

    logger.info('Sync push completed', {
      userId: req.userId,
      deviceId,
      total: changes.length,
      ok: results.filter(r => r.status === 'ok').length,
      conflicts: conflicts.length,
      errors: results.filter(r => r.status === 'error').length,
    });

    res.json({ results, conflicts });
  } catch (err) {
    logger.error('Sync push error', { error: err.message });
    res.status(500).json({ error: '同步推送失败' });
  }
});

/**
 * GET /api/sync/pull/:deviceId?since=ISO_DATE - Pull changes since timestamp
 *
 * Response:
 *   items: Array of clipboard items
 *   hasMore: boolean
 */
router.get('/pull/:deviceId', apiLimiter, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { since, limit = 100 } = req.query;

    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: '设备ID无效' });
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.userId]
    );
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: '设备不存在' });
    }

    let query;
    const params = [req.userId, Math.min(parseInt(limit) || 100, 200)];
    let paramIndex = 3;

    if (since) {
      query = `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
                      ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at, ci.updated_at,
                      ci.content_diff,
                      ci.source_device_id,
                      d.device_name, d.platform
               FROM clipboard_items ci
               LEFT JOIN devices d ON ci.source_device_id = d.id
               WHERE ci.user_id = $1
                 AND ci.id NOT IN (
                   SELECT device_id FROM device_sync_state
                   WHERE device_id = $2
                 )
                 AND ci.created_at > $${paramIndex}
               ORDER BY ci.created_at DESC
               LIMIT $2`;
      params.push(new Date(since));
    } else {
      // Full sync: get all items
      query = `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size,
                      ci.metadata, ci.is_favorite, ci.expires_at, ci.created_at, ci.updated_at,
                      ci.content_diff,
                      ci.source_device_id,
                      d.device_name, d.platform
               FROM clipboard_items ci
               LEFT JOIN devices d ON ci.source_device_id = d.id
               WHERE ci.user_id = $1
               ORDER BY ci.created_at DESC
               LIMIT $2`;
    }

    const result = await pool.query(query, params);

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
        contentDiff: item.content_diff, // Incremental sync support
        metadata: item.metadata,
        isFavorite: item.is_favorite,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        sourceDeviceId: item.source_device_id,
        sourceDevice: {
          name: item.device_name,
          platform: item.platform,
        },
      })),
      hasMore: result.rows.length >= Math.min(parseInt(limit) || 100, 200),
      lastSyncAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Sync pull error', { error: err.message });
    res.status(500).json({ error: '同步拉取失败' });
  }
});

/**
 * GET /api/sync/status/:deviceId - Get sync status for a device
 */
router.get('/status/:deviceId', apiLimiter, async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: '设备ID无效' });
    }

    const result = await pool.query(
      `SELECT dss.*, d.device_name
       FROM device_sync_state dss
       JOIN devices d ON dss.device_id = d.id
       WHERE dss.device_id = $1 AND d.user_id = $2`,
      [deviceId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ synced: false, lastSyncAt: null });
    }

    const state = result.rows[0];
    res.json({
      synced: true,
      lastSyncAt: state.last_sync_at,
      lastSyncedItemId: state.last_synced_item_id,
      deviceName: state.device_name,
    });
  } catch (err) {
    logger.error('Sync status error', { error: err.message });
    res.status(500).json({ error: '获取同步状态失败' });
  }
});

export default router;

/**
 * 文件版本管理模块
 *
 * 功能：
 * 1. 创建新版本：当剪贴板内容更新时自动创建历史版本
 * 2. 查询版本历史：获取某个剪贴板项的所有版本
 * 3. 获取特定版本：获取某个版本的详细内容
 * 4. 恢复版本：将剪贴板项恢复到指定历史版本
 * 5. 清理旧版本：自动清理超过保留期限的旧版本
 */

import pool from '../db/pool.js';

/**
 * 版本管理配置
 */
const VERSION_CONFIG = {
  maxVersionsPerItem: 50,      // 每个项最大保留版本数
  retentionDays: 90,            // 版本保留天数
  autoCleanupInterval: 3600000, // 自动清理间隔（1小时）
};

/**
 * 创建新版本
 * @param {Object} params - 版本参数
 * @param {string} params.clipboardItemId - 剪贴板项ID
 * @param {string} params.userId - 用户ID
 * @param {string} params.contentEncrypted - 加密内容
 * @param {string} params.contentPreview - 内容预览
 * @param {number} params.contentSize - 内容大小
 * @param {Object} params.metadata - 元数据
 * @param {string} params.sourceDeviceId - 源设备ID
 * @param {string} params.changeDescription - 变更描述
 * @returns {Object} 新创建的版本
 */
export async function createVersion({
  clipboardItemId,
  userId,
  contentEncrypted,
  contentPreview,
  contentSize,
  metadata,
  sourceDeviceId,
  changeDescription,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 获取当前最大版本号
    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) as max_version FROM file_versions WHERE clipboard_item_id = $1',
      [clipboardItemId]
    );
    const nextVersionNumber = maxVersionResult.rows[0].max_version + 1;

    // 创建新版本
    const result = await client.query(
      `INSERT INTO file_versions (
        clipboard_item_id, user_id, version_number,
        content_encrypted, content_preview, content_size,
        metadata, source_device_id, change_description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        clipboardItemId,
        userId,
        nextVersionNumber,
        contentEncrypted,
        contentPreview,
        contentSize,
        JSON.stringify(metadata || {}),
        sourceDeviceId,
        changeDescription || `Version ${nextVersionNumber}`,
      ]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 查询剪贴板项的版本历史
 * @param {string} clipboardItemId - 剪贴板项ID
 * @param {string} userId - 用户ID
 * @param {Object} options - 查询选项
 * @param {number} options.page - 页码（从1开始）
 * @param {number} options.limit - 每页数量
 * @returns {Object} 版本列表和分页信息
 */
export async function getVersionHistory(clipboardItemId, userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  // 获取总数
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM file_versions WHERE clipboard_item_id = $1 AND user_id = $2',
    [clipboardItemId, userId]
  );
  const total = parseInt(countResult.rows[0].count);

  // 获取版本列表
  const result = await pool.query(
    `SELECT fv.*, d.device_name, d.platform
     FROM file_versions fv
     LEFT JOIN devices d ON fv.source_device_id = d.id
     WHERE fv.clipboard_item_id = $1 AND fv.user_id = $2
     ORDER BY fv.version_number DESC
     LIMIT $3 OFFSET $4`,
    [clipboardItemId, userId, limit, offset]
  );

  return {
    versions: result.rows.map(v => ({
      id: v.id,
      versionNumber: v.version_number,
      contentPreview: v.content_preview,
      contentSize: v.content_size,
      metadata: v.metadata,
      changeDescription: v.change_description,
      sourceDevice: {
        name: v.device_name,
        platform: v.platform,
      },
      createdAt: v.created_at,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * 获取特定版本的详细内容（包含加密内容）
 * @param {string} versionId - 版本ID
 * @param {string} userId - 用户ID
 * @returns {Object} 版本详细信息
 */
export async function getVersionDetail(versionId, userId) {
  const result = await pool.query(
    `SELECT fv.*, d.device_name, d.platform
     FROM file_versions fv
     LEFT JOIN devices d ON fv.source_device_id = d.id
     WHERE fv.id = $1 AND fv.user_id = $2`,
    [versionId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const v = result.rows[0];
  return {
    id: v.id,
    clipboardItemId: v.clipboard_item_id,
    versionNumber: v.version_number,
    contentEncrypted: v.content_encrypted,
    contentPreview: v.content_preview,
    contentSize: v.content_size,
    metadata: v.metadata,
    changeDescription: v.change_description,
    sourceDevice: {
      id: v.source_device_id,
      name: v.device_name,
      platform: v.platform,
    },
    createdAt: v.created_at,
  };
}

/**
 * 恢复到指定版本
 * @param {string} versionId - 要恢复的版本ID
 * @param {string} userId - 用户ID
 * @returns {Object} 恢复后的剪贴板项
 */
export async function restoreVersion(versionId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 获取版本详情
    const versionResult = await client.query(
      'SELECT * FROM file_versions WHERE id = $1 AND user_id = $2',
      [versionId, userId]
    );

    if (versionResult.rows.length === 0) {
      throw new Error('Version not found');
    }

    const version = versionResult.rows[0];

    // 更新剪贴板项为版本内容
    const updateResult = await client.query(
      `UPDATE clipboard_items
       SET content_encrypted = $1,
           content_preview = $2,
           content_size = $3,
           metadata = $4,
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [
        version.content_encrypted,
        version.content_preview,
        version.content_size,
        version.metadata,
        version.clipboard_item_id,
        userId,
      ]
    );

    if (updateResult.rows.length === 0) {
      throw new Error('Clipboard item not found');
    }

    // 为恢复操作创建新版本记录
    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) as max_version FROM file_versions WHERE clipboard_item_id = $1',
      [version.clipboard_item_id]
    );
    const nextVersionNumber = maxVersionResult.rows[0].max_version + 1;

    await client.query(
      `INSERT INTO file_versions (
        clipboard_item_id, user_id, version_number,
        content_encrypted, content_preview, content_size,
        metadata, source_device_id, change_description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        version.clipboard_item_id,
        userId,
        nextVersionNumber,
        version.content_encrypted,
        version.content_preview,
        version.content_size,
        version.metadata,
        version.source_device_id,
        `Restored to version ${version.version_number}`,
      ]
    );

    await client.query('COMMIT');

    return {
      item: updateResult.rows[0],
      restoredFromVersion: version.version_number,
      newVersionNumber: nextVersionNumber,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 清理旧版本
 * @param {number} retentionDays - 保留天数（可选，默认使用配置值）
 * @returns {number} 清理的版本数量
 */
export async function cleanupOldVersions(retentionDays = VERSION_CONFIG.retentionDays) {
  const result = await pool.query(
    `DELETE FROM file_versions
     WHERE created_at < NOW() - INTERVAL '1 day' * $1
     AND id NOT IN (
       -- 保留每个项的最新版本
       SELECT DISTINCT ON (clipboard_item_id) id
       FROM file_versions
       ORDER BY clipboard_item_id, version_number DESC
     )`,
    [retentionDays]
  );

  return result.rowCount;
}

/**
 * 限制每个项的版本数量
 * @param {number} maxVersions - 每个项最大版本数（可选，默认使用配置值）
 * @returns {number} 清理的版本数量
 */
export async function limitVersionsPerItem(maxVersions = VERSION_CONFIG.maxVersionsPerItem) {
  const result = await pool.query(
    `DELETE FROM file_versions
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (PARTITION BY clipboard_item_id ORDER BY version_number DESC) as rn
         FROM file_versions
       ) t
       WHERE rn > $1
     )`,
    [maxVersions]
  );

  return result.rowCount;
}

/**
 * 获取版本统计信息
 * @param {string} userId - 用户ID
 * @returns {Object} 统计信息
 */
export async function getVersionStats(userId) {
  const result = await pool.query(
    `SELECT
       COUNT(*) as total_versions,
       COUNT(DISTINCT clipboard_item_id) as items_with_versions,
       COALESCE(SUM(content_size), 0) as total_size,
       COALESCE(AVG(content_size), 0) as avg_size,
       MIN(created_at) as oldest_version,
       MAX(created_at) as newest_version
     FROM file_versions
     WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0];
}

export default {
  createVersion,
  getVersionHistory,
  getVersionDetail,
  restoreVersion,
  cleanupOldVersions,
  limitVersionsPerItem,
  getVersionStats,
  VERSION_CONFIG,
};
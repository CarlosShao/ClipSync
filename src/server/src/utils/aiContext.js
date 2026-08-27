import pool from '../db/pool.js'

/**
 * 获取 ClipSync AI 所需的完整用户上下文（一次查询聚合）。
 * 供 /api/ai/context 与 get_ai_context 工具共用。
 */
export async function getAiContext(userId) {
  const [
    statsResult,
    collectionsResult,
    tagsResult,
    devicesResult,
    templatesResult,
    variablesResult,
    sharedLinksResult,
    recentResult,
    subscriptionResult,
    memoriesResult,
  ] = await Promise.all([
    // 1. 剪贴板统计
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE content_type = 'text')::int AS text_count,
        COUNT(*) FILTER (WHERE content_type = 'image')::int AS image_count,
        COUNT(*) FILTER (WHERE content_type = 'file')::int AS file_count,
        COUNT(*) FILTER (WHERE content_type = 'link')::int AS link_count,
        COUNT(*) FILTER (WHERE content_type = 'code')::int AS code_count,
        COUNT(*) FILTER (WHERE is_favorite = true)::int AS favorite_items_count,
        COUNT(*) FILTER (WHERE archived = true)::int AS archived_count
      FROM clipboard_items
      WHERE user_id = $1
      `,
      [userId]
    ),

    // 2. 收藏夹统计
    pool.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM favorite_collections WHERE user_id = $1) AS collections_count,
        (SELECT COUNT(*)::int FROM favorite_collection_items fci
         JOIN favorite_collections fc ON fci.collection_id = fc.id
         WHERE fc.user_id = $1) AS collection_items_count
      `,
      [userId]
    ),

    // 3. 标签统计
    pool.query(
      `
      SELECT COUNT(DISTINCT tag)::int AS tags_count
      FROM (
        SELECT jsonb_array_elements_text(metadata->'tags') AS tag
        FROM clipboard_items
        WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' IS NOT NULL
      ) t
      WHERE tag IS NOT NULL
      `,
      [userId]
    ),

    // 4. 设备统计
    pool.query(
      `
      SELECT
        COUNT(*)::int AS devices_count,
        COUNT(*) FILTER (WHERE is_online = true)::int AS online_devices_count
      FROM devices
      WHERE user_id = $1
      `,
      [userId]
    ),

    // 5. 模板统计
    pool.query(
      `SELECT COUNT(*)::int AS templates_count FROM clipboard_templates WHERE user_id = $1`,
      [userId]
    ),

    // 6. 模板变量统计
    pool.query(
      `SELECT COUNT(*)::int AS variables_count FROM template_variables WHERE user_id = $1`,
      [userId]
    ),

    // 7. 共享链接统计
    pool.query(
      `SELECT COUNT(*)::int AS shared_links_count FROM shared_links WHERE user_id = $1`,
      [userId]
    ),

    // 8. 最近 5 条条目预览（B2：高级密码保护条目不进 AI 上下文，防明文预览泄露）
    pool.query(
      `
      SELECT id, content_type, content_preview, is_favorite, created_at
      FROM clipboard_items
      WHERE user_id = $1 AND archived = FALSE
        AND COALESCE(protection_level, 'none') = 'none'
      ORDER BY created_at DESC
      LIMIT 5
      `,
      [userId]
    ),

    // 9. 当前订阅套餐
    pool.query(
      `
      SELECT sp.name AS plan_name, sp.display_name, sp.max_devices, sp.max_clipboard_items,
             sp.max_file_size_mb, sp.max_storage_mb
      FROM user_subscriptions us
      JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE us.user_id = $1 AND us.status = 'active'
      ORDER BY us.current_period_end DESC
      LIMIT 1
      `,
      [userId]
    ),

    // 10. 用户长程记忆（跨会话）
    pool.query(
      `
      SELECT id, category, title, content, updated_at
      FROM ai_memories
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 50
      `,
      [userId]
    ),
  ])

  const stats = statsResult.rows[0] || {}
  const collections = collectionsResult.rows[0] || {}
  const tags = tagsResult.rows[0] || {}
  const devices = devicesResult.rows[0] || {}
  const templates = templatesResult.rows[0] || {}
  const variables = variablesResult.rows[0] || {}
  const sharedLinks = sharedLinksResult.rows[0] || {}
  const subscription = subscriptionResult.rows[0] || null
  const memories = memoriesResult.rows || []

  return {
    stats: {
      total: stats.total || 0,
      textCount: stats.text_count || 0,
      imageCount: stats.image_count || 0,
      fileCount: stats.file_count || 0,
      linkCount: stats.link_count || 0,
      codeCount: stats.code_count || 0,
      favoriteItemsCount: stats.favorite_items_count || 0,
      archivedCount: stats.archived_count || 0,
    },
    collections: {
      collectionsCount: collections.collections_count || 0,
      collectionItemsCount: collections.collection_items_count || 0,
    },
    tags: {
      tagsCount: tags.tags_count || 0,
    },
    devices: {
      devicesCount: devices.devices_count || 0,
      onlineDevicesCount: devices.online_devices_count || 0,
    },
    templates: {
      templatesCount: templates.templates_count || 0,
      variablesCount: variables.variables_count || 0,
    },
    sharedLinks: {
      sharedLinksCount: sharedLinks.shared_links_count || 0,
    },
    recentItems: recentResult.rows.map((i) => ({
      id: i.id,
      type: i.content_type,
      preview: (i.content_preview || '').slice(0, 120),
      isFavorite: i.is_favorite,
      createdAt: i.created_at,
    })),
    subscription,
    memories: memories.map((m) => ({
      id: m.id,
      category: m.category,
      title: m.title,
      content: m.content,
      updatedAt: m.updated_at,
    })),
  }
}

export default { getAiContext }

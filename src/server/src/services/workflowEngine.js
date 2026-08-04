import pool from '../db/pool.js'
import { logger } from '../utils/logger.js'

/**
 * 工作流规则引擎（任务 #237）
 *
 * runWorkflowRulesForItem(userId, { id, contentType, preview, metadata, encrypted })：
 * 在剪贴板条目创建后调用。加载用户全部启用的规则，按 priority 降序匹配，
 * 匹配成功的规则执行对应动作（收藏/归档/打标签/移入收藏夹）。
 *
 * 设计要点：
 * - 只在"新条目"上执行（创建后调用），不做全量回溯。
 * - 执行失败静默降级（try/catch 包裹每条规则），绝不抛错影响主流程。
 * - 动作是幂等的：收藏/归档 用 UPDATE ... WHERE 条件自保护；打标签用 jsonb 合并。
 */

/** 关键词匹配（大小写不敏感，支持中文子串） */
function matchKeywords(preview, keywords, mode) {
  if (!keywords || keywords.length === 0) return false
  const text = (preview || '').toLowerCase()
  if (mode === 'regex') {
    return keywords.some((k) => {
      try {
        return new RegExp(k, 'i').test(text)
      } catch {
        return false
      }
    })
  }
  // keyword：所有关键词需全部命中（AND），与"任一命中"相比更可控、误伤更少
  return keywords.every((k) => text.includes(k.toLowerCase()))
}

/** 执行单条规则动作，返回是否执行成功 */
async function applyAction(userId, item, rule) {
  const { action_type, action_value, action_apply_tags } = rule
  switch (action_type) {
    case 'favorite': {
      await pool.query(
        `UPDATE clipboard_items SET is_favorite = TRUE, favorited_at = NOW()
         WHERE id = $1 AND user_id = $2 AND is_favorite = FALSE`,
        [item.id, userId]
      )
      return true
    }
    case 'archive': {
      await pool.query(
        `UPDATE clipboard_items SET archived = TRUE
         WHERE id = $1 AND user_id = $2 AND archived = FALSE`,
        [item.id, userId]
      )
      return true
    }
    case 'tag': {
      const tags = action_apply_tags && action_apply_tags.length > 0
        ? action_apply_tags
        : (action_value ? [action_value] : [])
      if (tags.length === 0) return false
      // jsonb 合并去重：保留已有 tags，追加新标签
      // 注意参数顺序：$1=id, $2=userId, $3=tags（不能把 userId 当 tags 强转）；
      // jsonb_set 第 4 参数 create_missing 必须为 true（false=键不存在时不创建，白跑）
      await pool.query(
        `UPDATE clipboard_items
         SET metadata = jsonb_set(
               COALESCE(metadata, '{}'),
               '{tags}',
               COALESCE(metadata->'tags', '[]'::jsonb) || $3::jsonb,
               true
             )
         WHERE id = $1 AND user_id = $2`,
        [item.id, userId, JSON.stringify(tags.map((x) => x.trim()).filter(Boolean))]
      )
      return true
    }
    case 'move_to_collection': {
      if (!action_value) return false
      // 收藏夹：先确保是收藏，再尝试加入/创建名为 action_value 的收藏夹
      await pool.query(
        `UPDATE clipboard_items SET is_favorite = TRUE, favorited_at = COALESCE(favorited_at, NOW())
         WHERE id = $1 AND user_id = $2 AND is_favorite = FALSE`,
        [item.id, userId]
      )
      // 找到或创建收藏夹
      const col = await pool.query(
        `SELECT id FROM favorite_collections WHERE user_id = $1 AND name = $2 LIMIT 1`,
        [userId, action_value]
      )
      let colId
      if (col.rowCount > 0) {
        colId = col.rows[0].id
      } else {
        const newCol = await pool.query(
          `INSERT INTO favorite_collections (user_id, name)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, action_value]
        )
        if (newCol.rowCount > 0) {
          colId = newCol.rows[0].id
        } else {
          const again = await pool.query(
            `SELECT id FROM favorite_collections WHERE user_id = $1 AND name = $2 LIMIT 1`,
            [userId, action_value]
          )
          colId = again.rows[0]?.id
        }
      }
      if (!colId) return false
      await pool.query(
        `INSERT INTO favorite_collection_items (collection_id, item_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [colId, item.id]
      )
      return true
    }
    default:
      return false
  }
}

/**
 * 入口：新剪贴板条目创建后调用。
 * @param {string} userId
 * @param {{ id: string, contentType: string, preview: string, metadata?: object }} item
 */
export async function runWorkflowRulesForItem(userId, item) {
  try {
    const result = await pool.query(
      `SELECT id, name, content_type, match_mode, keywords, action_type, action_value, action_apply_tags, priority
       FROM workflow_rules
       WHERE user_id = $1 AND enabled = TRUE
       ORDER BY priority DESC, created_at ASC`,
      [userId]
    )
    if (result.rowCount === 0) return { matched: 0, actions: [] }
    const applied = []
    for (const rule of result.rows) {
      // 类型过滤：规则限定类型或所有类型
      if (rule.content_type !== 'text' && rule.content_type !== item.contentType) continue
      const matched = matchKeywords(item.preview, rule.keywords, rule.match_mode)
      if (!matched) continue
      try {
        const ok = await applyAction(userId, item, rule)
        if (ok) applied.push({ ruleId: rule.id, ruleName: rule.name, action: rule.action_type })
        // 命中后默认只执行一条（高优先级优先），避免同一内容被多条规则反复改
        // （如需多动作叠加，可在后续迭代改为收集所有命中规则一起执行）
        break
      } catch (e) {
        logger.warn('[Workflow] rule action failed:', { ruleId: rule.id, error: e.message })
      }
    }
    return { matched: applied.length, actions: applied }
  } catch (e) {
    logger.warn('[Workflow] engine error:', e.message)
    return { matched: 0, actions: [] }
  }
}

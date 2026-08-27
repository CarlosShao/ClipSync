import pool from '../../../db/pool.js'
import { getVersionHistory, restoreVersion } from '../../../utils/versionManager.js'
import { isValidUUID } from '../shared.js'

export const notificationsWorkflowHandlers = {
  'get_notifications': async (args, userId, role) => {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, notification_type, title, body, read, created_at
           FROM notification_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { notifications: result.rows, count: result.rowCount }
      },

  'get_workflow_rules': async (args, userId, role) => {
        const result = await pool.query(
          `SELECT id, name, enabled, content_type, match_mode, keywords, action_type,
                  action_value, action_apply_tags, priority, created_at, updated_at
           FROM workflow_rules
           WHERE user_id = $1
           ORDER BY enabled DESC, priority DESC, created_at DESC`,
          [userId]
        )
        return { rules: result.rows, count: result.rowCount }
      },

  'create_workflow_rule': async (args, userId, role) => {
        const VALID_TYPES = ['text', 'image', 'file', 'link', 'code']
        const VALID_MODES = ['keyword', 'regex']
        const VALID_ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']
        const name = String(args.name || '').trim().slice(0, 100)
        if (!name) return { error: 'RULE_NAME_REQUIRED', code: 'RULE_NAME_REQUIRED', message: 'name 必填' }
        const content_type = VALID_TYPES.includes(args.contentType) ? args.contentType : 'text'
        const match_mode = VALID_MODES.includes(args.matchMode) ? args.matchMode : 'keyword'
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 100)).slice(0, 20)
          : []
        if (keywords.length === 0) {
          return { error: 'KEYWORDS_REQUIRED', code: 'KEYWORDS_REQUIRED', message: '至少需要一个关键词/正则' }
        }
        const action_type = VALID_ACTIONS.includes(args.actionType) ? args.actionType : 'favorite'
        const action_value = typeof args.actionValue === 'string' ? args.actionValue.trim().slice(0, 100) : null
        const action_apply_tags = Array.isArray(args.actionApplyTags)
          ? args.actionApplyTags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 10)
          : null
        const priority = Number.isFinite(Number(args.priority)) ? Math.min(1000, Math.max(0, Number(args.priority))) : 100
        const enabled = args.enabled !== false
        if (action_type === 'tag' && !action_value && (!action_apply_tags || action_apply_tags.length === 0)) {
          return { error: 'TAG_ACTION_REQUIRES_VALUE', code: 'TAG_ACTION_REQUIRES_VALUE', message: 'tag 动作需要 actionValue 或 actionApplyTags' }
        }
        const result = await pool.query(
          `INSERT INTO workflow_rules
             (user_id, name, enabled, content_type, match_mode, keywords, action_type, action_value, action_apply_tags, priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, created_at`,
          [userId, name, enabled, content_type, match_mode, JSON.stringify(keywords), action_type, action_value, action_apply_tags ? JSON.stringify(action_apply_tags) : null, priority]
        )
        return { success: true, rule_id: result.rows[0].id, note: '工作流规则已创建。' }
      },

  'update_workflow_rule': async (args, userId, role) => {
        const { rule_id } = args
        if (!rule_id || !isValidUUID(rule_id)) {
          return { error: 'INVALID_RULE', code: 'INVALID_RULE', message: 'rule_id 必填且为合法 UUID' }
        }
        const VALID_TYPES = ['text', 'image', 'file', 'link', 'code']
        const VALID_MODES = ['keyword', 'regex']
        const VALID_ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']
        const name = String(args.name || '').trim().slice(0, 100)
        if (!name) return { error: 'RULE_NAME_REQUIRED', code: 'RULE_NAME_REQUIRED', message: 'name 必填' }
        const content_type = VALID_TYPES.includes(args.contentType) ? args.contentType : 'text'
        const match_mode = VALID_MODES.includes(args.matchMode) ? args.matchMode : 'keyword'
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 100)).slice(0, 20)
          : []
        if (keywords.length === 0) {
          return { error: 'KEYWORDS_REQUIRED', code: 'KEYWORDS_REQUIRED', message: '至少需要一个关键词/正则' }
        }
        const action_type = VALID_ACTIONS.includes(args.actionType) ? args.actionType : 'favorite'
        const action_value = typeof args.actionValue === 'string' ? args.actionValue.trim().slice(0, 100) : null
        const action_apply_tags = Array.isArray(args.actionApplyTags)
          ? args.actionApplyTags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 10)
          : null
        const priority = Number.isFinite(Number(args.priority)) ? Math.min(1000, Math.max(0, Number(args.priority))) : 100
        const enabled = args.enabled !== false
        if (action_type === 'tag' && !action_value && (!action_apply_tags || action_apply_tags.length === 0)) {
          return { error: 'TAG_ACTION_REQUIRES_VALUE', code: 'TAG_ACTION_REQUIRES_VALUE', message: 'tag 动作需要 actionValue 或 actionApplyTags' }
        }
        const result = await pool.query(
          `UPDATE workflow_rules SET
             name=$1, enabled=$2, content_type=$3, match_mode=$4, keywords=$5,
             action_type=$6, action_value=$7, action_apply_tags=$8, priority=$9, updated_at=NOW()
           WHERE id=$10 AND user_id=$11
           RETURNING id`,
          [name, enabled, content_type, match_mode, JSON.stringify(keywords), action_type, action_value, action_apply_tags ? JSON.stringify(action_apply_tags) : null, priority, rule_id, userId]
        )
        if (result.rowCount === 0) return { error: 'RULE_NOT_FOUND', code: 'RULE_NOT_FOUND' }
        return { success: true, rule_id, note: '工作流规则已更新。' }
      },

  'delete_workflow_rule': async (args, userId, role) => {
        const { rule_id } = args
        if (!rule_id || !isValidUUID(rule_id)) {
          return { error: 'INVALID_RULE', code: 'INVALID_RULE', message: 'rule_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM workflow_rules WHERE id = $1 AND user_id = $2 RETURNING id',
          [rule_id, userId]
        )
        if (del.rowCount === 0) return { error: 'RULE_NOT_FOUND', code: 'RULE_NOT_FOUND' }
        return { success: true, rule_id, note: '工作流规则已删除。' }
      },

  'get_notification_preferences': async (args, userId, role) => {
        const result = await pool.query(
          'SELECT id, notification_type, enabled, created_at, updated_at FROM notification_preferences WHERE user_id = $1 ORDER BY notification_type',
          [userId]
        )
        return { preferences: result.rows, count: result.rowCount }
      },

  'update_notification_preferences': async (args, userId, role) => {
        const { notification_type, enabled } = args
        if (typeof notification_type !== 'string' || !notification_type.trim()) {
          return { error: 'NOTIFICATION_TYPE_REQUIRED', code: 'NOTIFICATION_TYPE_REQUIRED' }
        }
        if (typeof enabled !== 'boolean') {
          return { error: 'ENABLED_REQUIRED', code: 'ENABLED_REQUIRED', message: 'enabled 必填布尔值' }
        }
        const type = notification_type.trim().slice(0, 50)
        const result = await pool.query(
          `INSERT INTO notification_preferences (user_id, notification_type, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, notification_type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
           RETURNING id, notification_type, enabled, created_at, updated_at`,
          [userId, type, enabled]
        )
        return { preference: result.rows[0] }
      },

  'mark_notification_read': async (args, userId, role) => {
        const { notification_id } = args
        if (!notification_id) return { error: 'NOTIFICATION_ID_REQUIRED', code: 'NOTIFICATION_ID_REQUIRED' }
        const result = await pool.query(
          'UPDATE notification_history SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id, notification_type, title, status, read_at',
          [notification_id, userId]
        )
        if (result.rowCount === 0) return { error: 'NOTIFICATION_NOT_FOUND', code: 'NOTIFICATION_NOT_FOUND' }
        return { success: true, notification: result.rows[0] }
      },

  'get_version_history': async (args, userId, role) => {
        const { clipboard_item_id, page = 1, limit = 20 } = args
        if (!clipboard_item_id || !isValidUUID(clipboard_item_id)) {
          return { error: 'INVALID_CLIP', code: 'INVALID_CLIPBOARD_ITEM', message: 'clipboard_item_id 必填且为合法 UUID' }
        }
        const pg = Math.max(1, parseInt(page, 10) || 1)
        const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20))
        return await getVersionHistory(clipboard_item_id, userId, { page: pg, limit: lim })
      },

  'restore_version': async (args, userId, role) => {
        // 破坏性工具（确认门控）。
        const { version_id } = args
        if (!version_id || !isValidUUID(version_id)) {
          return { error: 'INVALID_VERSION', code: 'INVALID_VERSION', message: 'version_id 必填且为合法 UUID' }
        }
        try {
          const result = await restoreVersion(version_id, userId)
          return {
            success: true,
            itemId: result.item.id,
            restoredFromVersion: result.restoredFromVersion,
            newVersionNumber: result.newVersionNumber,
            note: '已恢复到指定历史版本，并生成新的版本记录。',
          }
        } catch (err) {
          if (err.message === 'Version not found') return { error: 'VERSION_NOT_FOUND', code: 'VERSION_NOT_FOUND' }
          if (err.message === 'Clipboard item not found') return { error: 'CLIP_ITEM_NOT_FOUND', code: 'CLIP_ITEM_NOT_FOUND' }
          throw err
        }
      },
}
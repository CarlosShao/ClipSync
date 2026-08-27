import pool from '../../../db/pool.js'
import { isValidUUID } from '../shared.js'

export const templatesHandlers = {
  'get_templates': async (args, userId, role) => {
        // clipboard_templates 真实列为 name/content，无 content_preview/shortcut
        const result = await pool.query(
          `SELECT id, name, content, created_at, updated_at
           FROM clipboard_templates
           WHERE user_id = $1
           ORDER BY updated_at DESC`,
          [userId]
        )
        return { templates: result.rows, count: result.rowCount }
      },

  'create_template': async (args, userId, role) => {
        const { name, content } = args
        if (!name || !String(name).trim()) {
          return { error: 'name is required' }
        }
        const safeName = String(name).trim().slice(0, 200)
        const safeContent = typeof content === 'string' ? content : ''
        const result = await pool.query(
          `INSERT INTO clipboard_templates (user_id, name, content)
           VALUES ($1, $2, $3)
           RETURNING id, name, content, created_at, updated_at`,
          [userId, safeName, safeContent]
        )
        return { template: result.rows[0] }
      },

  'update_template': async (args, userId, role) => {
        const { template_id, name, content } = args
        if (!template_id) return { error: 'template_id is required' }
        const fields = []
        const params = []
        let idx = 1
        if (typeof name === 'string' && name.trim()) {
          fields.push(`name = $${idx++}`)
          params.push(name.trim().slice(0, 200))
        }
        if (typeof content === 'string') {
          fields.push(`content = $${idx++}`)
          params.push(content)
        }
        if (fields.length === 0) return { error: 'name 或 content 至少提供一个要更新的字段' }
        fields.push('updated_at = NOW()')
        params.push(userId, template_id)
        const result = await pool.query(
          `UPDATE clipboard_templates
           SET ${fields.join(', ')}
           WHERE user_id = $${idx} AND id = $${idx + 1}::uuid
           RETURNING id, name, content, created_at, updated_at`,
          params
        )
        if (result.rowCount === 0) return { error: 'Template not found' }
        return { template: result.rows[0] }
      },

  'get_template_variables': async (args, userId, role) => {
        const result = await pool.query(
          'SELECT name, value, updated_at FROM template_variables WHERE user_id = $1 ORDER BY name',
          [userId]
        )
        return { variables: result.rows, count: result.rowCount }
      },

  'delete_template': async (args, userId, role) => {
        const { template_id } = args
        if (!template_id || !isValidUUID(template_id)) {
          return { error: 'INVALID_TEMPLATE', code: 'INVALID_TEMPLATE', message: 'template_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM clipboard_templates WHERE user_id = $1 AND id = $2::uuid RETURNING id',
          [userId, template_id]
        )
        if (del.rowCount === 0) return { error: 'TEMPLATE_NOT_FOUND', code: 'TEMPLATE_NOT_FOUND' }
        return { success: true, template_id, note: '模板已删除。' }
      },

  'upsert_template_variables': async (args, userId, role) => {
        const { name, value } = args
        if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          return { error: 'INVALID_VARIABLE_NAME', code: 'INVALID_VARIABLE_NAME', message: '变量名必须是合法标识符（字母/下划线开头）' }
        }
        const safeName = name.slice(0, 60)
        const safeValue = typeof value === 'string' ? value.slice(0, 10000) : ''
        const result = await pool.query(
          `INSERT INTO template_variables (user_id, name, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
           RETURNING id, name, value, created_at, updated_at`,
          [userId, safeName, safeValue]
        )
        return { variable: result.rows[0] }
      },

  'delete_template_variable': async (args, userId, role) => {
        const { name } = args
        if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          return { error: 'INVALID_VARIABLE_NAME', code: 'INVALID_VARIABLE_NAME' }
        }
        const del = await pool.query(
          'DELETE FROM template_variables WHERE user_id = $1 AND name = $2',
          [userId, name]
        )
        if (del.rowCount === 0) return { error: 'VARIABLE_NOT_FOUND', code: 'VARIABLE_NOT_FOUND' }
        return { success: true, name, note: '模板变量已删除。' }
      },
}
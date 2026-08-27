import pool from '../../../db/pool.js'
import { decrypt } from '../../../utils/encryption.js'
import { getFeatureDoc, getPrivacyModelDoc, getDeploymentDoc, getArchitectureDoc } from '../../../utils/aiKnowledge.js'
import { getSlowQueries, getPoolStatus } from '../../../utils/query-monitor.js'
import { isValidUUID, clampBudgetText } from '../shared.js'

export const operationsKnowledgeHandlers = {
  'export_data': async (args, userId, role) => {
        const format = args.format || 'markdown'
        const collectionId = args.collection_id && isValidUUID(args.collection_id) ? args.collection_id : null
        const type = args.type && args.type !== 'all' ? args.type : null
        const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 50), 100)

        let query = `
          SELECT c.id, c.type, c.content, c.content_preview, c.created_at, c.is_favorite, c.metadata
          FROM clipboard_items c
        `
        const params = [userId]
        let whereClauses = ['c.user_id = $1', 'c.is_archived = FALSE', "COALESCE(c.protection_level, 'none') = 'none'"]

        if (collectionId) {
          params.push(collectionId)
          query += ` INNER JOIN favorite_collection_items fci ON fci.item_id = c.id AND fci.collection_id = $${params.length}`
        }
        if (type) {
          params.push(type)
          whereClauses.push(`c.type = $${params.length}`)
        }

        query += ` WHERE ${whereClauses.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${limit}`
        const res = await pool.query(query, params)

        const rowsData = res.rows.map((row, idx) => {
          let text = row.content_preview || ''
          if (row.content) {
            try {
              text = decrypt(row.content) || text
            } catch { /* ignore */ }
          }
          return {
            index: idx + 1,
            id: row.id,
            type: row.type,
            created_at: row.created_at,
            is_favorite: row.is_favorite,
            tags: row.metadata?.tags || [],
            content: text,
          }
        })

        let exportedText = ''
        if (format === 'json') {
          exportedText = JSON.stringify(rowsData, null, 2)
        } else if (format === 'csv') {
          const headers = ['Index', 'ID', 'Type', 'CreatedAt', 'IsFavorite', 'Tags', 'Content']
          const csvLines = [headers.join(',')]
          for (const item of rowsData) {
            const escapedContent = `"${(item.content || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
            csvLines.push([item.index, item.id, item.type, item.created_at, item.is_favorite, `"${item.tags.join(';')}"`, escapedContent].join(','))
          }
          exportedText = csvLines.join('\n')
        } else if (format === 'text') {
          exportedText = rowsData.map((it) => `[${it.index}] (${it.type}) ${new Date(it.created_at).toLocaleString()}\n${it.content}\n---`).join('\n')
        } else {
          // Markdown 格式
          const mdSections = [`# ClipSync 剪贴板数据导出报告\n> 导出时间：${new Date().toLocaleString()} · 共 ${rowsData.length} 条\n`]
          for (const item of rowsData) {
            mdSections.push(`### ${item.index}. [${item.type}] ${item.tags.length ? `\`${item.tags.join(', ')}\`` : ''}\n- **ID**: \`${item.id}\`\n- **时间**: ${new Date(item.created_at).toLocaleString()}\n\n\`\`\`\n${item.content.slice(0, 1000)}\n\`\`\`\n`)
          }
          exportedText = mdSections.join('\n')
        }

        // D6c：导出全文统一字符预算（≤8k），超出截断并显式标注
        const clamped = clampBudgetText(exportedText)
        return {
          format,
          total_items: rowsData.length,
          preview_snippet: clamped.text.slice(0, 300),
          exported_text: clamped.text,
          ...(clamped.truncated
            ? { exported_text_truncated: true, note: '导出全文过长，已在 8000 字符处截断；如需更多内容请缩小范围（减少 limit 或按收藏夹/类型过滤）后分批导出。' }
            : {}),
        }
      },

  // ============ 大管家增强：项目元知识 ============
  'explain_feature': async (args, userId, role) => {
        const { feature } = args
        return { doc: getFeatureDoc(feature) }
      },
  'explain_privacy_model': async (args, userId, role) => {
        return { doc: getPrivacyModelDoc() }
      },
  'explain_deployment': async (args, userId, role) => {
        return { doc: getDeploymentDoc() }
      },
  'get_project_architecture': async (args, userId, role) => {
        return { doc: getArchitectureDoc() }
      },

  'get_slow_queries': async (args, userId, role) => {
        // L3 超管运维：levels.L3 登记 + executeToolInner 顶部 assertToolAllowed 已硬性拦截低角色
        const { limit = 20, min_time = 1000 } = args
        const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
        const minT = Math.max(0, parseInt(min_time, 10) || 1000)
        const [slowQueries, poolStatus] = await Promise.all([getSlowQueries(lim, minT), getPoolStatus()])
        return { slowQueries, poolStatus, limit: lim, minTimeMs: minT }
      },
}
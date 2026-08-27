export const notificationsWorkflowDefs = [
  {
    type: 'function',
    function: {
      name: 'get_notifications',
      description: '获取用户最近的通知（类型/标题/内容/是否已读/时间）',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量，默认20' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_workflow_rules',
      description: '获取当前用户的全部自动化工作流规则（「当…时自动…」：新剪贴板条目满足条件时自动收藏/归档/打标签/移入收藏夹）。返回规则列表。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_workflow_rule',
      description: '创建一条自动化工作流规则。字段：name（必填）、contentType（text/image/file/link/code，默认 text）、matchMode（keyword/regex，默认 keyword）、keywords（非空字符串数组）、actionType（favorite/archive/tag/move_to_collection，默认 favorite）、actionValue（tag 时的标签名或 move_to_collection 时的收藏夹名，可选）、actionApplyTags（tag 动作的标签数组，可选）、priority（0-1000，默认 100）、enabled（默认 true）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '规则名称（必填）' },
          contentType: { type: 'string', enum: ['text', 'image', 'file', 'link', 'code'], description: '条目类型' },
          matchMode: { type: 'string', enum: ['keyword', 'regex'], description: '匹配模式' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关键词/正则列表（至少一个）' },
          actionType: { type: 'string', enum: ['favorite', 'archive', 'tag', 'move_to_collection'], description: '动作类型' },
          actionValue: { type: 'string', description: 'tag 标签名 或 move_to_collection 的收藏夹名' },
          actionApplyTags: { type: 'array', items: { type: 'string' }, description: 'tag 动作可打多个标签' },
          priority: { type: 'number', description: '优先级 0-1000，默认 100' },
          enabled: { type: 'boolean', description: '是否启用，默认 true' }
        },
        required: ['name', 'keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_workflow_rule',
      description: '更新一条自动化工作流规则（全量替换规则字段，与 create_workflow_rule 同字段）。',
      parameters: {
        type: 'object',
        properties: {
          rule_id: { type: 'string', description: '规则ID（UUID）' },
          name: { type: 'string', description: '规则名称' },
          contentType: { type: 'string', enum: ['text', 'image', 'file', 'link', 'code'], description: '条目类型' },
          matchMode: { type: 'string', enum: ['keyword', 'regex'], description: '匹配模式' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关键词/正则列表' },
          actionType: { type: 'string', enum: ['favorite', 'archive', 'tag', 'move_to_collection'], description: '动作类型' },
          actionValue: { type: 'string', description: 'tag 标签名 或 move_to_collection 的收藏夹名' },
          actionApplyTags: { type: 'array', items: { type: 'string' }, description: 'tag 动作可打多个标签' },
          priority: { type: 'number', description: '优先级 0-1000' },
          enabled: { type: 'boolean', description: '是否启用' }
        },
        required: ['rule_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_workflow_rule',
      description: '删除当前用户的一条自动化工作流规则。',
      parameters: {
        type: 'object',
        properties: {
          rule_id: { type: 'string', description: '规则ID（UUID）' }
        },
        required: ['rule_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_notification_preferences',
      description: '获取当前用户的通知偏好列表（各通知类型的启用状态）。只读。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_notification_preferences',
      description: '更新当前用户的某个通知类型的偏好（通知类型与启用状态）。常见类型：sync_complete / device_online / subscription_expiring / security_alert。',
      parameters: {
        type: 'object',
        properties: {
          notification_type: { type: 'string', description: '通知类型，如 sync_complete' },
          enabled: { type: 'boolean', description: '是否开启该通知' }
        },
        required: ['notification_type', 'enabled']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_notification_read',
      description: '把一条通知历史标为已读（设置 read_at）。',
      parameters: {
        type: 'object',
        properties: {
          notification_id: { type: 'string', description: '通知历史记录ID（数字或字符串）' }
        },
        required: ['notification_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_version_history',
      description: '获取某剪贴板条目（资源）的历史版本列表（file_versions），含版本号、内容预览、变更描述、来源设备与时间、分页信息。只读。',
      parameters: {
        type: 'object',
        properties: {
          clipboard_item_id: { type: 'string', description: '剪贴板条目ID（UUID）' },
          page: { type: 'number', description: '页码，默认1' },
          limit: { type: 'number', description: '每页数量，默认20，最大50' }
        },
        required: ['clipboard_item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'restore_version',
      description: '把某剪贴板条目恢复到指定的历史版本（将历史版本内容写回条目，并生成一个新的版本记录）。恢复前需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          version_id: { type: 'string', description: '版本ID（UUID）' }
        },
        required: ['version_id']
      }
    }
  },
]
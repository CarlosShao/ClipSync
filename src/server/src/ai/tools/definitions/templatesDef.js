export const templatesDefs = [
  {
    type: 'function',
    function: {
      name: 'get_templates',
      description: '获取用户的快速粘贴模板列表',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_template',
      description: '创建一个快速粘贴模板（可含 {{变量}} 占位符，变量在应用内解析）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '模板名称' },
          content: { type: 'string', description: '模板内容' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_template',
      description: '更新一个已存在的快速粘贴模板的 name 与/或 content。',
      parameters: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: '模板ID' },
          name: { type: 'string', description: '可选：新模板名称' },
          content: { type: 'string', description: '可选：新模板内容' }
        },
        required: ['template_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_template_variables',
      description: '获取用户设置的全局模板变量（name→value），用于解释快捷模板的占位符来源',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_template',
      description: '删除当前用户的一个文本模板（clipboard_templates）。删除后不可恢复。',
      parameters: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: '模板ID（UUID）' }
        },
        required: ['template_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_template_variables',
      description: '新建或更新一个模板变量（按 (user_id, name) upsert）。变量名必须是合法标识符（字母或下划线开头），值可为空字符串。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '变量名（字母/下划线开头，长度≤60）' },
          value: { type: 'string', description: '变量值（可空，长度≤10000）' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_template_variable',
      description: '删除当前用户的一个模板变量（按变量名删除）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要删除的变量名' }
        },
        required: ['name']
      }
    }
  },
]
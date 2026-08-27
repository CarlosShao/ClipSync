// ============ aiTools 分域拆分：域 C 工具定义（protectiveMedia 保护/媒体） ============
// 纯重构（自 routes/aiTools.js TOOLS 数组逐字迁移），禁止改写业务逻辑。
export const protectiveMediaDefs = [
  {
    type: 'function',
    function: {
      name: 'get_protected_clips',
      description: '列出所有开启了密码保护（protection_level <> none）的条目，返回 id/类型/保护级别，让用户知道哪些内容需要密码才能被 AI 读出',
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
      name: 'set_item_protection',
      description: '为某条剪贴板条目设置密码保护。level 取 pin：仅控制客户端展示（无需密码）；level 取 advanced：高级密码保护（DEK 双加密），需要用户提供 password（≥4位）与被保护内容的明文 content。高级保护会生成一次性恢复密钥返回。注意：此工具不等于 mark_sensitive 的敏感标记。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '剪贴板条目ID' },
          level: { type: 'string', enum: ['pin', 'advanced'], description: '保护级别' },
          password: { type: 'string', description: 'advanced 级别必填：保护密码（≥4位）' },
          content: { type: 'string', description: 'advanced 级别必填：被保护内容的明文' }
        },
        required: ['item_id', 'level']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_item_protection',
      description: '移除某条剪贴板条目的密码保护（protection_level 置为 none，清除 DEK 与其恢复密钥）。advanced 条目若提供密码会先验证明文。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '剪贴板条目ID' },
          password: { type: 'string', description: '可选：advanced 条目的原保护密码（用于解密验证）' }
        },
        required: ['item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_protection_status',
      description: '查询某条剪贴板条目的保护状态（level：none/pin/advanced，及是否存在恢复密钥）。只读，不涉及解密。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '剪贴板条目ID' }
        },
        required: ['item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upload_image',
      description: '以 base64 数据上传一张图片到剪贴板（写盘复用服务端 images 目录与 uuid 命名，自动生成缩略图）。大小上限约 15MB。返回新条目 id 与缩略图文件名。',
      parameters: {
        type: 'object',
        properties: {
          base64: { type: 'string', description: '图片的 base64 编码（不含 data: 前缀）' },
          mime_type: { type: 'string', description: '可选：MIME 类型（image/jpeg, image/png 等），用于推断扩展名' },
          filename: { type: 'string', description: '可选：原始文件名（用于 contentPreview 展示）' },
          expires_at: { type: 'string', description: '可选：过期时间（ISO）' }
        },
        required: ['base64']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: '以 base64 数据上传一个文件到剪贴板（写盘复用服务端 files 目录与 uuid 命名）。大小上限约 15MB。返回新条目 id 与文件名。',
      parameters: {
        type: 'object',
        properties: {
          base64: { type: 'string', description: '文件的 base64 编码（不含 data: 前缀）' },
          mime_type: { type: 'string', description: '可选：MIME 类型，用于推断扩展名' },
          filename: { type: 'string', description: '可选：原始文件名（必须含安全扩展名，用于 contentPreview 展示与扩展名推断）' },
          expires_at: { type: 'string', description: '可选：过期时间（ISO）' }
        },
        required: ['base64']
      }
    }
  },
]
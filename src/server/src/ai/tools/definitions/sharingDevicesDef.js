export const sharingDevicesDefs = [
  {
    type: 'function',
    function: {
      name: 'show_diff_preview',
      description: '在修改模板、更新剪贴板内容或执行重要替换操作前，在前端向用户渲染直观的双栏/行内 Diff 差异对比卡片（高亮显示新增行与删除行），方便用户比对确认。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '对比标题，例如："修改模板：周报生成器"' },
          original_content: { type: 'string', description: '修改前的原始文本内容' },
          modified_content: { type: 'string', description: '修改后的目标文本内容' },
          target_id: { type: 'string', description: '可选：目标资源ID（如 clip_id 或 template_id）' }
        },
        required: ['title', 'original_content', 'modified_content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_devices',
      description: '获取用户所有配对设备及其在线状态',
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
      name: 'get_shared_links',
      description: '获取用户创建的共享链接列表',
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
      name: 'create_shared_link',
      description: '创建一个对外共享链接，把一段内容分享给他人（内容加密存储，支持过期时间）。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要共享的内容' },
          title: { type: 'string', description: '可选：链接标题' },
          expires_in_hours: { type: 'number', description: '可选：过期小时数，不传则永不过期' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_all_devices',
      description: '列出平台所有用户设备（含用户昵称/脱敏手机号）。管理员可用。',
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
      name: 'unpair_device',
      description: '解绑/删除指定设备记录。管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: '设备ID' }
        },
        required: ['device_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_shared_link',
      description: '删除当前用户的一个加密共享链接。若该链接关联了上传的共享文件，会一并移除对应文件目录。删除前请先向用户确认。',
      parameters: {
        type: 'object',
        properties: {
          shared_link_id: { type: 'string', description: '共享链接ID（UUID）' }
        },
        required: ['shared_link_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_device',
      description: '更新当前用户某台设备的普通展示字段：device_name（设备名）、platform_version（平台版本）、app_version（应用版本）。仅改这些非敏感字段。',
      parameters: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: '设备ID（UUID）' },
          device_name: { type: 'string', description: '新的设备名称' },
          platform_version: { type: 'string', description: '可选：平台版本' },
          app_version: { type: 'string', description: '可选：应用版本' }
        },
        required: ['device_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'unpair_own_device',
      description: '解绑（删除）当前用户自己的某台设备（仅本人设备可用）。解绑后该设备将无法再同步本账号剪贴板。删除前需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: '设备ID（UUID）' }
        },
        required: ['device_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_my_sessions',
      description: '列出当前用户的全部活跃会话（登录设备/会话）。返回每个会话的 id、deviceName、platform、createdAt、isCurrent。只读。',
      parameters: {
        type: 'object',
        properties: {
          current_session_id: { type: 'string', description: '可选：当前会话ID（操作者会话 jti），用于标记 isCurrent' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminate_session',
      description: '强制下线当前用户的某个会话（终止其它设备的登录态），并吊销对应 JWT。注意不能踢掉当前正在使用的会话——请先用 list_my_sessions 确定当前会话（isCurrent=true）并填入 current_session_id，若目标即当前会话将拒绝。删除前需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '要终止的会话ID（UUID）' },
          current_session_id: { type: 'string', description: '当前会话ID；若与 session_id 相同则拒绝（避免把自己踢下线）' }
        },
        required: ['session_id']
      }
    }
  },
]
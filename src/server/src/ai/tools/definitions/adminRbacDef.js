export const adminRbacDefs = [
  {
    type: 'function',
    function: {
      name: 'get_security_overview',
      description: '获取账号安全概览：两步验证(2FA)是否开启、账号是否活跃、设备总数与在线数、高级密码保护条目数',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },

      // ============ RBAC 管理工具（feature/ai-rbac-backend，超级管理员/管理域）============
  {
    type: 'function',
    function: {
      name: 'list_users',
      description: '分页列出平台用户（脱敏手机号/邮箱），支持按手机号/邮箱/昵称模糊搜索。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '可选，按手机号/邮箱/昵称模糊匹配' },
          page: { type: 'number', description: '页码，默认1' },
          page_size: { type: 'number', description: '每页数量，默认20，上限100' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_user',
      description: '创建新用户（手机号注册）。角色仅支持 user/admin。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: '手机号（必填，如 13800138000）' },
          email: { type: 'string', description: '邮箱（可选）' },
          nickname: { type: 'string', description: '昵称（可选，≤30字）' },
          password: { type: 'string', description: '密码（必填，≥6位）' },
          role: { type: 'string', enum: ['user', 'admin'], description: '角色，默认 user' }
        },
        required: ['phone', 'password']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_user_role',
      description: '修改用户角色（仅可为 user/admin）。禁止修改自身或超级管理员角色。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' },
          role: { type: 'string', enum: ['user', 'admin'], description: '目标角色' }
        },
        required: ['user_id', 'role']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_user',
      description: '物理删除用户（级联删除其所有数据，包括剪贴板/设备/订阅，不可恢复）。禁止删除自身或超级管理员。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' }
        },
        required: ['user_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reset_user_password',
      description: '重置指定用户密码为临时随机密码（仅返回一次），并提示其登录后立即修改。禁止作用于自身或超级管理员。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' }
        },
        required: ['user_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disable_user',
      description: '停用指定用户账号（is_active=false）并吊销其全部会话。「+」禁止作用于自身或超级管理员。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' },
          reason: { type: 'string', description: '停用原因（可选）' }
        },
        required: ['user_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_system_config',
      description: '读取系统配置项，可按 category（general/ai/security 等）过滤。返回 config_key/config_value/description/category/updated_at。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '可选，配置分类过滤' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_system_config',
      description: '更新系统配置（仅白名单键：ai_max_tokens/ai_default_provider/max_collection_depth/enable_audit_log/session_timeout_minutes）。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          config_key: { type: 'string', description: '配置键' },
          config_value: { description: '配置值（标量或对象）' }
        },
        required: ['config_key', 'config_value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'toggle_feature',
      description: '开启/关闭功能开关（feature_flags）。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          flag_key: { type: 'string', description: '功能开关键（如 enable_ai_agent）' },
          enabled: { type: 'boolean', description: '是否启用' }
        },
        required: ['flag_key', 'enabled']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_audit_logs',
      description: '分页查询审计日志，可按操作(action)/用户ID/起止时间过滤。每行已脱敏。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '操作类型过滤（login/reset_password/config_change 等）' },
          user_id: { type: 'string', description: '操作者用户ID过滤' },
          start_time: { type: 'string', description: '起始时间（ISO）' },
          end_time: { type: 'string', description: '结束时间（ISO）' },
          page: { type: 'number', description: '页码，默认1' },
          page_size: { type: 'number', description: '每页数量，默认50，上限100' }
        },
        required: []
      }
    }
  },
]
export const accountSubscriptionDefs = [
  {
    type: 'function',
    function: {
      name: 'get_memories',
      description: '读取用户的长期记忆（偏好/项目事实/反馈等跨会话信息）。当用户问到“你记得吗/我们之前说过/我的偏好”或需要结合历史背景时调用',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['preference', 'fact', 'project', 'feedback', 'other'], description: '可选：按类别过滤' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '保存一条用户长期记忆。仅在用户明确要求你“记住/保存/记下来”某信息时才调用此工具写入记忆；未经用户明确要求，绝不主动保存（对话中的普通信息不需要写记忆）。每次只保存一条最有价值的信息，标题简短，内容具体（content 超过 2000 字符会被截断）。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['preference', 'fact', 'project', 'feedback', 'other'], description: '记忆类别' },
          title: { type: 'string', description: '简短标题' },
          content: { type: 'string', description: '记忆内容' }
        },
        required: ['category', 'title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_subscription_details',
      description: '获取当前订阅套餐（free/Pro/企业）及其设备数/历史条数/单文件大小/总存储等限制，并附当前用量',
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
      name: 'upgrade_subscription',
      description: '为用户开通/升级订阅套餐（Free/Pro/Enterprise），可指定时长月数。仅超级管理员可用。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' },
          plan: { type: 'string', enum: ['Free', 'Pro', 'Enterprise'], description: '目标套餐' },
          duration_months: { type: 'number', description: '订阅月数，默认1' }
        },
        required: ['user_id', 'plan']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'downgrade_subscription',
      description: '为用户降级订阅套餐（只能降不能升）。仅超级管理员可用，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '目标用户ID' },
          plan: { type: 'string', enum: ['Free', 'Pro', 'Enterprise'], description: '目标套餐（须低于当前）' }
        },
        required: ['user_id', 'plan']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_profile',
      description: '获取当前用户的账号资料（id、phone、email、nickname、avatarUrl、createdAt、subscriptionStatus）。只读。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description: '更新当前用户的账号资料。仅允许昵称 nickname 与头像链接 avatar_url 两个非敏感展示字段（自动 trim 并限长）。',
      parameters: {
        type: 'object',
        properties: {
          nickname: { type: 'string', description: '可选：新的昵称（≤50字符）' },
          avatar_url: { type: 'string', description: '可选：新的头像URL（≤500字符）' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_subscription_plans',
      description: '获取当前公开可订阅的套餐列表（Free/Pro/Enterprise：名称、价格、设备数、历史条目数、单文件大小、总存储等）。只读。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_subscription',
      description: '取消当前用户的付费订阅（仅取消自动续费，流量在当期结束前仍可用；不产生任何退款）。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resume_subscription',
      description: '恢复当前用户已取消（cancel_at_period_end=true）但尚未到期的订阅，继续自动续费。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_survey',
      description: '提交一份满意度调查（NPS/CSAT）：type（如 nps/csat）、score（0-10 必填）、feedback（可选文字反馈）。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '调查类型，如 nps / csat' },
          score: { type: 'number', description: '评分 0-10 的整数' },
          feedback: { type: 'string', description: '可选：文字反馈' }
        },
        required: ['type', 'score']
      }
    }
  },
]
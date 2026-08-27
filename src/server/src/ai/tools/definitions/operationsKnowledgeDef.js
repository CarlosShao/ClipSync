export const operationsKnowledgeDefs = [
  {
    type: 'function',
    function: {
      name: 'export_data',
      description: '将当前用户指定范围（特定收藏夹、特定类型、或最近搜索条目）的剪贴板内容导出为结构化格式（markdown / json / text / csv），供用户备份、归档、制作报告或复制使用。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['markdown', 'json', 'text', 'csv'], description: '导出格式，默认 markdown' },
          collection_id: { type: 'string', description: '可选：要导出的收藏夹ID（UUID）' },
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '可选：内容类型过滤' },
          limit: { type: 'number', description: '导出条目数量限制，默认 50，最大 100' }
        },
        required: ['format']
      }
    }
  },

  // ============ 大管家增强：项目元知识（功能/隐私/部署/架构）============
  {
    type: 'function',
    function: {
      name: 'explain_feature',
      description: '讲解 ClipSync 的某项功能。传入功能 key（如 clipboard_sync / favorites / collections / templates / shared_links / devices_pairing / subscriptions_plans / security_2fa / item_protection / notifications / ai_agent / archive / search_filters / encryption_model）查看详情；不传则返回功能清单。',
      parameters: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: '功能 key，见描述中的枚举' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'explain_privacy_model',
      description: '讲解 ClipSync 的数据隐私与加密模型：服务端静态加密、本地条目为何 AI 读不到、高级密码保护为何需要用户密码、AI 能/不能做什么、用户如何查看明文、2FA 与数据导出等',
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
      name: 'explain_deployment',
      description: '讲解 ClipSync 如何启动与部署：本地开发（Node/Rust/Docker/PostgreSQL/Redis、dev 拓扑直连 localhost:3001）、构建打包（tauri build）、生产部署要点（ENCRYPTION_KEY、nginx、SSE 不缓冲）、常见排查',
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
      name: 'get_project_architecture',
      description: '讲解 ClipSync 整体技术架构：客户端（Tauri v2 + Vue3 + Vite + Pinia + shadcn-vue）、服务端（Express5 + PostgreSQL + Redis）、AI 代理 SSE 流式、实时同步（WebSocket + Redis Pub/Sub）',
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
      name: 'get_slow_queries',
      description: '获取数据库慢查询列表与连接池状态（仅超管可用）。返回 top N 慢 SQL（含执行时间）与连接池统计。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，默认20' },
          min_time: { type: 'number', description: '最小执行时间（毫秒），默认1000' }
        },
        required: []
      }
    }
  }
]
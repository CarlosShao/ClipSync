// ============ aiTools 分域拆分：域 A collectionsTags（收藏夹/标签）工具定义 ============
// 自 routes/aiTools.js 的 TOOLS 数组逐字迁移（纯重构，禁止改写内容）。
export const collectionsTagsDefs = [
  {
    type: 'function',
    function: {
      name: 'batch_move_to_collection',
      description: '批量把多个剪贴板条目移动/归类到指定的收藏夹。单次可传入多个 item_ids。满足条目唯一归属语义（自动从旧收藏夹移除并绑定到新收藏夹）。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '目标收藏夹ID（UUID）' },
          item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要移动的剪贴板条目ID列表（非空数组）'
          }
        },
        required: ['collection_id', 'item_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_collections',
      description: '获取用户所有收藏夹及其条目数量',
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
      name: 'get_tags',
      description: '获取用户所有收藏项中使用的标签列表',
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
      name: 'create_collection',
      description: '创建一个新的收藏夹。创建后可通过 batch_favorite 收藏条目，但归档/取消归档不影响收藏夹归属。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '收藏夹名称' },
          icon: { type: 'string', description: '可选：表情图标，默认 📁' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_sub_collection',
      description: '创建子收藏夹（挂到指定父收藏夹下），支持 icon/description。普通用户可用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '收藏夹名' },
          parent_id: { type: 'string', description: '父收藏夹ID' },
          icon: { type: 'string', description: '图标，默认📁' },
          description: { type: 'string', description: '描述（可选）' }
        },
        required: ['name', 'parent_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_collection',
      description: '删除指定收藏夹及其所有子收藏夹（级联删除 ltree 后代）。属破坏性操作，执行前需用户确认（前端会弹出确认卡片）。只删除收藏夹结构，不物理删除其中剪贴板条目本身。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '要删除的收藏夹ID' }
        },
        required: ['collection_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_collection',
      description: '更新收藏夹的部分字段（名称 name / 图标 icon / 排序号 sort_order）。仅更新传入字段，不影响其他属性。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '收藏夹ID' },
          name: { type: 'string', description: '可选：新名称' },
          icon: { type: 'string', description: '可选：新图标（emoji）' },
          sort_order: { type: 'number', description: '可选：排序号' }
        },
        required: ['collection_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_collection',
      description: '把收藏夹移动到新的父收藏夹下（parent_id 为空表示移动到根级）。会自动防循环引用（不能移入自身或其后代）。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '要移动的收藏夹ID' },
          parent_id: { type: 'string', description: '可选：新父收藏夹ID，null 表示移到根级' }
        },
        required: ['collection_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reorder_collections',
      description: '批量调整当前用户下各收藏夹的排序号（传入包含收藏夹ID与新排序号的 orders 数组），用于实现拖拽排序。',
      parameters: {
        type: 'object',
        properties: {
          orders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '收藏夹ID' },
                sortOrder: { type: 'number', description: '新排序号' }
              }
            },
            description: '要重排的收藏夹 id→sortOrder 列表'
          }
        },
        required: ['orders']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_collection_items',
      description: '获取指定收藏夹内的剪贴板条目列表（含每条的类型/预览/大小/标签/收藏状态/来源设备与排序）。只读。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '收藏夹ID' }
        },
        required: ['collection_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_item_to_collection',
      description: '把一条剪贴板条目加入指定收藏夹。唯一归属语义：条目会自动从其他收藏夹移除，只属于当前这个收藏夹。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '目标收藏夹ID' },
          item_id: { type: 'string', description: '要加入的剪贴板条目ID' }
        },
        required: ['collection_id', 'item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_item_from_collection',
      description: '把一条剪贴板条目从指定收藏夹移除（仅解除关联，不删除剪贴板条目本身）。',
      parameters: {
        type: 'object',
        properties: {
          collection_id: { type: 'string', description: '收藏夹ID' },
          item_id: { type: 'string', description: '要移除的剪贴板条目ID' }
        },
        required: ['collection_id', 'item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_collection_tags',
      description: '全量替换某条收藏剪贴板条目的标签列表（metadata 中的 tags 数组字段）。用于为收藏项设置或更新标签。',
      parameters: {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: '剪贴板条目ID' },
          tags: { type: 'array', items: { type: 'string' }, description: '新的完整标签列表（覆盖旧标签）' }
        },
        required: ['clip_id', 'tags']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_tag',
      description: '删除一个标签：从当前用户所有收藏项（is_favorite）的标签列表中级联移除该标签。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '要删除的标签名' }
        },
        required: ['tag']
      }
    }
  },
]
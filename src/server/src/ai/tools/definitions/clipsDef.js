export const clipsDefs = [
  {
    type: 'function',
    function: {
      name: 'find_duplicates',
      description: '扫描当前用户的剪贴板条目，查找完全相同或高度重复的内容（按文本哈希/正文内容聚类分组），用于帮助用户排查重复记录、去重或批量清理。返回重复组列表及每组条目ID。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '可选：内容类型过滤，默认 all' },
          collection_id: { type: 'string', description: '可选：限定在某个收藏夹内扫描（UUID）' },
          limit: { type: 'number', description: '扫描的最近条目数量，默认 100，最大 200' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_clipboard_stats',
      description: '获取剪贴板的完整统计数据，包括总条目数、各类型数量、收藏条目数、归档数、收藏夹数量、标签数、设备数、模板数、共享链接数、订阅套餐',
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
      name: 'get_ai_context',
      description: '一次性获取 ClipSync 完整上下文（统计、收藏夹、标签、设备、模板、共享链接、最近条目、订阅），回答综合问题时优先调用',
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
      name: 'search_clips',
      description: '搜索剪贴板内容',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '内容类型过滤' },
          limit: { type: 'number', description: '返回数量限制，默认10' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_clip_details',
      description: '获取指定剪贴板条目的详细信息',
      parameters: {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: '剪贴板条目ID' }
        },
        required: ['clip_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ocr_clip_image',
      description: '对指定的「图片」剪贴板条目做 OCR，提取图中所有文字（需配置支持视觉的 AI 供应商，如 GPT-4o/Claude/Gemini/Qwen-VL）。提取结果会写回该条目并可用于搜索。返回提取到的文字或错误原因。',
      parameters: {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: '要 OCR 的图片剪贴板条目 ID' }
        },
        required: ['clip_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_clips',
      description: '获取最近的剪贴板条目',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量，默认10' },
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '内容类型过滤' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_clip_usage',
      description: '分析剪贴板使用模式，提供使用统计和建议',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  // ============ 大管家 Agent 写工具面（真实落库，user_id 硬隔离）============
  {
    type: 'function',
    function: {
      name: 'write_clip',
      description: '把一段文本/链接/代码内容写入用户的剪贴板（前端加密存储，内容落库为 content_encrypted，可搜索明文放 content_preview）。适合用户说“帮我记一下/存进剪贴板/生成并保存”。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要写入剪贴板的内容正文' },
          content_type: { type: 'string', enum: ['text', 'link', 'code'], description: '内容类型，默认 text' },
          label: { type: 'string', description: '可选：条目标题/标签名，写入 metadata' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：附加给该条目的标签列表' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tag_items',
      description: '批量给指定的剪贴板条目打标签。覆盖整组标签，若需要保留原标签请先调用 get_clip_meta 查看现有标签。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要打标签的条目ID列表' },
          tags: { type: 'array', items: { type: 'string' }, description: '要设置的标签列表（覆盖）' }
        },
        required: ['clip_ids', 'tags']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'archive_items',
      description: '批量归档指定的剪贴板条目（软删除：archived=true，条目从主列表隐藏）。重要：当搜索匹配到多条结果时，必须先将所有匹配条目列出展示给用户，等待用户明确指定要归档的条目后再调用本工具。禁止直接归档所有匹配项。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要归档的条目ID列表（仅包含用户明确指定的条目）' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'unarchive_items',
      description: '批量取消归档指定的剪贴板条目（archived=false，恢复到主列表）。重要：当搜索匹配到多条结果时，必须先列出所有匹配条目并等待用户确认。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要恢复的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_clip_meta',
      description: '更新某条剪贴板条目的元数据（标签 tags、label 标题等）。仅更新传入字段，不会改动内容正文。',
      parameters: {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: '要更新的条目ID' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：覆盖标签列表' },
          label: { type: 'string', description: '可选：覆盖标题/label' }
        },
        required: ['clip_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch_favorite',
      description: '批量收藏指定的剪贴板条目',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要收藏的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch_delete',
      description: '批量归档指定的剪贴板条目（软删除：archived=true，条目从主列表隐藏，可从归档恢复）。注意：这是软删除，不会物理抹除数据。若用户确属要永久删除，请改用 destroy_clips（需在确认后执行）。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要软删除/归档的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'destroy_clips',
      description: '批量永久物理删除剪贴板条目（DELETE FROM 数据库，不可恢复）。属破坏性操作，执行前必须获得用户明确确认（前端会弹出确认卡片）。单次最多 50 条，超过需分批调用。重要：调用前必须先用 search_clips 或 get_clip_details 确认条目确实存在于当前用户下。若 permanentlyDeleted 为 0，说明 ID 不存在或不属于当前用户。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要永久删除的条目ID列表（最多50）。必须是 search_clips 返回的有效 ID。' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
        function: {
          name: 'organize_by_type',
          description: '按类型整理剪贴板内容，返回分类结果',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },

      // ============ 大管家增强：隐私感知的内容读取 ============
      {
        type: 'function',
        function: {
          name: 'read_clip_content',
          description: '读取某条剪贴板条目的完整明文内容（解密后返回）。这是处理敏感数据的高权限工具，仅在用户明确要求「看这条内容 / 读出明文」时调用。' +
            '隐私规则：本地条目（local-/text-/img- 临时ID）内容不在服务端，无法读取并会说明；' +
            '高级密码保护（advanced）条目必须传入 password 才能解密，否则返回「需要密码」提示；' +
            '图片/文件的存储值实为服务端文件名而非原文，会返回引用名并说明如何查看。',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' },
              password: { type: 'string', description: '可选：该条目若启用高级密码保护，需提供用户密码才能解密明文' }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_clip_meta',
          description: '获取某条目的完整元数据（类型/预览/大小/收藏/归档/保护级别/标签/来源设备/时间），不含明文。先调用它判断条目性质，再决定是否 read_clip_content',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_archived_clips',
          description: '列出已归档（archived=true）的剪贴板条目',
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
          name: 'update_clip',
          description: '更新某条剪贴板条目的属性（正文重加密 content / 预览 contentPreview / 过期时间 expiresAt / 归档状态 archived / 白名单元数据 metadata）。仅更新传入字段。',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' },
              content: { type: 'string', description: '可选：新的正文（会被服务端加密存储）' },
              contentPreview: { type: 'string', description: '可选：新的可搜索明文预览' },
              expiresAt: { type: 'string', description: '可选：过期时间（ISO日期），null 表示清除过期' },
              archived: { type: 'boolean', description: '可选：归档状态' },
              metadata: {
                type: 'object',
                description: '可选：仅允许受保护/标签等白名单键（protected / protectedAt / tags）的浅合并'
              }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'mark_sensitive',
          description: '切换某条剪贴板条目的「敏感内容」标记（metadata.sensitive 布尔值）。这是主观内容标记，与条目密码保护（set_item_protection）完全无关——它不改变能见度/加密。',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' },
              sensitive: { type: 'boolean', description: 'true 标记为敏感，false 取消敏感标记' }
            },
            required: ['clip_id', 'sensitive']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'mark_clip_used',
          description: '把某条剪贴板条目标记为「已使用」（usage_count +1、刷新 last_used_at），用于智能粘贴建议的频率统计。',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_frequent_clips',
          description: '获取常用剪贴板条目排行（按使用次数 × 衰减时间的综合评分排序，Top N）。只读。',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: '返回数量，默认3，1-10' }
            }
          }
        }
      },
]
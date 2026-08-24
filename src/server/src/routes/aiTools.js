import { Router } from 'express'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { getAiContext } from '../utils/aiContext.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logToolAudit } from '../utils/audit.js'
import { getFeatureDoc, getPrivacyModelDoc, getDeploymentDoc, getArchitectureDoc } from '../utils/aiKnowledge.js'
import { assertToolAllowed, getToolsForRole } from '../utils/aiSystemPrompt.js'
import { authenticateToken } from '../middleware/auth.js'
import { TEXT_PREVIEW_EXTENSIONS } from './media.js'
import { ocrClipById } from '../utils/aiOcr.js'

const router = Router()

// 服务端存储目录（与 storage.js / media.js 一致：src/server/uploads）
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_BASE = path.join(__dirname, '../../uploads')
const IMAGE_DIR = path.join(UPLOAD_BASE, 'images')
const FILE_DIR = path.join(UPLOAD_BASE, 'files')

// 在多个候选目录中定位媒体文件（media 直传在 files/ 或 images/，分片上传在 uploads/ 根）
async function locateStoredFile(relName, dirs) {
  for (const d of dirs) {
    const p = path.join(d, relName)
    try {
      const s = await fs.stat(p)
      return { path: p, size: s.size }
    } catch { /* try next */ }
  }
  return null
}

/**
 * ClipSync 工具定义
 * 这些工具可以被 AI Agent 调用来执行实际操作
 */
export const TOOLS = [
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
      description: '保存一条用户长期记忆。当你从对话中了解到用户的偏好、项目事实、工作习惯、对我方产品的反馈，或任何跨会话有用的信息时，主动调用此工具写入记忆，不要等用户要求。每次只保存一条最有价值的信息，标题简短，内容具体。',
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
      description: '批量归档指定的剪贴板条目（软删除：archived=true，条目从主列表隐藏）。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要归档的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'unarchive_items',
      description: '批量取消归档指定的剪贴板条目（archived=false，恢复到主列表）。',
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
      description: '批量永久物理删除剪贴板条目（DELETE FROM 数据库，不可恢复）。属破坏性操作，执行前必须获得用户明确确认（前端会弹出确认卡片）。单次最多 50 条，超过需分批调用。',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要永久删除的条目ID列表（最多50）' }
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
          name: 'get_security_overview',
          description: '获取账号安全概览：两步验证(2FA)是否开启、账号是否活跃、设备总数与在线数、高级密码保护条目数',
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
      }
    ]

/**
 * 写入类工具集合（多代理编排时，子代理只配发只读工具，写入操作统一由
 * 协调器/综合阶段串行执行，避免并发写竞争）。
 */
export const WRITE_TOOL_NAMES = new Set([
  'save_memory',
  'write_clip',
  'tag_items',
  'archive_items',
  'unarchive_items',
  'update_clip_meta',
  'create_collection',
  'create_template',
  'update_template',
  'create_shared_link',
  'batch_favorite',
  'batch_delete',
  'destroy_clips',
  'ocr_clip_image',
])

/**
 * 只读工具子集：供并行子代理使用，杜绝子代理并发触发写入/破坏性操作。
 * 与 TOOLS 同步维护——新增写入类工具时必须加入 WRITE_TOOL_NAMES，否则会被误判为只读。
 */
export const READONLY_TOOLS = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.function.name))

// ============ Agent-C：破坏性操作确认门控 ============
// 需用户在前端明确确认后才能执行的破坏性工具集合（写工具先按此协议演进）。
// 命中集合的工具不会直接被 executeToolInner 执行，而是：
//   1) 登记全局 pendingRequests（requestId → entry）；
//   2) 通过 SSE 下发 confirm_tool_action 事件等用户确认；
//   3) 批准后执行并写审计；拒绝/超时/断流则返回 REJECTED_BY_USER。
export const DESTRUCTIVE_CONFIRM_NEEDED = new Set(['destroy_clips'])

// 确认超时（与 handleToolCalls 的 TOOL_EXEC_TIMEOUT_MS 对齐，避免挂死上游流）。
const CONFIRM_TIMEOUT_MS = 120_000

// 全局待确认请求表：requestId → { requestId, tool, args, userId, role, settle, timer, settled }
// 并发上限 1：同一时刻只允许一个待确认的破坏性请求（详情见 runConfirmGate）。
const pendingRequests = new Map()

// args 摘要脱敏：content/password/apiKey/token 等不做全文透传，仅给受控摘要，避免明文落 SSE。
function getArgsSummary(args) {
  if (!args || typeof args !== 'object') return {}
  const SENSITIVE_KEYS = ['content', 'password', 'apikey', 'token', 'secret']
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEYS.includes(String(k).toLowerCase())) {
      const s = String(v ?? '')
      out[k] = s.length > 40 ? `${s.slice(0, 40)}…(${s.length}字)` : s
    } else {
      out[k] = v
    }
  }
  return out
}

// 破坏性动作影响描述：供确认卡片展示。
function getImpact(toolName, args) {
  const n = Array.isArray(args?.clip_ids) ? args.clip_ids.length : 0
  if (toolName === 'destroy_clips') {
    return `将永久物理删除 ${n} 条剪贴板条目，该操作不可恢复。`
  }
  return undefined
}

/**
 * 执行破坏性工具所需的「确认门控」。
 * 返回 Promise<{ approved: boolean, requestId: string, result?: any }>：
 *  - 批准后 resolve({ approved:true, requestId, result })（result 由 approve 入口执行 Inner 后回填）；
 *  - 拒绝/超时/断流 resolve({ approved:false, requestId })。
 */
async function runConfirmGate(toolName, args, userId, role, requestId, opts = {}) {
  const sendDelta = opts.sendDelta
  const rid = requestId || uuidv4()

  // 并发上限 1：已有待确认的破坏性请求时，明确拒绝新请求（避免两个确认卡片竞争）。
  // 说明：pendingRequests.size 只在「进入等待态」前判断；本函数被 Promise.all 并行调用时，
  // 后到的请求看到 pending 非空即拒绝，从而保证同一时刻最多一个等待中的确认。
  if (pendingRequests.size > 0) {
    logger.warn('[AI] destructive confirm rejected: pending request already exists')
    return {
      approved: false,
      requestId: rid,
      result: {
        error: 'CONCURRENT_CONFIRM_REQUEST',
        message: '已有待确认的破坏性操作，请先在前端确认或等待其超时，再发起新的破坏性请求。',
      },
    }
  }

  const entry = {
    requestId: rid,
    tool: toolName,
    args,
    userId,
    role,
    settled: false,
    timer: null,
    settle: () => {}, // 占位，下方赋值
  }
  const onReqClose = () => entry.settle({ approved: false, requestId: rid })

  return new Promise((resolveOuter) => {
    // 统一结算：置位、销毁定时器、移除 req close 监听、从 Map 移除、resolve 外层 Promise。
    entry.settle = (outcome) => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      if (opts.req && typeof opts.req.removeListener === 'function') {
        opts.req.removeListener('close', onReqClose)
      }
      pendingRequests.delete(rid)
      resolveOuter(outcome)
    }
    entry.timer = setTimeout(() => {
      logger.warn('[AI] destructive confirm timed out:', rid)
      entry.settle({ approved: false, requestId: rid })
    }, CONFIRM_TIMEOUT_MS)

    pendingRequests.set(rid, entry)

    // 无 SSE 通道（如 summarize/suggest 等非流式入口）时直接拒绝，不进入等待。
    if (!sendDelta) {
      entry.settle({ approved: false, requestId: rid })
      return
    }

    // 下发 SSE 确认事件供前端渲染确认卡片。
    sendDelta({
      meta: {
        type: 'confirm_tool_action',
        requestId: rid,
        tool: toolName,
        argsSummary: getArgsSummary(args),
        impact: getImpact(toolName, args),
      },
    })

    // 客户端断开时清空对应 pending，不残留。
    if (opts.req && typeof opts.req.on === 'function') {
      opts.req.on('close', onReqClose)
    }
  })
}

/**
 * 确认入口（POST /api/ai/chat/approve 调用）：
 * 校验 requestId 归属（userId 隔离，禁止跨用户审批）。
 *  - allow=false：拒绝，向等待中的 executeTool 结算 REJECTED_BY_USER。
 *  - allow=true：执行 Inner（破坏性工具实做），结果作为 final 返回，并同时结算给 executeTool 做审计。
 * @returns {{ accepted, notFound?, expired?, final? }}
 */
export async function approveToolRequest(requestId, userId, allow) {
  const entry = pendingRequests.get(requestId)
  if (!entry || entry.userId !== userId) {
    return { accepted: false, notFound: true }
  }
  if (entry.settled) {
    return { accepted: false, expired: true }
  }
  if (allow !== true) {
    entry.settle({ approved: false, requestId })
    return { accepted: false }
  }
  // 批准：先将该请求从全局 Map 移除，防止并发第二次 approve 重复执行 Inner
  // （并发第二请求将因 get() 返回 undefined 而收到 notFound）。
  // 随后执行 Inner 并把结果经 entry.settle 结算给等待中的 executeTool（含审计）。
  clearTimeout(entry.timer)
  pendingRequests.delete(requestId)
  try {
    const result = await executeToolInner(entry.tool, entry.args, userId, entry.role)
    entry.settle({ approved: true, requestId, result })
    return { accepted: true, final: result }
  } catch (err) {
    logger.error('[AI] approve execution failed:', err.message)
    entry.settle({ approved: true, requestId, result: { error: err.message } })
    return { accepted: true, final: { error: err.message } }
  }
}

/**
 * 供 SSE 流关闭（safeFinish / req close）时清理该用户残留的 pending 项。
 */
export function cancelPendingForUser(userId) {
  for (const [rid, e] of pendingRequests) {
    if (e.userId === userId && !e.settled) {
      e.settle({ approved: false, requestId: rid })
    }
  }
}

/**
 * 执行工具调用（实际执行体）
 * @param {string} toolName
 * @param {object} args
 * @param {string} userId
 * @param {string} [role] 角色键（'super_admin'|'admin'|'user'），用于敏感工具权限闸门
 */
async function executeToolInner(toolName, args, userId, role) {
  try {
    // ✅ RBAC（#213 / 第三层安全闸门）：敏感工具执行前再校验一次角色权限。
    // 即便上游因工具清单未及时收敛而调到了敏感工具，也在此处硬性拦截。
    const roleCheck = assertToolAllowed(role, toolName)
    if (!roleCheck.allowed) {
      logger.warn(`[AI] tool "${toolName}" blocked for role "${role}": missing ${roleCheck.missing.join(',')}`)
      return {
        error: 'FORBIDDEN: your role cannot access this tool',
        code: 'ROLE_FORBIDDEN',
        missing: roleCheck.missing,
      }
    }

    switch (toolName) {
      case 'get_clipboard_stats': {
        const ctx = await getAiContext(userId)
        return {
          total: ctx.stats.total,
          typeBreakdown: {
            text: ctx.stats.textCount,
            image: ctx.stats.imageCount,
            file: ctx.stats.fileCount,
            link: ctx.stats.linkCount,
            code: ctx.stats.codeCount,
          },
          favoriteItemsCount: ctx.stats.favoriteItemsCount,
          archivedCount: ctx.stats.archivedCount,
          collectionsCount: ctx.collections.collectionsCount,
          collectionItemsCount: ctx.collections.collectionItemsCount,
          tagsCount: ctx.tags.tagsCount,
          devicesCount: ctx.devices.devicesCount,
          onlineDevicesCount: ctx.devices.onlineDevicesCount,
          templatesCount: ctx.templates.templatesCount,
          variablesCount: ctx.templates.variablesCount,
          sharedLinksCount: ctx.sharedLinks.sharedLinksCount,
          subscription: ctx.subscription,
          note: 'favoriteItemsCount 是被标记为收藏的条目数；collectionItemsCount 是被归入收藏夹的条目关联数，可能小于 favoriteItemsCount。'
        }
      }

      case 'get_ai_context': {
        return await getAiContext(userId)
      }

      case 'search_clips': {
        const { query, type = 'all', limit = 10 } = args
        // 服务端文本存于 content_encrypted（加密），可搜索明文在 content_preview；
        // 直接对 content 列 ILIKE 会因该列不存在而报错，故只搜 content_preview。
        const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 100)
        let sql = 'SELECT id, content_type, content_preview, ocr_text, created_at FROM clipboard_items WHERE user_id = $1'
        const params = [userId]

        if (query) {
          // 同时搜索图片 OCR 提取出的文字（ocr_text）
          sql += ' AND (content_preview ILIKE $2 OR ocr_text ILIKE $2)'
          params.push(`%${query}%`)
        }
        if (type && type !== 'all') {
          sql += ` AND content_type = $${params.length + 1}`
          params.push(type)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(safeLimit)

        const result = await pool.query(sql, params)
        return { items: result.rows, count: result.rowCount }
      }

      case 'get_clip_details': {
        const { clip_id } = args
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, created_at, source_device_id
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'Clip not found' }
        const r = result.rows[0]
        return {
          ...r,
          note: r.protection_level === 'advanced'
            ? '该条目为高级密码保护，读取明文需提供密码（调用 read_clip_content 并传 password）。'
            : undefined
        }
      }

      case 'ocr_clip_image': {
        const { clip_id } = args
        if (!clip_id) return { error: 'clip_id 必填' }
        return await ocrClipById(clip_id, userId)
      }

      case 'get_recent_clips': {
        const { limit = 10, type = 'all' } = args
        let sql = 'SELECT id, content_type, content_preview, created_at FROM clipboard_items WHERE user_id = $1'
        const params = [userId]

        if (type && type !== 'all') {
          sql += ' AND content_type = $2'
          params.push(type)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(Math.min(Math.max(1, Number(limit) || 10), 100))

        const result = await pool.query(sql, params)
        return { items: result.rows, count: result.rowCount }
      }

      case 'analyze_clip_usage': {
        const result = await pool.query(`
          SELECT 
            content_type,
            COUNT(*) as count,
            DATE_TRUNC('day', created_at) as date
          FROM clipboard_items 
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY content_type, DATE_TRUNC('day', created_at)
          ORDER BY date DESC
        `, [userId])
        
        const total = await pool.query(
          'SELECT COUNT(*) as total FROM clipboard_items WHERE user_id = $1',
          [userId]
        )
        
        return {
          total: total.rows[0].total,
          dailyBreakdown: result.rows,
          summary: `过去30天共 ${total.rows[0].total} 条记录`
        }
      }

      case 'batch_favorite': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET is_favorite = true WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, updated: result.rowCount }
      }

      case 'batch_delete': {
        // Agent-C：默认软删除（归档语义），不再物理 DELETE —— 可恢复，避免误删不可挽回。
        // 用户确需物理抹除时改用 destroy_clips（L2 + 确认门控）。
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, archived: result.rowCount, note: '已软删除（归档），可在归档列表中恢复。如需永久物理删除请启用 destroy_clips。' }
      }

      case 'destroy_clips': {
        // Agent-C：物理删除（破坏性，L2+）。clip_ids 上限 50，超出明确拒绝并提示分批。
        // 权限闸门已由 executeToolInner 顶部 assertToolAllowed 校验（L2 起），此处做上限校验。
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        if (clip_ids.length > 50) {
          return {
            error: 'DESTROY_BATCH_TOO_LARGE',
            message: `一次最多永久删除 50 条，你传了 ${clip_ids.length} 条；请分批（每批 ≤50）调用。`,
            received: clip_ids.length,
            maxPerBatch: 50,
          }
        }
        const result = await pool.query(
          'DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, permanentlyDeleted: result.rowCount }
      }

      case 'organize_by_type': {
        const result = await pool.query(`
          SELECT 
            content_type,
            COUNT(*) as count,
            ARRAY_AGG(id ORDER BY created_at DESC) as clip_ids
          FROM clipboard_items 
          WHERE user_id = $1
          GROUP BY content_type
          ORDER BY count DESC
        `, [userId])
        
        return {
          categories: result.rows.map(r => ({
            type: r.content_type,
            count: r.count,
            clipIds: r.clip_ids.slice(0, 10) // 只返回前10个ID
          }))
        }
      }

      case 'write_clip': {
        const { content, content_type = 'text', label, tags } = args
        if (typeof content !== 'string' || !content.trim()) {
          return { error: 'content is required' }
        }
        const allowedTypes = ['text', 'link', 'code']
        const ctype = allowedTypes.includes(content_type) ? content_type : 'text'

        // 加密正文入库，preview 只放前 200 字符可搜索明文
        const contentEncrypted = encrypt(String(content))
        const preview = String(content).slice(0, 200)
        const meta = { ...(label ? { label: String(label).slice(0, 200) } : {}) }
        if (Array.isArray(tags)) {
          meta.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        }

        // source_device_id 置 null（AI 通道无发起设备；依赖 034 迁移解除 NOT NULL）
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [userId, ctype, contentEncrypted, preview, Buffer.byteLength(String(content)), JSON.stringify(meta)]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          contentSize: r.content_size,
          createdAt: r.created_at,
          note: '已写入你的剪贴板，可在应用内查看/搜索。'
        }
      }

      case 'tag_items': {
        const { clip_ids, tags } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        if (!Array.isArray(tags) || tags.length === 0) {
          return { error: 'tags is required and must be an array' }
        }
        const cleanTags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        if (cleanTags.length === 0) return { error: 'tags must not be empty' }
        const result = await pool.query(
          `UPDATE clipboard_items
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tags}', $1::jsonb)
           WHERE id = ANY($2) AND user_id = $3
           RETURNING id`,
          [JSON.stringify(cleanTags), clip_ids, userId]
        )
        return { success: true, tagged: result.rowCount, tags: cleanTags }
      }

      case 'archive_items': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, archived: result.rowCount }
      }

      case 'unarchive_items': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = false, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, unarchived: result.rowCount }
      }

      case 'update_clip_meta': {
        const { clip_id, tags, label } = args
        if (!clip_id) return { error: 'clip_id is required' }
        if (tags === undefined && label === undefined) {
          return { error: 'tags 或 label 至少提供一个要更新的字段' }
        }
        const current = await pool.query(
          'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [clip_id, userId]
        )
        if (current.rowCount === 0) return { error: '未找到该条目' }
        const meta = (() => {
          const raw = current.rows[0].metadata
          if (typeof raw === 'string') { try { return JSON.parse(raw) || {} } catch { return {} } }
          return raw || {}
        })()
        if (tags !== undefined) {
          meta.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        }
        if (label !== undefined) {
          if (label === null || label === '') delete meta.label
          else meta.label = String(label).slice(0, 200)
        }
        await pool.query(
          'UPDATE clipboard_items SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
          [meta, clip_id, userId]
        )
        return { success: true, id: clip_id, tags: meta.tags || [], label: meta.label || undefined }
      }

      case 'create_collection': {
        const { name, icon } = args
        if (!name || !String(name).trim()) {
          return { error: 'name is required' }
        }
        const cleanName = String(name).trim().slice(0, 100)
        const cleanIcon = (String(icon || '📁')).slice(0, 10)
        const maxOrder = await pool.query(
          'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collections WHERE user_id = $1',
          [userId]
        )
        const path = `root.${uuidv4()}`
        const result = await pool.query(
          `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, icon, sort_order, created_at`,
          [userId, cleanName, cleanIcon, (maxOrder.rows[0].max_order || 0) + 1, path]
        )
        return { collection: result.rows[0] }
      }

      case 'create_template': {
        const { name, content } = args
        if (!name || !String(name).trim()) {
          return { error: 'name is required' }
        }
        const safeName = String(name).trim().slice(0, 200)
        const safeContent = typeof content === 'string' ? content : ''
        const result = await pool.query(
          `INSERT INTO clipboard_templates (user_id, name, content)
           VALUES ($1, $2, $3)
           RETURNING id, name, content, created_at, updated_at`,
          [userId, safeName, safeContent]
        )
        return { template: result.rows[0] }
      }

      case 'update_template': {
        const { template_id, name, content } = args
        if (!template_id) return { error: 'template_id is required' }
        const fields = []
        const params = []
        let idx = 1
        if (typeof name === 'string' && name.trim()) {
          fields.push(`name = $${idx++}`)
          params.push(name.trim().slice(0, 200))
        }
        if (typeof content === 'string') {
          fields.push(`content = $${idx++}`)
          params.push(content)
        }
        if (fields.length === 0) return { error: 'name 或 content 至少提供一个要更新的字段' }
        fields.push('updated_at = NOW()')
        params.push(userId, template_id)
        const result = await pool.query(
          `UPDATE clipboard_templates
           SET ${fields.join(', ')}
           WHERE user_id = $${idx} AND id = $${idx + 1}::uuid
           RETURNING id, name, content, created_at, updated_at`,
          params
        )
        if (result.rowCount === 0) return { error: 'Template not found' }
        return { template: result.rows[0] }
      }

      case 'create_shared_link': {
        const { content, title, expires_in_hours } = args
        if (typeof content !== 'string' || !content.trim()) {
          return { error: 'content is required' }
        }
        const token = crypto.randomBytes(10).toString('hex')
        const contentEncrypted = encrypt(String(content))
        const preview = String(content).slice(0, 200)
        const safeTitle = typeof title === 'string' ? title.slice(0, 200) : null
        let expiresAt = null
        if (typeof expires_in_hours === 'number' && expires_in_hours > 0) {
          expiresAt = new Date(Date.now() + expires_in_hours * 3600 * 1000).toISOString()
        }
        const result = await pool.query(
          `INSERT INTO shared_links (user_id, token, title, content_encrypted, content_preview, content_type, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'text', $6)
           RETURNING id, title, content_type, expires_at, created_at`,
          [userId, token, safeTitle, contentEncrypted, preview, expiresAt]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          title: r.title,
          contentType: r.content_type,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          note: '共享链接已创建，访问地址请在应用「共享链接」列表中查看（链接访问凭证不会在此展示）。'
        }
      }

      case 'get_collections': {
        const result = await pool.query(
          `SELECT id, name, icon, path::text AS path, sort_order,
                  (SELECT COUNT(*)::int FROM favorite_collection_items fci WHERE fci.collection_id = fc.id) AS item_count
           FROM favorite_collections fc
           WHERE fc.user_id = $1
           ORDER BY sort_order ASC, path ASC`,
          [userId]
        )
        return { collections: result.rows, count: result.rowCount }
      }

      case 'get_tags': {
        const result = await pool.query(
          `
          SELECT DISTINCT tag
          FROM (
            SELECT jsonb_array_elements_text(metadata->'tags') AS tag
            FROM clipboard_items
            WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' IS NOT NULL
          ) t
          WHERE tag IS NOT NULL
          ORDER BY tag
          `,
          [userId]
        )
        return { tags: result.rows.map((r) => r.tag), count: result.rowCount }
      }

      case 'get_devices': {
        const result = await pool.query(
          `SELECT id, device_name, device_type, platform, is_online, last_seen_at, created_at
           FROM devices
           WHERE user_id = $1
           ORDER BY last_seen_at DESC`,
          [userId]
        )
        return { devices: result.rows, count: result.rowCount }
      }

      case 'get_templates': {
        // clipboard_templates 真实列为 name/content，无 content_preview/shortcut
        const result = await pool.query(
          `SELECT id, name, content, created_at, updated_at
           FROM clipboard_templates
           WHERE user_id = $1
           ORDER BY updated_at DESC`,
          [userId]
        )
        return { templates: result.rows, count: result.rowCount }
      }

      case 'get_shared_links': {
        // 只返回非敏感字段：token 即访问凭证（等同 access_code），绝不回传明文
        const result = await pool.query(
          `SELECT id, title, content_preview, content_type, views, expires_at, created_at
           FROM shared_links
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [userId]
        )
        return { sharedLinks: result.rows, count: result.rowCount }
      }

      case 'get_memories': {
        const { category } = args
        let sql = 'SELECT id, category, title, content, updated_at FROM ai_memories WHERE user_id = $1'
        const params = [userId]
        if (category) { sql += ' AND category = $2'; params.push(category) }
        sql += ' ORDER BY updated_at DESC'
        const result = await pool.query(sql, params)
        return { memories: result.rows, count: result.rowCount }
      }

      case 'save_memory': {
        const { category = 'fact', title, content } = args
        if (!title || !content) return { error: 'title and content are required' }
        const cat = ['preference', 'fact', 'project', 'feedback', 'other'].includes(category) ? category : 'fact'
        const result = await pool.query(
          `INSERT INTO ai_memories (user_id, category, title, content)
           VALUES ($1, $2, $3, $4)
           RETURNING id, category, title, content, updated_at`,
          [userId, cat, String(title).trim(), String(content).trim()]
        )
        return { saved: result.rows[0] }
      }

      // ============ 大管家增强：隐私感知内容读取 ============
      case 'read_clip_content': {
        const { clip_id, password } = args
        if (!clip_id) return { error: 'clip_id is required' }

        // 本地临时 ID（local-/text-/img-/file-/browser-）是前端乐观更新用的临时 ID，
        // 在服务端确认写入之前根本不入库，AI 后端自然查不到。
        const LOCAL_TEMP_PREFIXES = ['local-', 'text-', 'img-', 'file-', 'browser-']
        const isTempLocal = LOCAL_TEMP_PREFIXES.some((p) => clip_id.startsWith(p))
        if (isTempLocal) {
          return {
            error: '该条目尚未同步到服务端',
            reason: 'temporary_local_item',
            detail: '这个 ID 是 ClipSync 桌面端捕获内容后、在列表里临时生成的乐观项（local-/text-/img-/file-/browser- 前缀）。它此时只存在于你的设备内存，还没完成服务端同步，因此没有入库。等几秒同步完成后 ID 会变成标准 UUID，AI 就能读取了。请在应用内查看或稍后再试。'
          }
        }

        const result = await pool.query(
          `SELECT id, content_type, content_encrypted, content_preview, content_size,
                  protection_level, wrapped_dek_password, protection_salt, metadata
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) {
          return { error: '未找到该条目', reason: '可能已被删除，或它是未同步到服务端的本地条目。' }
        }
        const item = result.rows[0]
        const type = item.content_type

        // 图片 / 文件：服务端持有完整数据，AI 大管家拥有读取权限——绝不一句"非原文"打发。
        // 存储形态有两种：
        //  A) 内联 base64（data URL）——桌面端直接把字节存入 content_encrypted；
        //  B) 磁盘文件——content_encrypted 存文件名，字节在 uploads/images、uploads/files（分片上传在根）。
        if (type === 'image' || type === 'file') {
          const meta = (() => {
            try { return typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {}) }
            catch { return {} }
          })()
          const raw = item.content_encrypted || ''

          // —— A) 内联 data URL ——
          if (raw.startsWith('data:')) {
            const comma = raw.indexOf(',')
            const header = comma > 0 ? raw.slice(0, comma) : 'data:'
            const mimeMatch = header.match(/data:([^;]+)/)
            const mime = mimeMatch ? mimeMatch[1] : (meta.mimeType || 'application/octet-stream')
            const b64 = comma > 0 ? raw.slice(comma + 1) : ''
            const byteLen = Math.round(b64.length * 3 / 4)
            if (type === 'image') {
              return {
                accessible: true, contentType: 'image', storage: 'inline_data_url',
                fileName: meta.originalName || 'image', mimeType: mime, byteSize: byteLen, onServer: true,
                message: `图片以 base64 内联存储于服务端数据库，AI 大管家拥有完整读取权限（${byteLen} 字节）。当前文本模型无法"看见"像素；若接入视觉（vision）模型，可直接把该 data URL 作为图像输入。`
              }
            }
            return {
              accessible: true, contentType: 'file', storage: 'inline_data_url',
              fileName: meta.originalName || 'file', mimeType: mime, byteSize: byteLen, onServer: true,
              message: `文件以 base64 内联存储于服务端数据库，AI 拥有读取权限（${byteLen} 字节）。`
            }
          }

          // —— A2) 文件复制类：content_encrypted 是源文件路径（JSON 数组或裸路径），字节未上传服务端 ——
          if (type === 'file') {
            let pathRefs = null
            try {
              const p = JSON.parse(raw)
              if (Array.isArray(p)) pathRefs = p.filter(x => typeof x === 'string')
            } catch { /* 不是 JSON 数组 */ }
            if (!pathRefs && (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('/') || raw.includes('\\'))) pathRefs = [raw]
            if (pathRefs && pathRefs.length) {
              return {
                accessible: false, contentType: 'file', storage: 'path_reference',
                sourcePaths: pathRefs, onServer: false,
                message: '这是「文件复制」条目：服务端仅保存源文件路径，文件字节并未上传（就在你的本机/原设备上）。AI 可读取并展示这些路径以辅助你在本地定位、粘贴或打开该文件，但无法读取其字节内容——需在你的设备上操作。'
              }
            }
          }

          // —— B) 磁盘文件 ——
          const located = type === 'image'
            ? locateStoredFile(item.content_encrypted, [IMAGE_DIR])
            : locateStoredFile(item.content_encrypted, [FILE_DIR, UPLOAD_BASE])

          if (type === 'image') {
            return {
              accessible: true,
              contentType: 'image',
              storage: 'server_disk',
              fileName: meta.originalName || item.content_encrypted,
              mimeType: meta.mimeType,
              width: meta.width,
              height: meta.height,
              sizeBytes: located ? located.size : (meta.compressedSize || item.content_size),
              originalSize: meta.originalSize,
              onServer: !!located,
              message: located
                ? '图片字节完整存储于服务端磁盘，AI 大管家拥有读取与检索权限。当前文本模型无法"看见"像素；要识别图像内容需接入支持视觉（vision）的模型。你可在应用内直接预览，或让我管理/检索该图片的元数据。'
                : '数据库记录存在，但磁盘文件缺失（可能已被清理），仅能返回元数据。'
            }
          }

          // file：文本/代码类直接读取原文；其他二进制返回元数据并声明可访问
          const ext = (meta.extension || path.extname(item.content_encrypted || '') || '').toLowerCase()
          const isText = TEXT_PREVIEW_EXTENSIONS.has(ext)
          if (isText && located && located.size <= 5 * 1024 * 1024) {
            try {
              const buf = await fs.readFile(located.path)
              let content = buf.toString('utf-8')
              if (content.includes('\ufffd')) content = buf.toString('latin1')
              const limit = 50000
              const truncated = content.length > limit
                ? content.slice(0, limit) + `\n…[截断，原文 ${content.length} 字符]`
                : content
              return {
                accessible: true, contentType: 'file', textFile: true,
                fileName: meta.originalName || item.content_encrypted, extension: ext,
                sizeBytes: located.size, content: truncated
              }
            } catch { /* 落到下方元数据分支 */ }
          }
          return {
            accessible: true,
            contentType: 'file',
            storage: 'server_disk',
            fileName: meta.originalName || item.content_encrypted,
            extension: ext,
            mimeType: meta.mimeType,
            sizeBytes: located ? located.size : item.content_size,
            onServer: !!located,
            textReadable: isText,
            message: located
              ? (isText
                  ? '文本/代码文件已完整读取（见 content 字段）。'
                  : `文件字节完整存储于服务端磁盘，AI 大管家拥有读取权限。该类型为非文本（${ext || '未知'}），如需提取其中文本（如 PDF/Word）可进一步接入解析器。`)
              : '数据库记录存在，但磁盘文件缺失，仅能返回元数据。'
          }
        }

        // 高级密码保护：AI 通道一律拒绝返回明文，即使提供了 password 也不解密。
        // 明文只允许用户在 ClipSync 应用内凭密码查看，绝不出现在聊天/工具通道。
        // password 参数保留在 schema 中仅作兼容，此处硬性忽略其值，绝不调用 unlockWithPassword。
        if (item.protection_level === 'advanced') {
          return {
            error: '该条目受高级密码保护，无法在此读取',
            reason: 'advanced_protected',
            protectionLevel: 'advanced',
            hint: '该条目启用了高级密码保护（独立 DEK 加密）。出于隐私安全，AI 通道无法也不应获取其明文，即使提供密码也不会解密。请在 ClipSync 应用内查看这条内容，或使用恢复密钥。'
          }
        }

        // none / pin：主密钥可解密
        let plain
        try {
          plain = decrypt(item.content_encrypted)
        } catch (e) {
          return { error: '解密失败', reason: e.message }
        }
        return {
          contentType: type,
          protectionLevel: item.protection_level,
          note: item.protection_level === 'pin' ? 'PIN 保护仅控制客户端展示，服务端内容可被解密。' : undefined,
          content: (plain || '').slice(0, 50000),
          sizeBytes: item.content_size
        }
      }

      case 'get_clip_meta': {
        const { clip_id } = args
        if (!clip_id) return { error: 'clip_id is required' }
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, metadata, created_at, updated_at, source_device_id
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: '未找到该条目' }
        const i = result.rows[0]
        return {
          id: i.id,
          type: i.content_type,
          preview: (i.content_preview || '').slice(0, 200),
          sizeBytes: i.content_size,
          isFavorite: i.is_favorite,
          archived: i.archived,
          protectionLevel: i.protection_level,
          tags: i.metadata?.tags || [],
          deviceId: i.source_device_id,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          note: '只返回元数据，不含明文。需要明文请调用 read_clip_content。'
        }
      }

      case 'get_protected_clips': {
        const result = await pool.query(
          `SELECT id, content_type, protection_level, content_size, created_at
           FROM clipboard_items WHERE user_id = $1 AND protection_level <> 'none'
           ORDER BY created_at DESC`,
          [userId]
        )
        return { protectedItems: result.rows, count: result.rowCount }
      }

      case 'get_archived_clips': {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, protection_level, created_at
           FROM clipboard_items WHERE user_id = $1 AND archived = TRUE
           ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { archivedItems: result.rows, count: result.rowCount }
      }

      case 'get_subscription_details': {
        const ctx = await getAiContext(userId)
        const sub = ctx.subscription
        const usage = await pool.query(
          `SELECT COUNT(*)::int AS total, COALESCE(SUM(content_size),0)::bigint AS total_bytes
           FROM clipboard_items WHERE user_id = $1`,
          [userId]
        )
        return {
          plan: sub
            ? {
                name: sub.plan_name,
                displayName: sub.display_name,
                maxDevices: sub.max_devices,
                maxItems: sub.max_clipboard_items,
                maxFileMb: sub.max_file_size_mb,
                maxStorageMb: sub.max_storage_mb
              }
            : 'free',
          usage: { totalItems: usage.rows[0].total, totalBytes: Number(usage.rows[0].total_bytes) },
          note: '套餐限制见 plan 字段；usage 为当前用量（条数 + 内容总字节）。'
        }
      }

      case 'get_security_overview': {
        const userRes = await pool.query('SELECT two_factor_enabled, is_active FROM users WHERE id = $1', [userId])
        const u = userRes.rows[0] || {}
        const dev = await pool.query(
          'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_online)::int AS online FROM devices WHERE user_id = $1',
          [userId]
        )
        const prot = await pool.query(
          "SELECT COUNT(*)::int AS advanced FROM clipboard_items WHERE user_id = $1 AND protection_level = 'advanced'",
          [userId]
        )
        return {
          twoFactorEnabled: !!u.two_factor_enabled,
          accountActive: !!u.is_active,
          devices: { total: dev.rows[0].total, online: dev.rows[0].online },
          advancedProtectedItems: prot.rows[0].advanced,
          note: '2FA 状态、设备在线数、高级密码保护条目数。更多账号安全在应用内「设置 → 安全」中管理。'
        }
      }

      case 'get_template_variables': {
        const result = await pool.query(
          'SELECT name, value, updated_at FROM template_variables WHERE user_id = $1 ORDER BY name',
          [userId]
        )
        return { variables: result.rows, count: result.rowCount }
      }

      case 'get_notifications': {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, notification_type, title, body, read, created_at
           FROM notification_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { notifications: result.rows, count: result.rowCount }
      }

      // ============ 大管家增强：项目元知识 ============
      case 'explain_feature': {
        const { feature } = args
        return { doc: getFeatureDoc(feature) }
      }
      case 'explain_privacy_model': {
        return { doc: getPrivacyModelDoc() }
      }
      case 'explain_deployment': {
        return { doc: getDeploymentDoc() }
      }
      case 'get_project_architecture': {
        return { doc: getArchitectureDoc() }
      }

      default:
        return { error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    logger.error('Tool execution error:', err)
    return { error: err.message }
  }
}

/**
 * 执行工具调用（审计包装器，对外导出名保持 executeTool 不变）
 * 对 executeToolInner 做计时 + 成功/失败路径均写审计，语义与原先完全一致：
 * 返回 { error: ... } 的对象原样透传、异常仍向上抛出，调用方无需改动。
 * Agent-C 叠加：对 DESTRUCTIVE_CONFIRM_NEEDED 集合内的破坏性工具先走确认门控
 * （SSE 确认卡片 → approve 入口），批准后才执行 Inner 并审计；拒绝/超时/断流返回 REJECTED_BY_USER。
 * @param {string} toolName
 * @param {object} args
 * @param {string} userId
 * @param {string} [role] 角色键
 * @param {string} [requestId] 关联 requestId（确认门控透传），无则内部生成
 * @param {object} [opts] { sendDelta, req } SSE 通道与请求对象（确认事件下发 / 断流清理用）
 */
async function executeTool(toolName, args, userId, role, requestId, opts = {}) {
  const start = Date.now()
  let result
  // 破坏性工具确认门控生成的 requestId → 审计与 confirm 事件同 requestId 可追溯。
  let confirmRequestId = requestId
  try {
    if (DESTRUCTIVE_CONFIRM_NEEDED.has(toolName)) {
      const gate = await runConfirmGate(toolName, args, userId, role, requestId, opts)
      confirmRequestId = gate.requestId
      if (gate.approved && gate.result !== undefined) {
        // 批准后 approve 入口已执行 Inner，结果回填到这里；沿用门控 requestId 写审计。
        result = gate.result
      } else {
        // 拒绝 / 超时 / 断流 / 并发被拒：返回 REJECTED_BY_USER（并发场景带更明确错误）。
        result = (gate.result && gate.result.error === 'CONCURRENT_CONFIRM_REQUEST')
          ? gate.result
          : { error: 'REJECTED_BY_USER' }
      }
    } else {
      result = await executeToolInner(toolName, args, userId, role)
    }
  } catch (err) {
    await logToolAudit({
      userId,
      role,
      tool: toolName,
      argsSummary: args,
      resultSummary: null,
      ok: false,
      durationMs: Date.now() - start,
      requestId: confirmRequestId,
    })
    throw err // 不改变既有语义：异常仍向上抛出
  }
  // ok 由 result 是否含 error 字段判定（executeToolInner 成功返回不带 error，失败返回 { error }）
  const ok = !(result && typeof result === 'object' && 'error' in result)
  await logToolAudit({
    userId,
    role,
    tool: toolName,
    argsSummary: args,
    resultSummary: result,
    ok,
    durationMs: Date.now() - start,
    requestId: confirmRequestId,
  })
  return result
}

export { executeTool }
export default router

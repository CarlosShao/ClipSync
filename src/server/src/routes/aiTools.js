import { Router } from 'express'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import pool from '../db/pool.js'
import config from '../config.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { getAiContext } from '../utils/aiContext.js'
import { decrypt, encrypt, encryptField } from '../utils/encryption.js'
import { logToolAudit, logAuditEvent, getAuditLogs } from '../utils/audit.js'
import { blacklistJti, parseDurationToSeconds } from '../utils/redis-client.js'
import { getFeatureDoc, getPrivacyModelDoc, getDeploymentDoc, getArchitectureDoc } from '../utils/aiKnowledge.js'
import { assertToolAllowed, getToolsForRole } from '../utils/aiSystemPrompt.js'
import { setupAdvancedProtection, unlockWithPassword } from '../utils/protectionCrypto.js'
import { authenticateToken } from '../middleware/auth.js'
import { isValidUUID } from '../validation/validator.js'
import { TEXT_PREVIEW_EXTENSIONS } from './media.js'
import { ocrClipById } from '../utils/aiOcr.js'
import { getVersionHistory, restoreVersion } from '../utils/versionManager.js'
import { getSlowQueries, getPoolStatus } from '../utils/query-monitor.js'

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

// ============ B6：upload_file 扩展白名单 ============
// 黑名单（只拦已知危险扩展）天然滞后，改为白名单制：
//  1) 不在名单内的扩展一律拒绝；
//  2) 声明的 mime_type 必须与扩展名同类（前缀/精确匹配），防止「exe 内容伪装 .txt」式绕过。
// 刻意不含：svg/xhtml（可内嵌脚本）、.htaccess、无扩展名文件与一切可执行/脚本扩展。
const UPLOAD_FILE_ALLOWED_EXT = new Map([
  // 图片
  ['.png', ['image/png']],
  ['.jpg', ['image/jpeg']],
  ['.jpeg', ['image/jpeg']],
  ['.gif', ['image/gif']],
  ['.webp', ['image/webp']],
  ['.bmp', ['image/bmp']],
  ['.ico', ['image/x-icon', 'image/vnd.microsoft.icon', 'image/icon']],
  // 文本 / 数据 / 配置
  ['.txt', ['text/']],
  ['.md', ['text/', 'text/markdown']],
  ['.csv', ['text/', 'application/csv']],
  ['.log', ['text/']],
  ['.json', ['application/json', 'text/json']],
  ['.xml', ['application/xml', 'text/xml']],
  ['.yaml', ['application/yaml', 'application/x-yaml', 'text/yaml']],
  ['.yml', ['application/yaml', 'application/x-yaml', 'text/yaml']],
  ['.toml', ['text/', 'application/toml']],
  ['.ini', ['text/']],
  ['.sql', ['text/', 'application/sql']],
  // 办公文档 / 归档
  ['.pdf', ['application/pdf']],
  ['.doc', ['application/msword']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xls', ['application/vnd.ms-excel']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.ppt', ['application/vnd.ms-powerpoint']],
  ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation']],
  ['.zip', ['application/zip', 'application/x-zip-compressed']],
])

// ============ RBAC 管理工具辅助（feature/ai-rbac-backend）============
// 哈希盐与 auth.js 保持一致（phone_hash / email_hash 计算）
// B5 fail-fast：ENCRYPTION_KEY 缺失时拒绝计算字段哈希。
// 已删除公开兜底盐 'CLIPSYNC_SALT_2026'——固定公开盐等于允许离线彩虹表反查
// phone_hash/email_hash，必须视为配置错误而非可降级路径。
// 盐在每次调用时读取（而非模块加载时固化）：import 本文件永不因配置炸掉，
// 仅在真正需要哈希的工具（create_user 等）首次调用点抛出明确错误。
function getFieldSalt() {
  const salt = process.env.ENCRYPTION_KEY?.substring(0, 16)
  if (!salt) {
    throw new Error('[SECURITY] ENCRYPTION_KEY 未配置：拒绝使用公开兜底盐计算字段哈希（B5 fail-fast）')
  }
  return salt
}

function computeFieldHash(value) {
  if (!value) return null
  return crypto.createHash('sha256').update(String(value) + getFieldSalt()).digest('hex')
}

// 手机号脱敏：138****11072
function maskPhone(p) {
  if (!p) return null
  const s = String(p)
  if (s.length < 7) return s.slice(0, 1) + '****'
  return s.slice(0, 3) + '****' + s.slice(-4)
}

// 邮箱脱敏：a***b@example.com
function maskEmail(e) {
  if (!e) return null
  const s = String(e)
  const at = s.indexOf('@')
  if (at <= 1) return '***' + s.slice(at)
  return s.slice(0, 1) + '***' + s.slice(at - 1)
}

// B8：批量条目数组参数上限。clip_ids 超过上限直接返回参数错误（不执行任何 SQL），
// 防止超长数组撑爆 IN 查询/审计行。destroy_clips 有更严的 50 条独立上限，不受此影响。
const MAX_CLIP_IDS = 200

/**
 * 校验 clip_ids 数组是否超出单批上限。
 * @returns {object|null} 超限时返回参数错误对象，否则返回 null
 */
function clipIdsLimitError(clip_ids, max = MAX_CLIP_IDS) {
  if (!Array.isArray(clip_ids) || clip_ids.length <= max) return null
  return {
    error: 'CLIP_IDS_TOO_LARGE',
    code: 'CLIP_IDS_TOO_LARGE',
    message: `clip_ids 单次最多 ${max} 条，本次传入 ${clip_ids.length} 条；请分批调用（每批 ≤${max}）。`,
    received: clip_ids.length,
    maxPerBatch: max,
  }
}

// 吊销指定用户全部活跃会话（user_sessions is_active=false + jti 黑名单，与 auth.js 停用逻辑一致）
async function revokeUserSessions(targetUserId) {
  const revoked = await pool.query(
    `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
     WHERE user_id = $1 AND is_active = TRUE RETURNING id`,
    [targetUserId]
  )
  const ttl = parseDurationToSeconds(config.jwt.expiresIn)
  for (const row of revoked.rows) {
    await blacklistJti(row.id, ttl)
  }
  return revoked.rowCount || 0
}

// 订阅套餐等级映射（Free < Pro < Enterprise），供 upgrade/downgrade 判定
const PLAN_RANK = { Free: 0, Pro: 1, Enterprise: 2 }

// 目标用户 + 目标角色保护：目标为自身或超管时返回拒绝原因（否则 null）
async function guardTargetUser(targetUserId, operatorUserId) {
  if (String(targetUserId) === String(operatorUserId)) {
    return { forbidden: true, code: 'SELF_TARGET', error: 'SUPER_ADMIN_DEMOTE_FORBIDDEN' }
  }
  const t = await pool.query('SELECT u.id, r.role_key FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [targetUserId])
  if (t.rows.length === 0) return { forbidden: false, notFound: true }
  if (t.rows[0].role_key === 'super_admin') {
    return { forbidden: true, code: 'SUPER_ADMIN_TARGET', error: 'SUPER_ADMIN_DEMOTE_FORBIDDEN' }
  }
  return { forbidden: false }
}

/**
 * ClipSync 工具定义
 * 这些工具可以被 AI Agent 调用来执行实际操作
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户提问、提供选项让用户做出选择、或者一次性提出多个连续问题（分页问卷式交互卡片）时调用。支持单选/多选、支持用户在每道题下选择“其他”并自定义填写、支持分页切换多道问题、并在末页提供“补充说明”大输入框供用户输入附加要求。调用此工具后 Agent 工作流会安全暂停，等待用户在界面卡片上做出选择并提交。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '问题列表（支持 1 到多个问题供用户分页作答）',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问题标题或指引说明' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '供用户选择的预设选项列表（无需手动写“其他”，前端卡片默认自带“其他(自定义输入)”选项）'
                },
                is_multi_select: { type: 'boolean', description: '是否允许多选，默认 false（单选）' },
                context: { type: 'string', description: '该问题的背景提示说明（可选）' }
              },
              required: ['question', 'options']
            }
          },
          question: { type: 'string', description: '单问题模式：问题标题' },
          options: { type: 'array', items: { type: 'string' }, description: '单问题模式：选项列表' },
          is_multi_select: { type: 'boolean', description: '单问题模式：是否多选' },
          context: { type: 'string', description: '总体背景说明（可选）' }
        }
      }
    }
  },
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
      // ============ W1-C 工具域 A：收藏夹 / 收藏夹条目 / 标签 / 剪贴板 / 保护 / 媒体（18 个）============
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
      // ============ W2-D 工具域 B：模板 / 共享链接 / 设备 / 通知 / 会话 / 版本 / 工作流 / 模板变量 / 账号 / 订阅 / 调查 / 运维 ============
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
  // RBAC 管理域写类（feature/ai-rbac-backend）
  'create_user',
  'update_user_role',
  'delete_user',
  'reset_user_password',
  'disable_user',
  'update_system_config',
  'toggle_feature',
  'unpair_device',
  'upgrade_subscription',
  'downgrade_subscription',
  'create_sub_collection',
  // W1-C 工具域 A 写类（15 个）：收藏夹 / 条目 / 标签 / 剪贴板 / 保护 / 媒体
  'delete_collection',
  'update_collection',
  'move_collection',
  'reorder_collections',
  'add_item_to_collection',
  'remove_item_from_collection',
  // B3 热修：批量移动也是写操作，缺登记会让子代理拿到"只读"假象并发写收藏夹
  'batch_move_to_collection',
  'update_collection_tags',
  'delete_tag',
  'update_clip',
  'mark_sensitive',
  'mark_clip_used',
  'set_item_protection',
  'remove_item_protection',
  'upload_image',
  'upload_file',
  // W2-D 工具域 B 写类（17 个）：模板 / 共享链接 / 设备 / 通知 / 会话 / 版本 / 工作流 / 模板变量 / 账号 / 订阅 / 调查
  'delete_template',
  'delete_shared_link',
  'create_workflow_rule',
  'update_workflow_rule',
  'delete_workflow_rule',
  'update_notification_preferences',
  'mark_notification_read',
  'update_device',
  'unpair_own_device',
  'terminate_session',
  'restore_version',
  'upsert_template_variables',
  'delete_template_variable',
  'update_profile',
  'cancel_subscription',
  'resume_subscription',
  'submit_survey',
])

/**
 * 只读工具子集：供并行子代理使用，杜绝子代理并发触发写入/破坏性操作。
 * 与 TOOLS 同步维护——新增写入类工具时必须加入 WRITE_TOOL_NAMES，否则会被误判为只读。
 */
export const READONLY_TOOLS = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.function.name))

/**
 * 子代理禁用工具集合：UI 阻塞型门控工具只允许在主线程（单代理 / 协调器）使用。
 * ask_user 的交互卡片只渲染在主消息上（AiMessage.askUserStep ← message.toolCalls），
 * 子代理的增量被路由进独立 agent 卡片——若子代理调用 ask_user，会形成
 * "门控等待用户 → 用户等卡片 → 卡片永远不会出现"的死锁，直至 5 分钟超时。
 */
export const WORKER_BLOCKED_TOOLS = new Set(['ask_user'])

/**
 * 子代理工具集：角色过滤后的只读工具，再剔除阻塞型门控工具。
 * 供 aiOrchestrator.runWorkers 使用，保证并行子代理永不触发人类在回路等待。
 */
export function getWorkerTools(role) {
  return getToolsForRole(role, READONLY_TOOLS).filter((t) => !WORKER_BLOCKED_TOOLS.has(t.function.name))
}

// ============ Agent-C：破坏性操作确认门控 ============
// 需用户在前端明确确认后才能执行的破坏性工具集合（写工具先按此协议演进）。
// 命中集合的工具不会直接被 executeToolInner 执行，而是：
//   1) 登记全局 pendingRequests（requestId → entry）；
//   2) 通过 SSE 下发 confirm_tool_action 事件等用户确认；
//   3) 批准后执行并写审计；拒绝/超时/断流则返回 REJECTED_BY_USER。
export const DESTRUCTIVE_CONFIRM_NEEDED = new Set([
  'destroy_clips',
  // RBAC 管理域破坏性/敏感写（feature/ai-rbac-backend，需用户确认）
  // B7：disable_user 直接冻结账号并吊销全部会话，属破坏性操作，纳入确认集
  'delete_user',
  'update_user_role',
  'reset_user_password',
  'disable_user',
  'update_system_config',
  'toggle_feature',
  'unpair_device',
  'downgrade_subscription',
  // W1-C 工具域 A：删除收藏夹（级联删除 ltree 后代）为破坏性操作
  'delete_collection',
  // W2-D 工具域 B：解绑设备 / 踢出会话 / 恢复版本 为破坏性/敏感操作，需用户确认
  'unpair_own_device',
  'terminate_session',
  'restore_version',
])

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
  if (toolName === 'archive_items' && n > 1) {
    return `将归档 ${n} 条剪贴板条目。若只需归档部分条目，请先取消并明确指定。`
  }
  if (toolName === 'unarchive_items' && n > 1) {
    return `将从归档中恢复 ${n} 条剪贴板条目。`
  }
  if (toolName === 'delete_user') {
    return `将物理删除用户 ${args?.user_id || ''} 及其全部级联数据（剪贴板/设备/订阅/文件等），该操作不可恢复。`
  }
  if (toolName === 'update_user_role') {
    return `将把用户 ${args?.user_id || ''} 的角色修改为「${args?.role || ''}」。`
  }
  if (toolName === 'reset_user_password') {
    return `将重置用户 ${args?.user_id || ''} 的密码为一次性临时密码，其现有会话登录将失效。`
  }
  if (toolName === 'update_system_config') {
    return `将更新系统配置项「${args?.config_key || ''}」。`
  }
  if (toolName === 'toggle_feature') {
    return `将${args?.enabled ? '开启' : '关闭'}功能开关「${args?.flag_key || ''}」。`
  }
  if (toolName === 'unpair_device') {
    return `将删除设备 ${args?.device_id || ''} 的配对记录。`
  }
  if (toolName === 'downgrade_subscription') {
    return `将把用户 ${args?.user_id || ''} 的订阅降级为「${args?.plan || ''}」。`
  }
  if (toolName === 'delete_collection') {
    return `将删除收藏夹 ${args?.collection_id || ''} 及其所有子收藏夹（级联删除层级结构）。该操作不可恢复，需要用户确认。`
  }
  if (toolName === 'unpair_own_device') {
    return `将解绑（删除）你的设备 ${args?.device_id || ''} 的配对记录，该设备将无法再同步本账号剪贴板。`
  }
  if (toolName === 'terminate_session') {
    return `将强制下线会话 ${args?.session_id || ''}，其登录状态立即失效（JWT 吊销）。`
  }
  if (toolName === 'restore_version') {
    return `将把剪贴板条目恢复到历史版本 ${args?.version_id || ''}（内容写回条目并生成新版本记录）。`
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

  // 无 SSE 通道（如单测、非流式等）时直接拒绝，不进入等待和 pending
  if (!sendDelta) {
    return { approved: false, requestId: rid }
  }

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

const pendingAskUserRequests = new Map()
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟超时

/**
 * ask_user 交互提问门控：
 * 下发 SSE 交互卡片事件并挂起 Promise，等待前端用户在卡片上点击选择并提交（通过 POST /api/ai/chat/respond_ask_user 回调）。
 * 提交后此 Promise 立刻 resolve，工作流直接无缝继续执行下一轮（单会话闭环，不产生多余用户消息气泡）。
 */
export async function runAskUserGate(toolName, args, userId, role, requestId, opts = {}) {
  const sendDelta = opts.sendDelta
  const rid = requestId || uuidv4()

  if (!sendDelta) {
    return { user_response: '非流式环境跳过交互卡片', skipped: true, requestId: rid }
  }

  const entry = {
    requestId: rid,
    tool: toolName,
    args,
    userId,
    role,
    settled: false,
    timer: null,
    heartbeat: null,
    settle: () => {},
  }
  const onReqClose = () => entry.settle({ user_response: '用户关闭了连接', cancelled: true })

  return new Promise((resolveOuter) => {
    entry.settle = (outcome) => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      clearInterval(entry.heartbeat)
      if (opts.req && typeof opts.req.removeListener === 'function') {
        opts.req.removeListener('close', onReqClose)
      }
      pendingAskUserRequests.delete(rid)
      resolveOuter(outcome)
    }

    entry.timer = setTimeout(() => {
      logger.warn('[AI] ask_user timed out waiting for user choice:', rid)
      entry.settle({ user_response: '等待用户选择超时（5分钟未操作）', timeout: true })
    }, ASK_USER_TIMEOUT_MS)

    pendingAskUserRequests.set(rid, entry)

    // 15 秒心跳保活 SSE 流（前端据此维持"流活跃"状态，避免被无响应看门狗误杀）
    entry.heartbeat = setInterval(() => {
      try {
        sendDelta({ meta: { type: 'heartbeat', timestamp: Date.now() } })
      } catch {
        /* ignore */
      }
    }, 15000)

    // 下发 SSE 交互卡片元数据（前端兜底渲染：无同 id tool_call 时合成 ask_user 卡片）
    sendDelta({
      meta: {
        type: 'ask_user_action',
        requestId: rid,
        questions: Array.isArray(args.questions) ? args.questions : [{ question: args.question, options: args.options, is_multi_select: args.is_multi_select, context: args.context }],
        context: args.context || '',
      },
    })

    // 客户端断开时结算等待（用户关页面/取消流 → 门控立即释放，不残留 5 分钟）
    if (opts.req && typeof opts.req.on === 'function') {
      opts.req.on('close', onReqClose)
    }
  })
}

/**
 * 响应 ask_user 用户选择（POST /api/ai/chat/respond_ask_user 调用）：
 */
export async function respondAskUserRequest(requestId, userId, userResponse) {
  let entry = requestId ? pendingAskUserRequests.get(requestId) : null
  if (!entry) {
    for (const [rid, e] of pendingAskUserRequests) {
      if (e.userId === userId && !e.settled) {
        entry = e
        break
      }
    }
  }
  if (!entry || entry.userId !== userId) {
    return { accepted: false, notFound: true }
  }
  if (entry.settled) {
    return { accepted: false, expired: true }
  }
  entry.settle({ success: true, user_response: userResponse })
  return { accepted: true }
}

/**
 * 供 SSE 流关闭（safeFinish / req close）时清理该用户残留的 pending 项。
 */
export function cancelPendingForUser(userId) {
  for (const [rid, e] of pendingRequests) {
    if (e.userId === userId && !e.settled) {
      e.settle({ approved: false, requestId: rid, cancelled: true })
    }
  }
  for (const [rid, e] of pendingAskUserRequests) {
    if (e.userId === userId && !e.settled) {
      e.settle({ user_response: '用户关闭了连接', cancelled: true, requestId: rid })
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
      // 说明：ask_user 不在 executeToolInner 内实现——executeTool 顶部将其拦截进
      // runAskUserGate（人类在回路门控），此处的 switch 只处理"立即执行型"工具。

      case 'find_duplicates': {
        const type = args.type && args.type !== 'all' ? args.type : null
        const collectionId = args.collection_id && isValidUUID(args.collection_id) ? args.collection_id : null
        const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 100), 200)

        let query = `
          SELECT c.id, c.type, c.content, c.content_preview, c.created_at, c.is_favorite
          FROM clipboard_items c
        `
        const params = [userId]
        let whereClauses = ['c.user_id = $1', 'c.is_archived = FALSE', "COALESCE(c.protection_level, 'none') = 'none'"]

        if (collectionId) {
          params.push(collectionId)
          query += ` INNER JOIN favorite_collection_items fci ON fci.item_id = c.id AND fci.collection_id = $${params.length}`
        }

        if (type) {
          params.push(type)
          whereClauses.push(`c.type = $${params.length}`)
        }

        query += ` WHERE ${whereClauses.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${limit}`

        const res = await pool.query(query, params)
        const groups = new Map()

        for (const row of res.rows) {
          let plainText = row.content_preview || ''
          if (row.content) {
            try {
              plainText = decrypt(row.content) || plainText
            } catch { /* ignore decrypt error */ }
          }
          const normalized = plainText.trim()
          if (!normalized) continue

          const key = normalized.length > 200 ? crypto.createHash('md5').update(normalized).digest('hex') : normalized
          if (!groups.has(key)) {
            groups.set(key, {
              preview: normalized.slice(0, 100),
              type: row.type,
              items: [],
            })
          }
          groups.get(key).items.push({
            id: row.id,
            created_at: row.created_at,
            is_favorite: row.is_favorite,
          })
        }

        const duplicateGroups = []
        let totalDuplicates = 0
        for (const [, grp] of groups) {
          if (grp.items.length > 1) {
            duplicateGroups.push({
              preview: grp.preview,
              type: grp.type,
              count: grp.items.length,
              keep_id: grp.items[0].id,
              duplicate_ids: grp.items.slice(1).map((it) => it.id),
              all_ids: grp.items.map((it) => it.id),
            })
            totalDuplicates += grp.items.length - 1
          }
        }

        return {
          total_scanned: res.rows.length,
          duplicate_groups_count: duplicateGroups.length,
          total_duplicate_items: totalDuplicates,
          duplicate_groups: duplicateGroups.slice(0, 20),
          suggestion: duplicateGroups.length > 0
            ? '发现重复项！可调用 ask_user 询问用户是否一键清理多余重复项（保留每组最新一条）。'
            : '未发现明显重复的剪贴板条目。'
        }
      }

      case 'batch_move_to_collection': {
        const { collection_id, item_ids } = args
        if (!collection_id || !isValidUUID(collection_id)) {
          return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'collection_id 必须为合法 UUID' }
        }
        if (!Array.isArray(item_ids) || item_ids.length === 0) {
          return { error: 'INVALID_ARGS', code: 'INVALID_ARGS', message: 'item_ids 必须为非空数组' }
        }
        const validIds = item_ids.filter((id) => isValidUUID(id))
        if (validIds.length === 0) {
          return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'item_ids 中没有合法的 UUID' }
        }
        const col = await pool.query(
          'SELECT id, name FROM favorite_collections WHERE id = $1 AND user_id = $2',
          [collection_id, userId]
        )
        if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }

        const items = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [validIds, userId]
        )
        const matchedIds = items.rows.map((r) => r.id)
        if (matchedIds.length === 0) {
          return { error: 'ITEMS_NOT_FOUND', code: 'ITEMS_NOT_FOUND', message: '未找到属于当前用户的目标条目' }
        }

        // 唯一归属：先从其他收藏夹批量移除
        await pool.query(
          'DELETE FROM favorite_collection_items WHERE item_id = ANY($1) AND collection_id <> $2',
          [matchedIds, collection_id]
        )
        const maxOrderRes = await pool.query(
          'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collection_items WHERE collection_id = $1',
          [collection_id]
        )
        const baseOrder = parseInt(maxOrderRes.rows[0]?.max_order || '0', 10)

        for (let i = 0; i < matchedIds.length; i++) {
          await pool.query(
            `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
             VALUES ($1, $2, $3) ON CONFLICT (collection_id, item_id) DO NOTHING`,
            [collection_id, matchedIds[i], baseOrder + i + 1]
          )
        }

        return {
          success: true,
          collection_id,
          collection_name: col.rows[0].name,
          moved_count: matchedIds.length,
          item_ids: matchedIds,
          note: `已成功将 ${matchedIds.length} 条数据移动到收藏夹 "${col.rows[0].name}"。`
        }
      }

      case 'export_data': {
        const format = args.format || 'markdown'
        const collectionId = args.collection_id && isValidUUID(args.collection_id) ? args.collection_id : null
        const type = args.type && args.type !== 'all' ? args.type : null
        const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 50), 100)

        let query = `
          SELECT c.id, c.type, c.content, c.content_preview, c.created_at, c.is_favorite, c.metadata
          FROM clipboard_items c
        `
        const params = [userId]
        let whereClauses = ['c.user_id = $1', 'c.is_archived = FALSE', "COALESCE(c.protection_level, 'none') = 'none'"]

        if (collectionId) {
          params.push(collectionId)
          query += ` INNER JOIN favorite_collection_items fci ON fci.item_id = c.id AND fci.collection_id = $${params.length}`
        }
        if (type) {
          params.push(type)
          whereClauses.push(`c.type = $${params.length}`)
        }

        query += ` WHERE ${whereClauses.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${limit}`
        const res = await pool.query(query, params)

        const rowsData = res.rows.map((row, idx) => {
          let text = row.content_preview || ''
          if (row.content) {
            try {
              text = decrypt(row.content) || text
            } catch { /* ignore */ }
          }
          return {
            index: idx + 1,
            id: row.id,
            type: row.type,
            created_at: row.created_at,
            is_favorite: row.is_favorite,
            tags: row.metadata?.tags || [],
            content: text,
          }
        })

        let exportedText = ''
        if (format === 'json') {
          exportedText = JSON.stringify(rowsData, null, 2)
        } else if (format === 'csv') {
          const headers = ['Index', 'ID', 'Type', 'CreatedAt', 'IsFavorite', 'Tags', 'Content']
          const csvLines = [headers.join(',')]
          for (const item of rowsData) {
            const escapedContent = `"${(item.content || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
            csvLines.push([item.index, item.id, item.type, item.created_at, item.is_favorite, `"${item.tags.join(';')}"`, escapedContent].join(','))
          }
          exportedText = csvLines.join('\n')
        } else if (format === 'text') {
          exportedText = rowsData.map((it) => `[${it.index}] (${it.type}) ${new Date(it.created_at).toLocaleString()}\n${it.content}\n---`).join('\n')
        } else {
          // Markdown 格式
          const mdSections = [`# ClipSync 剪贴板数据导出报告\n> 导出时间：${new Date().toLocaleString()} · 共 ${rowsData.length} 条\n`]
          for (const item of rowsData) {
            mdSections.push(`### ${item.index}. [${item.type}] ${item.tags.length ? `\`${item.tags.join(', ')}\`` : ''}\n- **ID**: \`${item.id}\`\n- **时间**: ${new Date(item.created_at).toLocaleString()}\n\n\`\`\`\n${item.content.slice(0, 1000)}\n\`\`\`\n`)
          }
          exportedText = mdSections.join('\n')
        }

        return {
          format,
          total_items: rowsData.length,
          preview_snippet: exportedText.slice(0, 300),
          exported_text: exportedText,
        }
      }

      case 'show_diff_preview': {
        const { title, original_content, modified_content, target_id } = args
        const orig = String(original_content || '')
        const mod = String(modified_content || '')
        const origLines = orig.split('\n')
        const modLines = mod.split('\n')
        return {
          title: title || '变更对比预览',
          target_id: target_id || null,
          original_content: orig,
          modified_content: mod,
          original_lines_count: origLines.length,
          modified_lines_count: modLines.length,
          status: 'diff_rendered',
          message: '已在前端成功生成修改前后 Diff 对比卡片。'
        }
      }

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
        // B2：高级密码保护条目不参与搜索（明文预览/OCR 对 AI 隐藏）
        let sql = "SELECT id, content_type, content_preview, ocr_text, created_at FROM clipboard_items WHERE user_id = $1 AND COALESCE(protection_level, 'none') = 'none'"
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
        // B2：高级密码保护条目对 AI 整体不可见（含元数据），防止预览/属性侧信道泄露。
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, created_at, source_device_id
           FROM clipboard_items
           WHERE id = $1 AND user_id = $2 AND COALESCE(protection_level, 'none') = 'none'`,
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
        // B2：高级密码保护条目不出现在最近列表（不泄露明文预览）
        sql += ` AND COALESCE(protection_level, 'none') = 'none'`
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
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
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
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          archived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
          note: '已软删除（归档），可在归档列表中恢复。如需永久物理删除请启用 destroy_clips。',
        }
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
        // 先检查哪些 ID 实际存在（含 archived 状态），以便诊断"未找到"问题
        const existCheck = await pool.query(
          'SELECT id, archived FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))

        if (foundIds.length === 0) {
          return {
            error: 'NOT_FOUND',
            message: `指定的 ${clip_ids.length} 个条目 ID 在当前用户下均不存在。请确认 ID 是否正确，或条目是否属于当前用户。`,
            requested_ids: clip_ids,
            found: 0,
          }
        }

        // 只删除存在的条目
        const result = await pool.query(
          'DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          permanentlyDeleted: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
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
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
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
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        // 先检查存在性，返回未找到的 ID 以便 AI 诊断
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          archived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
      }

      case 'unarchive_items': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = false, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          unarchived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
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
        // path 为 ltree 列，标签不允许连字符：uuid 要去掉 '-'（对照 favorites.js 同款写法）
        const path = `root.${uuidv4().replace(/-/g, '_')}`
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

      // ============ RBAC 管理工具（feature/ai-rbac-backend）============
      case 'list_users': {
        const { keyword, page = 1, page_size = 20 } = args
        const safePage = Math.max(1, parseInt(page, 10) || 1)
        const safeSize = Math.min(Math.max(1, parseInt(page_size, 10) || 20), 100)
        const offset = (safePage - 1) * safeSize
        const kw = keyword && String(keyword).trim() ? `%${String(keyword).trim()}%` : null
        let sql = `SELECT u.id, u.nickname, u.phone, u.email, u.is_active, u.created_at,
                          r.role_key, r.name AS role_name
                   FROM users u LEFT JOIN roles r ON r.id = u.role_id`
        const params = []
        if (kw) {
          params.push(kw)
          sql += ` WHERE u.phone ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.nickname ILIKE $${params.length}`
        }
        sql += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(safeSize, offset)
        const result = await pool.query(sql, params)
        const totalParams = kw ? [kw] : []
        const totalSql = kw
          ? `SELECT COUNT(*) AS c FROM users WHERE phone ILIKE $1 OR email ILIKE $1 OR nickname ILIKE $1`
          : 'SELECT COUNT(*) AS c FROM users'
        const total = await pool.query(totalSql, totalParams)
        return {
          total: parseInt(total.rows[0].c, 10),
          page: safePage,
          page_size: safeSize,
          users: result.rows.map((u) => ({
            id: u.id,
            nickname: u.nickname,
            phone: maskPhone(u.phone),
            email: maskEmail(u.email),
            role: u.role_name,
            role_key: u.role_key,
            is_active: u.is_active,
            created_at: u.created_at,
          })),
        }
      }

      case 'create_user': {
        const { phone, email, nickname, password, role = 'user' } = args
        const cleanPhone = String(phone || '').trim()
        if (!/^1[3-9]\d{9}$/.test(cleanPhone)) {
          return { error: 'INVALID_PHONE', code: 'INVALID_PHONE', message: '手机号格式不正确' }
        }
        if (typeof password !== 'string' || password.length < 6) {
          return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: '密码至少 6 位' }
        }
        const cleanEmail = email ? String(email).trim().toLowerCase().slice(0, 254) : null
        if (cleanEmail) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
          if (!emailRegex.test(cleanEmail)) return { error: 'INVALID_EMAIL', code: 'INVALID_EMAIL' }
        }
        const cleanNickname = nickname ? String(nickname).trim().slice(0, 30) : ''
        const allowedRoles = ['user', 'admin']
        if (!allowedRoles.includes(role)) {
          const msg = role === 'super_admin'
            ? '不允许直接创建超级管理员（超管唯一）'
            : '角色仅支持 user/admin'
          return { error: 'INVALID_ROLE', code: 'INVALID_ROLE', message: msg }
        }
        const phoneHash = computeFieldHash(cleanPhone)
        const dup = await pool.query(
          'SELECT id FROM users WHERE phone = $1 OR phone_hash = $2',
          [cleanPhone, phoneHash]
        )
        if (dup.rows.length > 0) return { error: 'PHONE_EXISTS', code: 'PHONE_EXISTS' }
        if (cleanEmail) {
          const emailHash = computeFieldHash(cleanEmail)
          const dupEmail = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR email_hash = $2',
            [cleanEmail, emailHash]
          )
          if (dupEmail.rows.length > 0) return { error: 'EMAIL_EXISTS', code: 'EMAIL_EXISTS' }
        }
        const roleRes = await pool.query('SELECT id FROM roles WHERE role_key = $1', [role])
        if (roleRes.rows.length === 0) return { error: 'ROLE_NOT_FOUND', code: 'ROLE_NOT_FOUND' }
        const passwordHash = await bcrypt.hash(password, 12)
        const emailHash = cleanEmail ? computeFieldHash(cleanEmail) : null
        const userRes = await pool.query(
          `INSERT INTO users (phone, phone_hash, phone_encrypted, email, email_hash, email_encrypted,
                              nickname, password_hash, role_id, tos_accepted_at, privacy_accepted_at,
                              subscription_status, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), 'free', TRUE)
           RETURNING id, nickname, phone, email, is_active, created_at`,
          [
            cleanPhone, phoneHash, encryptField(cleanPhone),
            cleanEmail, emailHash, cleanEmail ? encryptField(cleanEmail) : null,
            cleanNickname, passwordHash, roleRes.rows[0].id,
          ]
        )
        const u = userRes.rows[0]
        return {
          success: true,
          user: {
            id: u.id,
            nickname: u.nickname,
            phone: maskPhone(u.phone),
            email: maskEmail(u.email),
            role,
            is_active: u.is_active,
            created_at: u.created_at,
          },
        }
      }

      case 'update_user_role': {
        const { user_id, role } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        if (!['user', 'admin'].includes(role)) {
          return { error: 'INVALID_ROLE', code: 'INVALID_ROLE', message: '角色仅支持 user/admin' }
        }
        const guard = await guardTargetUser(user_id, userId)
        if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        if (guard.forbidden) {
          return { error: guard.error, code: guard.code, message: '不能修改自身或超级管理员的角色' }
        }
        const roleRes = await pool.query('SELECT id FROM roles WHERE role_key = $1', [role])
        if (roleRes.rows.length === 0) return { error: 'ROLE_NOT_FOUND', code: 'ROLE_NOT_FOUND' }
        await pool.query('UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2', [roleRes.rows[0].id, user_id])
        await logAuditEvent({
          userId,
          action: 'update_user_role',
          resourceType: 'user',
          resourceId: String(user_id),
          details: { target_user_id: user_id, role },
        })
        return { success: true, user_id, role }
      }

      case 'delete_user': {
        const { user_id } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const guard = await guardTargetUser(user_id, userId)
        if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        if (guard.forbidden) {
          return { error: 'SUPER_ADMIN_DELETE_FORBIDDEN', code: guard.code === 'SELF_TARGET' ? 'SELF_TARGET' : 'SUPER_ADMIN_TARGET', message: '不能删除自身或超级管理员' }
        }
        await revokeUserSessions(user_id)
        const target = await pool.query('SELECT id, nickname FROM users WHERE id = $1', [user_id])
        if (target.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        await pool.query('DELETE FROM users WHERE id = $1', [user_id])
        await logAuditEvent({
          userId,
          action: 'delete_user',
          resourceType: 'user',
          resourceId: String(user_id),
          details: { target_user_id: user_id },
        })
        return {
          success: true,
          user_id,
          note: '已物理删除该用户，其剪贴板条目、设备、订阅等数据均被级联删除（CASCADE），不可恢复。',
        }
      }

      case 'reset_user_password': {
        const { user_id } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const guard = await guardTargetUser(user_id, userId)
        if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        if (guard.forbidden) {
          return { error: guard.error, code: guard.code, message: '不能重置自身或超级管理员的密码' }
        }
        const tempPassword = crypto.randomBytes(6).toString('base64url')
        const passwordHash = await bcrypt.hash(tempPassword, 12)
        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, user_id])
        await logAuditEvent({
          userId,
          action: 'reset_password',
          resourceType: 'user',
          resourceId: String(user_id),
          details: { target_user_id: user_id },
        })
        return {
          success: true,
          user_id,
          temp_password: tempPassword,
          note: '临时密码仅此出现一次，请安全转达目标用户，并提示其登录后立即修改。',
        }
      }

      case 'disable_user': {
        const { user_id, reason } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const guard = await guardTargetUser(user_id, userId)
        if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        if (guard.forbidden) {
          return { error: guard.error, code: guard.code, message: '不能停用自身或超级管理员' }
        }
        const safeReason = reason ? String(reason).trim().slice(0, 500) : '禁用（AI 管理工具）'
        await pool.query(
          'UPDATE users SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1, updated_at = NOW() WHERE id = $2',
          [safeReason, user_id]
        )
        const revoked = await revokeUserSessions(user_id)
        await logAuditEvent({
          userId,
          action: 'disable_user',
          resourceType: 'user',
          resourceId: String(user_id),
          details: { target_user_id: user_id, reason: safeReason },
        })
        return { success: true, user_id, revoked_sessions: revoked, reason: safeReason }
      }

      case 'get_system_config': {
        const { category } = args
        const params = []
        let sql = 'SELECT config_key, config_value, description, category, updated_at FROM system_configs'
        if (category && String(category).trim()) {
          params.push(String(category).trim())
          sql += ` WHERE category = $${params.length}`
        }
        sql += ' ORDER BY category, config_key'
        const result = await pool.query(sql, params)
        return {
          configs: result.rows.map((r) => ({
            config_key: r.config_key,
            config_value: r.config_value, // JSONB 已由 pg 解析为对象/标量
            description: r.description,
            category: r.category,
            updated_at: r.updated_at,
          })),
          total: result.rowCount,
        }
      }

      case 'update_system_config': {
        const { config_key, config_value } = args
        const key = config_key ? String(config_key).trim() : ''
        const CONFIG_WHITELIST = new Set([
          'ai_max_tokens',
          'ai_default_provider',
          'max_collection_depth',
          'enable_audit_log',
          'session_timeout_minutes',
        ])
        if (!CONFIG_WHITELIST.has(key)) {
          return { error: 'CONFIG_KEY_NOT_ALLOWED', code: 'CONFIG_KEY_NOT_ALLOWED', message: `不允许修改配置项：${key}` }
        }
        if (config_value === undefined) return { error: 'CONFIG_VALUE_REQUIRED', code: 'CONFIG_VALUE_REQUIRED' }
        const result = await pool.query(
          `INSERT INTO system_configs (config_key, config_value, updated_by, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
           RETURNING config_key, config_value, description, category, updated_at`,
          [key, JSON.stringify(config_value), userId]
        )
        await logAuditEvent({
          userId,
          action: 'config_change',
          resourceType: 'system_config',
          resourceId: key,
          details: { config_key: key },
        })
        return {
          success: true,
          config: {
            config_key: result.rows[0].config_key,
            config_value: result.rows[0].config_value,
            updated_at: result.rows[0].updated_at,
          },
          note: 'AI 类配置项为默认值语义，不影响各用户已提交的 per-user ai_providers 设置。',
        }
      }

      case 'toggle_feature': {
        const { flag_key, enabled } = args
        const key = flag_key ? String(flag_key).trim() : ''
        if (!key) return { error: 'FLAG_KEY_REQUIRED', code: 'FLAG_KEY_REQUIRED' }
        if (typeof enabled !== 'boolean') return { error: 'INVALID_ENABLED', code: 'INVALID_ENABLED', message: 'enabled 必须是布尔值' }
        const result = await pool.query(
          `INSERT INTO feature_flags (flag_key, enabled, description, updated_at)
           VALUES ($1, $2, NULL, NOW())
           ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
           RETURNING flag_key, enabled, updated_at`,
          [key, enabled]
        )
        await logAuditEvent({
          userId,
          action: 'feature_flag_change',
          resourceType: 'feature_flag',
          resourceId: key,
          details: { flag_key: key, enabled },
        })
        return { success: true, flag_key: key, enabled: result.rows[0].enabled }
      }

      case 'get_audit_logs': {
        const { action, user_id, start_time, end_time, page = 1, page_size = 50 } = args
        const safePage = Math.max(1, parseInt(page, 10) || 1)
        const safeSize = Math.min(Math.max(1, parseInt(page_size, 10) || 50), 100)
        let query = 'SELECT * FROM audit_logs WHERE 1=1'
        const params = []
        let paramCount = 0
        if (user_id) { paramCount++; query += ` AND user_id = $${paramCount}`; params.push(user_id) }
        if (action) { paramCount++; query += ` AND action = $${paramCount}`; params.push(action) }
        if (start_time) { paramCount++; query += ` AND created_at >= $${paramCount}`; params.push(start_time) }
        if (end_time) { paramCount++; query += ` AND created_at <= $${paramCount}`; params.push(end_time) }
        query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`
        params.push(safeSize, (safePage - 1) * safeSize)
        const result = await pool.query(query, params)
        return {
          total: result.rowCount,
          page: safePage,
          page_size: safeSize,
          logs: result.rows,
        }
      }

      case 'list_all_devices': {
        const result = await pool.query(
          `SELECT d.id, d.device_name, d.device_type, d.platform, d.is_online, d.last_seen_at, d.created_at,
                  u.id AS user_id, u.nickname, u.phone
           FROM devices d JOIN users u ON u.id = d.user_id
           ORDER BY d.last_seen_at DESC NULLS LAST`
        )
        return {
          devices: result.rows.map((d) => ({
            id: d.id,
            device_name: d.device_name,
            device_type: d.device_type,
            platform: d.platform,
            is_online: d.is_online,
            last_seen_at: d.last_seen_at,
            created_at: d.created_at,
            user: { id: d.user_id, nickname: d.nickname, phone: maskPhone(d.phone) },
          })),
          total: result.rowCount,
        }
      }

      case 'unpair_device': {
        const { device_id } = args
        if (!device_id) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND', message: 'device_id 必填' }
        const exist = await pool.query('SELECT id FROM devices WHERE id = $1', [device_id])
        if (exist.rows.length === 0) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND' }
        await pool.query('DELETE FROM devices WHERE id = $1', [device_id])
        await logAuditEvent({
          userId,
          action: 'unpair_device',
          resourceType: 'device',
          resourceId: String(device_id),
          details: { device_id },
        })
        return { success: true, device_id }
      }

      case 'upgrade_subscription': {
        const { user_id, plan, duration_months = 1 } = args
        const userId2 = userId // 操作者（审计用）
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const planName = Object.keys(PLAN_RANK).find((p) => p.toLowerCase() === String(plan).toLowerCase())
        if (!planName) return { error: 'INVALID_PLAN', code: 'INVALID_PLAN' }
        const months = Math.min(Math.max(1, parseInt(duration_months, 10) || 1), 12)
        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [user_id])
        if (targetUser.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        const planRes = await pool.query('SELECT id, name FROM subscription_plans WHERE name = $1', [planName])
        if (planRes.rows.length === 0) return { error: 'PLAN_NOT_FOUND', code: 'PLAN_NOT_FOUND' }
        const planId = planRes.rows[0].id
        const existing = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [user_id]
        )
        let sub
        if (existing.rows.length > 0) {
          const up = await pool.query(
            `UPDATE user_subscriptions
             SET plan_id = $1, status = 'active', current_period_start = NOW(),
                 current_period_end = NOW() + ($3 || ' months')::interval, updated_at = NOW()
             WHERE id = $2
             RETURNING id, user_id, plan_id, status, current_period_start, current_period_end`,
            [planId, existing.rows[0].id, months]
          )
          sub = up.rows[0]
        } else {
          const ins = await pool.query(
            `INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle)
             VALUES ($1, $2, 'active', NOW(), NOW() + ($3 || ' months')::interval, NOW(), NOW() + ($3 || ' months')::interval, 'monthly')
             RETURNING id, user_id, plan_id, status, current_period_start, current_period_end`,
            [user_id, planId, months]
          )
          sub = ins.rows[0]
        }
        await pool.query(
          'UPDATE users SET subscription_status = $1, current_subscription_id = $2, updated_at = NOW() WHERE id = $3',
          [planName.toLowerCase(), sub.id, user_id]
        )
        await logAuditEvent({
          userId: userId2,
          action: 'subscription_upgrade',
          resourceType: 'user_subscription',
          resourceId: String(user_id),
          details: { target_user_id: user_id, plan: planName, duration_months: months },
        })
        return {
          success: true,
          user_id,
          plan: planName,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
        }
      }

      case 'downgrade_subscription': {
        const { user_id, plan } = args
        if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
        const planName = Object.keys(PLAN_RANK).find((p) => p.toLowerCase() === String(plan).toLowerCase())
        if (!planName) return { error: 'INVALID_PLAN', code: 'INVALID_PLAN' }
        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [user_id])
        if (targetUser.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        // 读取当前活跃套餐（不存在则为 Free）
        const curRes = await pool.query(
          `SELECT sp.name FROM user_subscriptions us
           JOIN subscription_plans sp ON sp.id = us.plan_id
           WHERE us.user_id = $1 AND us.status = 'active'
           ORDER BY us.created_at DESC LIMIT 1`,
          [user_id]
        )
        const currentPlan = curRes.rows.length > 0 ? curRes.rows[0].name : 'Free'
        if (PLAN_RANK[planName] >= PLAN_RANK[currentPlan]) {
          return {
            error: 'DOWNGRADE_REQUIRED_LOWER',
            code: 'DOWNGRADE_REQUIRED_LOWER',
            message: `目标套餐等级须低于当前套餐（当前 ${currentPlan}），不允许降级到同级或升级。`,
            current_plan: currentPlan,
            target_plan: planName,
          }
        }
        const planRes = await pool.query('SELECT id, name FROM subscription_plans WHERE name = $1', [planName])
        if (planRes.rows.length === 0) return { error: 'PLAN_NOT_FOUND', code: 'PLAN_NOT_FOUND' }
        const planId = planRes.rows[0].id
        const existing = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [user_id]
        )
        let sub
        if (existing.rows.length > 0) {
          const up = await pool.query(
            `UPDATE user_subscriptions
             SET plan_id = $1, status = 'active', current_period_start = NOW(),
                 current_period_end = NOW() + INTERVAL '1 month', updated_at = NOW()
             WHERE id = $2
             RETURNING id, plan_id, status, current_period_start, current_period_end`,
            [planId, existing.rows[0].id]
          )
          sub = up.rows[0]
        } else {
          const ins = await pool.query(
            `INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date, current_period_start, current_period_end, billing_cycle)
             VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 month', NOW(), NOW() + INTERVAL '1 month', 'monthly')
             RETURNING id, plan_id, status, current_period_start, current_period_end`,
            [user_id, planId]
          )
          sub = ins.rows[0]
        }
        await pool.query(
          'UPDATE users SET subscription_status = $1, current_subscription_id = $2, updated_at = NOW() WHERE id = $3',
          [planName.toLowerCase(), sub.id, user_id]
        )
        await logAuditEvent({
          userId,
          action: 'subscription_downgrade',
          resourceType: 'user_subscription',
          resourceId: String(user_id),
          details: { target_user_id: user_id, from_plan: currentPlan, plan: planName },
        })
        return {
          success: true,
          user_id,
          plan: planName,
          from_plan: currentPlan,
          status: sub.status,
        }
      }

      case 'create_sub_collection': {
        const { name, parent_id, icon, description } = args
        if (!name || !String(name).trim()) return { error: 'NAME_REQUIRED', code: 'NAME_REQUIRED' }
        if (!parent_id) return { error: 'PARENT_COLLECTION_NOT_FOUND', code: 'PARENT_COLLECTION_NOT_FOUND' }
        const cleanName = String(name).trim().slice(0, 100)
        const cleanIcon = String(icon || '📁').slice(0, 10)
        const parent = await pool.query(
          'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
          [parent_id, userId]
        )
        if (parent.rows.length === 0) {
          return { error: 'PARENT_COLLECTION_NOT_FOUND', code: 'PARENT_COLLECTION_NOT_FOUND' }
        }
        const maxOrder = await pool.query(
          'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM favorite_collections WHERE user_id = $1',
          [userId]
        )
        // ltree 标签不允许连字符：uuid 去 '-'（对照 favorites.js 同款写法）
        const path = `${parent.rows[0].path}.col_${uuidv4().replace(/-/g, '_')}`
        const result = await pool.query(
          `INSERT INTO favorite_collections (user_id, name, icon, sort_order, path)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, icon, sort_order, path, created_at`,
          [userId, cleanName, cleanIcon, (maxOrder.rows[0].max_order || 0) + 1, path]
        )
        return {
          collection: result.rows[0],
          note: description
            ? 'current 表结构无 description 列，描述仅在本次调用上下文可见（未落库）。'
            : undefined,
        }
      }

      // ============ W1-C 工具域 A（18 个）：收藏夹 / 条目 / 标签 / 剪贴板 / 保护 / 媒体 ============
      case 'delete_collection': {
        // 破坏性工具（已在 DESTRUCTIVE_CONFIRM_NEEDED 登记，经确认门控后进入此处）。
        const { collection_id } = args
        if (!collection_id || !isValidUUID(collection_id)) {
          return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION', message: 'collection_id 必填且为合法 UUID' }
        }
        const target = await pool.query(
          'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
          [collection_id, userId]
        )
        if (target.rows.length === 0) {
          return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND', message: '收藏夹不存在或不属于当前用户' }
        }
        // ltree 级联删除：path <@ 目标（目标 + 所有后代），仅作用于当前用户
        const del = await pool.query(
          'DELETE FROM favorite_collections WHERE path <@ $1 AND user_id = $2',
          [target.rows[0].path, userId]
        )
        return {
          success: true,
          deleted: del.rowCount,
          collection_id,
          note: '已级联删除该收藏夹及其所有子收藏夹（ltree 后代）。剪贴板条目本身未删除。',
        }
      }

      case 'update_collection': {
        const { collection_id, name, icon, sort_order } = args
        if (!collection_id || !isValidUUID(collection_id)) {
          return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
        }
        const fields = []
        const params = []
        let p = 1
        if (name !== undefined) { fields.push(`name = $${p++}`); params.push(String(name).trim().slice(0, 100)) }
        if (icon !== undefined) { fields.push(`icon = $${p++}`); params.push(String(icon).slice(0, 10)) }
        if (sort_order !== undefined) { fields.push(`sort_order = $${p++}`); params.push(Number(sort_order)) }
        if (fields.length === 0) return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'name/icon/sort_order 至少提供一个' }
        fields.push('updated_at = NOW()')
        params.push(collection_id, userId)
        const result = await pool.query(
          `UPDATE favorite_collections SET ${fields.join(', ')} WHERE id = $${p++}::uuid AND user_id = $${p}
           RETURNING id, name, icon, sort_order, created_at, path`,
          params
        )
        if (result.rowCount === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
        return { collection: result.rows[0] }
      }

      case 'move_collection': {
        const { collection_id, parent_id } = args
        if (!collection_id || !isValidUUID(collection_id)) {
          return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
        }
        const src = await pool.query(
          'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
          [collection_id, userId]
        )
        if (src.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
        const srcPath = src.rows[0].path
        let newParentPath = null
        if (parent_id) {
          if (!isValidUUID(parent_id)) return { error: 'INVALID_PARENT', code: 'INVALID_PARENT' }
          const parent = await pool.query(
            'SELECT path FROM favorite_collections WHERE id = $1 AND user_id = $2',
            [parent_id, userId]
          )
          if (parent.rows.length === 0) return { error: 'PARENT_NOT_FOUND', code: 'PARENT_NOT_FOUND' }
          newParentPath = parent.rows[0].path
          // 防循环引用：目标不能是被移动节点自身或其后代
          if (newParentPath === srcPath || newParentPath.startsWith(srcPath + '.')) {
            return { error: 'CIRCULAR_MOVE', code: 'CIRCULAR_MOVE', message: '不能把收藏夹移入自身或其子级（会形成循环引用）' }
          }
        }
        const newLeaf = `col_${uuidv4().replace(/-/g, '_')}`
        const newPath = newParentPath ? `${newParentPath}.${newLeaf}` : `root.${newLeaf}`
        const srcLv = await pool.query('SELECT nlevel($1::ltree) AS n', [srcPath])
        const srcN = srcLv.rows[0].n
        // B4：自身路径与后代路径的两次 UPDATE 必须原子生效——改用专用连接的显式事务，
        // 失败一起回滚，杜绝「父已移动、子树还挂旧前缀」的悬挂态。
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          // 更新自身路径
          await client.query(
            'UPDATE favorite_collections SET path = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
            [newPath, collection_id, userId]
          )
          // 更新所有后代路径：把旧前缀替换为新前缀
          if (srcN > 0) {
            await client.query(
              `UPDATE favorite_collections SET path = $1 || subpath(path, $2), updated_at = NOW()
               WHERE path <@ $3 AND id != $4::uuid AND user_id = $5`,
              [newPath, srcN, srcPath, collection_id, userId]
            )
          }
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
        const updated = await pool.query(
          'SELECT id, name, icon, sort_order, path, created_at FROM favorite_collections WHERE id = $1',
          [collection_id]
        )
        return { collection: updated.rows[0] }
      }

      case 'reorder_collections': {
        const { orders } = args
        if (!Array.isArray(orders) || orders.length === 0) {
          return { error: 'ORDERS_REQUIRED', code: 'ORDERS_REQUIRED', message: 'orders 数组必填' }
        }
        const pairs = orders.filter((o) => o && isValidUUID(o.id) && typeof o.sortOrder === 'number')
        if (pairs.length === 0) return { error: 'NO_VALID_ORDERS', code: 'NO_VALID_ORDERS' }
        const ids = pairs.map((o) => o.id)
        const check = await pool.query(
          'SELECT id FROM favorite_collections WHERE id = ANY($1::uuid[]) AND user_id = $2',
          [ids, userId]
        )
        if (check.rows.length !== ids.length) {
          return { error: 'FOREIGN_COLLECTION', code: 'FOREIGN_COLLECTION', message: '部分收藏夹不属于当前用户' }
        }
        // B4：pool.query('BEGIN') 是伪事务（池化连接下每条语句可能落在不同连接），
        // 改为专用连接上的显式事务，保证批量 reorder 全部生效或全部不生效。
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          for (const o of pairs) {
            await client.query(
              'UPDATE favorite_collections SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
              [o.sortOrder, o.id, userId]
            )
          }
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
        return { success: true, reordered: pairs.length }
      }

      case 'get_collection_items': {
        const { collection_id } = args
        if (!collection_id || !isValidUUID(collection_id)) {
          return { error: 'INVALID_COLLECTION', code: 'INVALID_COLLECTION' }
        }
        const result = await pool.query(
          `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size, ci.metadata, ci.is_favorite,
                  ci.favorited_at, ci.created_at, ci.protection_level,
                  d.device_name, d.platform, fci.sort_order
           FROM favorite_collection_items fci
           JOIN clipboard_items ci ON fci.item_id = ci.id
           LEFT JOIN devices d ON ci.source_device_id = d.id
           WHERE fci.collection_id = $1 AND ci.user_id = $2
             AND COALESCE(ci.protection_level, 'none') = 'none'
           ORDER BY fci.sort_order`,
          [collection_id, userId]
        )
        // 空列表时仍要区分「收藏夹不存在」与「收藏夹为空」
        if (result.rowCount === 0) {
          const col = await pool.query(
            'SELECT id FROM favorite_collections WHERE id = $1 AND user_id = $2',
            [collection_id, userId]
          )
          if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
        }
        return { items: result.rows, count: result.rowCount }
      }

      case 'add_item_to_collection': {
        const { collection_id, item_id } = args
        if (!collection_id || !item_id || !isValidUUID(collection_id) || !isValidUUID(item_id)) {
          return { error: 'INVALID_ID', code: 'INVALID_ID', message: 'collection_id 与 item_id 必填且为合法 UUID' }
        }
        const col = await pool.query(
          'SELECT id FROM favorite_collections WHERE id = $1 AND user_id = $2',
          [collection_id, userId]
        )
        if (col.rows.length === 0) return { error: 'COLLECTION_NOT_FOUND', code: 'COLLECTION_NOT_FOUND' }
        const item = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [item_id, userId]
        )
        if (item.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        // 唯一归属：先从其他收藏夹移除
        await pool.query(
          'DELETE FROM favorite_collection_items WHERE item_id = $1 AND collection_id <> $2',
          [item_id, collection_id]
        )
        const maxOrder = await pool.query(
          'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM favorite_collection_items WHERE collection_id = $1',
          [collection_id]
        )
        await pool.query(
          `INSERT INTO favorite_collection_items (collection_id, item_id, sort_order)
           VALUES ($1, $2, $3) ON CONFLICT (collection_id, item_id) DO NOTHING`,
          [collection_id, item_id, maxOrder.rows[0].next_order]
        )
        return {
          success: true,
          collection_id,
          item_id,
          note: '已加入收藏夹；若条目曾属于其他收藏夹，已自动解除旧归属（唯一归属）。',
        }
      }

      case 'remove_item_from_collection': {
        const { collection_id, item_id } = args
        if (!collection_id || !item_id || !isValidUUID(collection_id) || !isValidUUID(item_id)) {
          return { error: 'INVALID_ID', code: 'INVALID_ID' }
        }
        const result = await pool.query(
          `DELETE FROM favorite_collection_items
           WHERE collection_id = $1 AND item_id = $2
             AND collection_id IN (SELECT id FROM favorite_collections WHERE user_id = $3)`,
          [collection_id, item_id, userId]
        )
        return {
          success: true,
          removed: result.rowCount > 0,
          collection_id,
          item_id,
          note: '仅解除收藏夹关联，未删除剪贴板条目本身。',
        }
      }

      case 'update_collection_tags': {
        const { clip_id, tags } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        if (!Array.isArray(tags)) return { error: 'TAGS_REQUIRED', code: 'TAGS_REQUIRED', message: 'tags 必须是数组' }
        const cleanTags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        const current = await pool.query(
          'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [clip_id, userId]
        )
        if (current.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        // 全量替换 metadata.tags
        await pool.query(
          `UPDATE clipboard_items
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tags}', $1::jsonb), updated_at = NOW()
           WHERE id = $2 AND user_id = $3`,
          [JSON.stringify(cleanTags), clip_id, userId]
        )
        return { success: true, clip_id, tags: cleanTags, note: '已全量替换该条目的标签列表。' }
      }

      case 'delete_tag': {
        const { tag } = args
        if (!tag || !String(tag).trim()) return { error: 'TAG_REQUIRED', code: 'TAG_REQUIRED' }
        const cleanTag = String(tag).trim().slice(0, 30)
        // 从所有收藏项级联移除该标签
        const result = await pool.query(
          `UPDATE clipboard_items
           SET metadata = jsonb_set(metadata, '{tags}', (metadata->'tags') - $2), updated_at = NOW()
           WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' ? $2`,
          [userId, cleanTag]
        )
        return { success: true, deleted: result.rowCount, tag: cleanTag, note: '已从所有收藏项中级联移除该标签。' }
      }

      case 'update_clip': {
        const { clip_id, content, contentPreview, expiresAt, archived, metadata } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        const setClauses = []
        const params = [clip_id, userId]
        let p = 3
        let changed = false
        if (content !== undefined) {
          if (typeof content !== 'string') return { error: 'INVALID_CONTENT', code: 'INVALID_CONTENT' }
          setClauses.push(`content_encrypted = $${p++}`); params.push(encrypt(String(content)))
          setClauses.push(`content_size = $${p++}`); params.push(Buffer.byteLength(String(content)))
          changed = true
        }
        if (contentPreview !== undefined) {
          if (typeof contentPreview !== 'string') return { error: 'INVALID_PREVIEW', code: 'INVALID_PREVIEW' }
          setClauses.push(`content_preview = $${p++}`); params.push(contentPreview.slice(0, 5000))
          changed = true
        }
        if (expiresAt !== undefined) {
          let v = null
          if (expiresAt !== null) {
            const d = new Date(expiresAt)
            if (isNaN(d.getTime())) return { error: 'INVALID_EXPIRE', code: 'INVALID_EXPIRE', message: 'expiresAt 必须是合法 ISO 日期或 null' }
            v = d.toISOString()
          }
          setClauses.push(`expires_at = $${p++}`); params.push(v)
          changed = true
        }
        if (archived !== undefined) {
          if (typeof archived !== 'boolean') return { error: 'INVALID_ARCHIVED', code: 'INVALID_ARCHIVED' }
          setClauses.push(`archived = $${p++}`); params.push(archived)
          changed = true
        }
        if (metadata !== undefined) {
          if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
            return { error: 'INVALID_METADATA', code: 'INVALID_METADATA', message: 'metadata 必须是对象' }
          }
          // 白名单键浅合并（与 PUT /clipboard/:id 一致）
          const metaPatch = {}
          for (const k of ['protected', 'protectedAt', 'tags']) {
            if (k in metadata) metaPatch[k] = metadata[k]
          }
          if ('protected' in metaPatch && typeof metaPatch.protected !== 'boolean') return { error: 'INVALID_PROTECTED', code: 'INVALID_PROTECTED' }
          if ('tags' in metaPatch && !Array.isArray(metaPatch.tags)) return { error: 'INVALID_TAGS', code: 'INVALID_TAGS' }
          setClauses.push(`metadata = metadata || $${p++}::jsonb`); params.push(JSON.stringify(metaPatch))
          changed = true
        }
        if (!changed) return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: '至少提供一个要更新的字段' }
        setClauses.push('updated_at = NOW()')
        const result = await pool.query(
          `UPDATE clipboard_items SET ${setClauses.join(', ')}
           WHERE id = $1 AND user_id = $2
           RETURNING id, content_type, content_preview, content_size, metadata, is_favorite, archived, expires_at, created_at`,
          params
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return { updated: result.rows[0] }
      }

      case 'mark_sensitive': {
        const { clip_id, sensitive } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        if (typeof sensitive !== 'boolean') return { error: 'INVALID_SENSITIVE', code: 'INVALID_SENSITIVE', message: 'sensitive 必须是布尔值' }
        const result = await pool.query(
          `UPDATE clipboard_items SET metadata = jsonb_set(metadata, '{sensitive}', $1::jsonb), updated_at = NOW()
           WHERE id = $2 AND user_id = $3 RETURNING id, metadata`,
          [JSON.stringify(sensitive), clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return {
          success: true,
          clip_id,
          sensitive,
          note: '已更新「敏感内容」标记；这是主观内容标记，不影响加密/能见度。若要设置密码保护请用 set_item_protection。',
        }
      }

      case 'mark_clip_used': {
        const { clip_id } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        const result = await pool.query(
          `UPDATE clipboard_items SET usage_count = COALESCE(usage_count, 0) + 1, last_used_at = NOW()
           WHERE id = $1 AND user_id = $2 RETURNING usage_count`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return { success: true, clip_id, usageCount: result.rows[0].usage_count }
      }

      case 'get_frequent_clips': {
        const { limit = 3 } = args
        const safeLimit = Math.min(Math.max(1, Number(limit) || 3), 10)
        // 与 GET /api/clipboard/frequent 语义一致：防守 + 衰减时间加权，跳过一次未用
        const result = await pool.query(
          `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size, ci.created_at, ci.usage_count, ci.last_used_at,
                  (ci.usage_count * 1.0) * exp(-extract(epoch from now() - coalesce(ci.last_used_at, ci.created_at)) / 2592000.0) AS score
           FROM clipboard_items ci
           WHERE ci.user_id = $1 AND ci.archived = FALSE AND ci.usage_count > 0
           ORDER BY score DESC, ci.last_used_at DESC NULLS LAST
           LIMIT $2`,
          [userId, safeLimit]
        )
        return {
          items: result.rows.map((r) => ({
            id: r.id,
            contentType: r.content_type,
            contentPreview: r.content_preview,
            contentSize: r.content_size,
            createdAt: r.created_at,
            usageCount: r.usage_count,
            lastUsedAt: r.last_used_at,
          })),
          count: result.rowCount,
        }
      }

      case 'set_item_protection': {
        const { item_id, level, password, content } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        if (!['pin', 'advanced'].includes(level)) return { error: 'INVALID_LEVEL', code: 'INVALID_LEVEL', message: 'level 仅支持 pin / advanced' }
        const chk = await pool.query(
          'SELECT id, content_type FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [item_id, userId]
        )
        if (chk.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        if (level === 'pin') {
          await pool.query(
            `UPDATE clipboard_items SET protection_level = 'pin', updated_at = NOW() WHERE id = $1 AND user_id = $2`,
            [item_id, userId]
          )
          return { success: true, level: 'pin', note: '已设置 PIN 保护（仅控制客户端展示，不影响服务端可解密性）。' }
        }
        // advanced：高级密码保护（复用 protection.js 的 setupAdvancedProtection）
        if (!password || String(password).length < 4) {
          return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: 'advanced 保护需要 ≥4 位的密码' }
        }
        if (typeof content !== 'string' || !content) {
          return { error: 'CONTENT_REQUIRED', code: 'CONTENT_REQUIRED', message: 'advanced 保护需要提供被保护内容的明文 content' }
        }
        const data = setupAdvancedProtection(content, String(password))
        // B2：advanced 保护条目同步清空明文预览与 OCR 文本（与 protection.js /setup 同款），
        // 防止 search/list/AI 工具从 content_preview / ocr_text 读到受保护原文。
        await pool.query(
          `UPDATE clipboard_items
           SET protection_level = 'advanced', content_encrypted = $1, wrapped_dek_password = $2,
               wrapped_dek_recovery = $3, protection_salt = $4, protection_iv = $5,
               content_preview = '', ocr_text = NULL, updated_at = NOW()
           WHERE id = $6 AND user_id = $7`,
          [data.encryptedContent, data.wrappedDEKPassword, data.wrappedDEKRecovery, data.salt, data.iv, item_id, userId]
        )
        await pool.query(
          `INSERT INTO recovery_keys (user_id, item_id, recovery_key_hash) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, item_id) DO UPDATE SET recovery_key_hash = EXCLUDED.recovery_key_hash`,
          [userId, item_id, data.recoveryKeyHash]
        )
        return {
          success: true,
          level: 'advanced',
          recoveryKey: data.recoveryKey,
          note: '已设置高级密码保护。请务必保存返回的 recoveryKey（仅此一次出现）。',
        }
      }

      case 'remove_item_protection': {
        const { item_id, password } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        const item = await pool.query(
          `SELECT id, content_encrypted, protection_level, wrapped_dek_password, protection_salt
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [item_id, userId]
        )
        if (item.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        const it = item.rows[0]
        if (it.protection_level === 'none') return { error: 'NOT_PROTECTED', code: 'NOT_PROTECTED', message: '该条目未受保护' }
        // advanced 条目：若提供密码则先验证明文（复用 protection.js 逻辑），不移除则仍可解除保护
        if (it.protection_level === 'advanced' && password) {
          const plain = unlockWithPassword(it.content_encrypted, it.wrapped_dek_password, String(password), it.protection_salt)
          if (!plain) return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: '密码不正确，无法校验高级保护' }
        }
        await pool.query(
          `UPDATE clipboard_items
           SET protection_level = 'none', wrapped_dek_password = NULL, wrapped_dek_recovery = NULL,
               protection_salt = NULL, protection_iv = NULL, updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [item_id, userId]
        )
        await pool.query('DELETE FROM recovery_keys WHERE user_id = $1 AND item_id = $2', [userId, item_id])
        return { success: true, item_id, note: '已移除该条目的密码保护。' }
      }

      case 'get_protection_status': {
        const { item_id } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        const result = await pool.query(
          'SELECT protection_level FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [item_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        const rec = await pool.query(
          'SELECT id FROM recovery_keys WHERE user_id = $1 AND item_id = $2',
          [userId, item_id]
        )
        return { item_id, level: result.rows[0].protection_level || 'none', hasRecoveryKey: rec.rows.length > 0 }
      }

      case 'upload_image': {
        // base64 输入写盘，复用 storage 目录（uploads/images）与 uuid 命名
        const { base64, mime_type, filename, expires_at } = args
        if (typeof base64 !== 'string' || !base64) return { error: 'BASE64_REQUIRED', code: 'BASE64_REQUIRED' }
        const buf = Buffer.from(base64, 'base64')
        if (buf.length === 0) return { error: 'INVALID_BASE64', code: 'INVALID_BASE64' }
        if (buf.length > 15 * 1024 * 1024) return { error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE', message: '图片大小上限约 15MB' }
        const mime = String(mime_type || 'image/jpeg').toLowerCase()
        const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.jpg'
        const filenameUuid = `${uuidv4()}${ext}`
        const finalPath = path.join(IMAGE_DIR, filenameUuid)
        await fs.mkdir(IMAGE_DIR, { recursive: true })
        await fs.writeFile(finalPath, buf)
        const originalName = (typeof filename === 'string' && filename) ? filename.slice(0, 255) : `image_${filenameUuid}`
        const exp = (typeof expires_at === 'string' && expires_at) ? new Date(expires_at).toISOString() : null
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
           VALUES ($1, NULL, 'image', $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [
            userId, filenameUuid, originalName, buf.length,
            JSON.stringify({ originalName, mimeType: mime, originalSize: buf.length, compressedSize: buf.length, width: null, height: null }),
            exp,
          ]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          filename: filenameUuid,
          originalName,
          sizeBytes: r.content_size,
          createdAt: r.created_at,
          note: '图片已写盘存储于服务端 images 目录。',
        }
      }

      case 'upload_file': {
        const { base64, mime_type, filename, expires_at } = args
        if (typeof base64 !== 'string' || !base64) return { error: 'BASE64_REQUIRED', code: 'BASE64_REQUIRED' }
        const buf = Buffer.from(base64, 'base64')
        if (buf.length === 0) return { error: 'INVALID_BASE64', code: 'INVALID_BASE64' }
        if (buf.length > 15 * 1024 * 1024) return { error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE', message: '文件大小上限约 15MB' }
        // B6：白名单制——扩展名必须在名单内，且不再从 mime 子类型反推扩展名；
        // 声明的 mime_type 与扩展名不同类时拒绝。
        let ext = ''
        if (typeof filename === 'string' && filename) ext = path.extname(filename).toLowerCase()
        const allowedMimes = UPLOAD_FILE_ALLOWED_EXT.get(ext)
        if (!ext || !allowedMimes) {
          return {
            error: 'EXTENSION_NOT_ALLOWED',
            code: 'EXTENSION_NOT_ALLOWED',
            message: `仅允许常用文本/图片/办公文档类型上传，不支持该扩展名：${ext || '(无)'}`,
          }
        }
        const declaredMime = typeof mime_type === 'string' ? mime_type.toLowerCase().trim() : ''
        if (declaredMime) {
          // ['text/'] 形式按前缀匹配家族，精确项按全等匹配
          const matched = allowedMimes.some((m) => (m.endsWith('/') ? declaredMime.startsWith(m) : declaredMime === m))
          if (!matched) {
            return {
              error: 'MIME_MISMATCH',
              code: 'MIME_MISMATCH',
              message: `声明的 MIME 类型（${declaredMime}）与扩展名 ${ext} 不匹配`,
            }
          }
        }
        const filenameUuid = `${uuidv4()}${ext}`
        const finalPath = path.join(FILE_DIR, filenameUuid)
        await fs.mkdir(FILE_DIR, { recursive: true })
        await fs.writeFile(finalPath, buf)
        const originalName = (typeof filename === 'string' && filename) ? filename.slice(0, 255) : `file_${filenameUuid}`
        const exp = (typeof expires_at === 'string' && expires_at) ? new Date(expires_at).toISOString() : null
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
           VALUES ($1, NULL, 'file', $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [
            userId, filenameUuid, originalName, buf.length,
            JSON.stringify({ originalName, mimeType: mime_type || 'application/octet-stream', extension: ext }),
            exp,
          ]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          filename: filenameUuid,
          originalName,
          sizeBytes: r.content_size,
          createdAt: r.created_at,
          note: '文件已写盘存储于服务端 files 目录。',
        }
      }

      // ============ W2-D 工具域 B：模板 / 共享链接 / 设备 / 通知 / 会话 / 版本 / 工作流 / 模板变量 / 账号 / 订阅 / 调查 / 运维 ============
      case 'delete_template': {
        const { template_id } = args
        if (!template_id || !isValidUUID(template_id)) {
          return { error: 'INVALID_TEMPLATE', code: 'INVALID_TEMPLATE', message: 'template_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM clipboard_templates WHERE user_id = $1 AND id = $2::uuid RETURNING id',
          [userId, template_id]
        )
        if (del.rowCount === 0) return { error: 'TEMPLATE_NOT_FOUND', code: 'TEMPLATE_NOT_FOUND' }
        return { success: true, template_id, note: '模板已删除。' }
      }

      case 'delete_shared_link': {
        const { shared_link_id } = args
        if (!shared_link_id || !isValidUUID(shared_link_id)) {
          return { error: 'INVALID_SHARED_LINK', code: 'INVALID_SHARED_LINK', message: 'shared_link_id 必填且为合法 UUID' }
        }
        const found = await pool.query(
          'SELECT file_path FROM shared_links WHERE id = $1 AND user_id = $2',
          [shared_link_id, userId]
        )
        if (found.rows.length === 0) return { error: 'SHARED_LINK_NOT_FOUND', code: 'SHARED_LINK_NOT_FOUND' }
        for (const r of found.rows) {
          if (r.file_path) {
            try { await fs.rm(path.dirname(r.file_path), { recursive: true, force: true }) } catch { /* 忽略文件删除失败 */ }
          }
        }
        await pool.query('DELETE FROM shared_links WHERE id = $1 AND user_id = $2', [shared_link_id, userId])
        return { success: true, shared_link_id, note: '共享链接已删除，关联共享文件已一并移除。' }
      }

      case 'get_workflow_rules': {
        const result = await pool.query(
          `SELECT id, name, enabled, content_type, match_mode, keywords, action_type,
                  action_value, action_apply_tags, priority, created_at, updated_at
           FROM workflow_rules
           WHERE user_id = $1
           ORDER BY enabled DESC, priority DESC, created_at DESC`,
          [userId]
        )
        return { rules: result.rows, count: result.rowCount }
      }

      case 'create_workflow_rule': {
        const VALID_TYPES = ['text', 'image', 'file', 'link', 'code']
        const VALID_MODES = ['keyword', 'regex']
        const VALID_ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']
        const name = String(args.name || '').trim().slice(0, 100)
        if (!name) return { error: 'RULE_NAME_REQUIRED', code: 'RULE_NAME_REQUIRED', message: 'name 必填' }
        const content_type = VALID_TYPES.includes(args.contentType) ? args.contentType : 'text'
        const match_mode = VALID_MODES.includes(args.matchMode) ? args.matchMode : 'keyword'
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 100)).slice(0, 20)
          : []
        if (keywords.length === 0) {
          return { error: 'KEYWORDS_REQUIRED', code: 'KEYWORDS_REQUIRED', message: '至少需要一个关键词/正则' }
        }
        const action_type = VALID_ACTIONS.includes(args.actionType) ? args.actionType : 'favorite'
        const action_value = typeof args.actionValue === 'string' ? args.actionValue.trim().slice(0, 100) : null
        const action_apply_tags = Array.isArray(args.actionApplyTags)
          ? args.actionApplyTags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 10)
          : null
        const priority = Number.isFinite(Number(args.priority)) ? Math.min(1000, Math.max(0, Number(args.priority))) : 100
        const enabled = args.enabled !== false
        if (action_type === 'tag' && !action_value && (!action_apply_tags || action_apply_tags.length === 0)) {
          return { error: 'TAG_ACTION_REQUIRES_VALUE', code: 'TAG_ACTION_REQUIRES_VALUE', message: 'tag 动作需要 actionValue 或 actionApplyTags' }
        }
        const result = await pool.query(
          `INSERT INTO workflow_rules
             (user_id, name, enabled, content_type, match_mode, keywords, action_type, action_value, action_apply_tags, priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, created_at`,
          [userId, name, enabled, content_type, match_mode, JSON.stringify(keywords), action_type, action_value, action_apply_tags ? JSON.stringify(action_apply_tags) : null, priority]
        )
        return { success: true, rule_id: result.rows[0].id, note: '工作流规则已创建。' }
      }

      case 'update_workflow_rule': {
        const { rule_id } = args
        if (!rule_id || !isValidUUID(rule_id)) {
          return { error: 'INVALID_RULE', code: 'INVALID_RULE', message: 'rule_id 必填且为合法 UUID' }
        }
        const VALID_TYPES = ['text', 'image', 'file', 'link', 'code']
        const VALID_MODES = ['keyword', 'regex']
        const VALID_ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']
        const name = String(args.name || '').trim().slice(0, 100)
        if (!name) return { error: 'RULE_NAME_REQUIRED', code: 'RULE_NAME_REQUIRED', message: 'name 必填' }
        const content_type = VALID_TYPES.includes(args.contentType) ? args.contentType : 'text'
        const match_mode = VALID_MODES.includes(args.matchMode) ? args.matchMode : 'keyword'
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 100)).slice(0, 20)
          : []
        if (keywords.length === 0) {
          return { error: 'KEYWORDS_REQUIRED', code: 'KEYWORDS_REQUIRED', message: '至少需要一个关键词/正则' }
        }
        const action_type = VALID_ACTIONS.includes(args.actionType) ? args.actionType : 'favorite'
        const action_value = typeof args.actionValue === 'string' ? args.actionValue.trim().slice(0, 100) : null
        const action_apply_tags = Array.isArray(args.actionApplyTags)
          ? args.actionApplyTags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 10)
          : null
        const priority = Number.isFinite(Number(args.priority)) ? Math.min(1000, Math.max(0, Number(args.priority))) : 100
        const enabled = args.enabled !== false
        if (action_type === 'tag' && !action_value && (!action_apply_tags || action_apply_tags.length === 0)) {
          return { error: 'TAG_ACTION_REQUIRES_VALUE', code: 'TAG_ACTION_REQUIRES_VALUE', message: 'tag 动作需要 actionValue 或 actionApplyTags' }
        }
        const result = await pool.query(
          `UPDATE workflow_rules SET
             name=$1, enabled=$2, content_type=$3, match_mode=$4, keywords=$5,
             action_type=$6, action_value=$7, action_apply_tags=$8, priority=$9, updated_at=NOW()
           WHERE id=$10 AND user_id=$11
           RETURNING id`,
          [name, enabled, content_type, match_mode, JSON.stringify(keywords), action_type, action_value, action_apply_tags ? JSON.stringify(action_apply_tags) : null, priority, rule_id, userId]
        )
        if (result.rowCount === 0) return { error: 'RULE_NOT_FOUND', code: 'RULE_NOT_FOUND' }
        return { success: true, rule_id, note: '工作流规则已更新。' }
      }

      case 'delete_workflow_rule': {
        const { rule_id } = args
        if (!rule_id || !isValidUUID(rule_id)) {
          return { error: 'INVALID_RULE', code: 'INVALID_RULE', message: 'rule_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM workflow_rules WHERE id = $1 AND user_id = $2 RETURNING id',
          [rule_id, userId]
        )
        if (del.rowCount === 0) return { error: 'RULE_NOT_FOUND', code: 'RULE_NOT_FOUND' }
        return { success: true, rule_id, note: '工作流规则已删除。' }
      }

      case 'get_notification_preferences': {
        const result = await pool.query(
          'SELECT id, notification_type, enabled, created_at, updated_at FROM notification_preferences WHERE user_id = $1 ORDER BY notification_type',
          [userId]
        )
        return { preferences: result.rows, count: result.rowCount }
      }

      case 'update_notification_preferences': {
        const { notification_type, enabled } = args
        if (typeof notification_type !== 'string' || !notification_type.trim()) {
          return { error: 'NOTIFICATION_TYPE_REQUIRED', code: 'NOTIFICATION_TYPE_REQUIRED' }
        }
        if (typeof enabled !== 'boolean') {
          return { error: 'ENABLED_REQUIRED', code: 'ENABLED_REQUIRED', message: 'enabled 必填布尔值' }
        }
        const type = notification_type.trim().slice(0, 50)
        const result = await pool.query(
          `INSERT INTO notification_preferences (user_id, notification_type, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, notification_type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
           RETURNING id, notification_type, enabled, created_at, updated_at`,
          [userId, type, enabled]
        )
        return { preference: result.rows[0] }
      }

      case 'mark_notification_read': {
        const { notification_id } = args
        if (!notification_id) return { error: 'NOTIFICATION_ID_REQUIRED', code: 'NOTIFICATION_ID_REQUIRED' }
        const result = await pool.query(
          'UPDATE notification_history SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id, notification_type, title, status, read_at',
          [notification_id, userId]
        )
        if (result.rowCount === 0) return { error: 'NOTIFICATION_NOT_FOUND', code: 'NOTIFICATION_NOT_FOUND' }
        return { success: true, notification: result.rows[0] }
      }

      case 'update_device': {
        const { device_id, device_name, platform_version, app_version } = args
        if (!device_id || !isValidUUID(device_id)) {
          return { error: 'INVALID_DEVICE', code: 'INVALID_DEVICE', message: 'device_id 必填且为合法 UUID' }
        }
        if (device_name === undefined && platform_version === undefined && app_version === undefined) {
          return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'device_name / platform_version / app_version 至少提供一个' }
        }
        const cleanName = typeof device_name === 'string' && device_name.trim() ? device_name.trim().slice(0, 100) : null
        const cleanPv = typeof platform_version === 'string' && platform_version.trim() ? platform_version.trim().slice(0, 50) : null
        const cleanAv = typeof app_version === 'string' && app_version.trim() ? app_version.trim().slice(0, 20) : null
        const result = await pool.query(
          `UPDATE devices SET
             device_name = COALESCE($1, device_name),
             platform_version = COALESCE($2, platform_version),
             app_version = COALESCE($3, app_version),
             last_seen_at = NOW()
           WHERE id = $4 AND user_id = $5
           RETURNING id, device_name, device_type, platform, platform_version, app_version, is_online, created_at`,
          [cleanName, cleanPv, cleanAv, device_id, userId]
        )
        if (result.rowCount === 0) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND' }
        return { device: result.rows[0] }
      }

      case 'unpair_own_device': {
        // 破坏性工具（已在 DESTRUCTIVE_CONFIRM_NEEDED 登记，经确认门控后进入此处）。仅自己设备可用。
        const { device_id } = args
        if (!device_id || !isValidUUID(device_id)) {
          return { error: 'INVALID_DEVICE', code: 'INVALID_DEVICE', message: 'device_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id',
          [device_id, userId]
        )
        if (del.rowCount === 0) {
          return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND', message: '未找到该设备或它不属于当前用户' }
        }
        return { success: true, device_id, note: '设备已解绑。' }
      }

      case 'list_my_sessions': {
        const { current_session_id } = args
        const result = await pool.query(
          `SELECT id, device_name, device_type, platform, ip_address, created_at
           FROM user_sessions
           WHERE user_id = $1 AND is_active = true
           ORDER BY created_at DESC`,
          [userId]
        )
        const currentId = (typeof current_session_id === 'string' && current_session_id) ? current_session_id : null
        return {
          sessions: result.rows.map((r) => ({
            id: r.id,
            deviceName: r.device_name || '未知设备',
            platform: r.device_type || r.platform || 'unknown',
            createdAt: r.created_at,
            isCurrent: currentId ? String(r.id) === String(currentId) : false,
          })),
          count: result.rowCount,
        }
      }

      case 'terminate_session': {
        // 破坏性工具（确认门控）。sessions 端点 DELETE /:sessionId 未内置「当前会话」保护，故在工具内校验。
        const { session_id, current_session_id } = args
        if (!session_id || !isValidUUID(session_id)) {
          return { error: 'INVALID_SESSION', code: 'INVALID_SESSION', message: 'session_id 必填且为合法 UUID' }
        }
        // 不能踢掉当前会话：若指定了 current_session_id 且与目标相同 → 拒绝
        if (current_session_id && String(current_session_id) === String(session_id)) {
          return { error: 'CANNOT_TERMINATE_CURRENT_SESSION', code: 'CANNOT_TERMINATE_CURRENT_SESSION', message: '不能终止当前正在使用的会话（把自己踢下线）' }
        }
        const check = await pool.query(
          'SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND is_active = true',
          [session_id, userId]
        )
        if (check.rows.length === 0) return { error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND' }
        await pool.query(
          'UPDATE user_sessions SET is_active = FALSE, updated_at = NOW(), revoked_at = NOW() WHERE id = $1 AND user_id = $2',
          [session_id, userId]
        )
        const ttl = parseDurationToSeconds(config.jwt.expiresIn)
        await blacklistJti(session_id, ttl)
        return { success: true, session_id, note: '会话已强制下线，对应登录态已失效。' }
      }

      case 'get_version_history': {
        const { clipboard_item_id, page = 1, limit = 20 } = args
        if (!clipboard_item_id || !isValidUUID(clipboard_item_id)) {
          return { error: 'INVALID_CLIP', code: 'INVALID_CLIPBOARD_ITEM', message: 'clipboard_item_id 必填且为合法 UUID' }
        }
        const pg = Math.max(1, parseInt(page, 10) || 1)
        const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20))
        return await getVersionHistory(clipboard_item_id, userId, { page: pg, limit: lim })
      }

      case 'restore_version': {
        // 破坏性工具（确认门控）。
        const { version_id } = args
        if (!version_id || !isValidUUID(version_id)) {
          return { error: 'INVALID_VERSION', code: 'INVALID_VERSION', message: 'version_id 必填且为合法 UUID' }
        }
        try {
          const result = await restoreVersion(version_id, userId)
          return {
            success: true,
            itemId: result.item.id,
            restoredFromVersion: result.restoredFromVersion,
            newVersionNumber: result.newVersionNumber,
            note: '已恢复到指定历史版本，并生成新的版本记录。',
          }
        } catch (err) {
          if (err.message === 'Version not found') return { error: 'VERSION_NOT_FOUND', code: 'VERSION_NOT_FOUND' }
          if (err.message === 'Clipboard item not found') return { error: 'CLIP_ITEM_NOT_FOUND', code: 'CLIP_ITEM_NOT_FOUND' }
          throw err
        }
      }

      case 'upsert_template_variables': {
        const { name, value } = args
        if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          return { error: 'INVALID_VARIABLE_NAME', code: 'INVALID_VARIABLE_NAME', message: '变量名必须是合法标识符（字母/下划线开头）' }
        }
        const safeName = name.slice(0, 60)
        const safeValue = typeof value === 'string' ? value.slice(0, 10000) : ''
        const result = await pool.query(
          `INSERT INTO template_variables (user_id, name, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
           RETURNING id, name, value, created_at, updated_at`,
          [userId, safeName, safeValue]
        )
        return { variable: result.rows[0] }
      }

      case 'delete_template_variable': {
        const { name } = args
        if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          return { error: 'INVALID_VARIABLE_NAME', code: 'INVALID_VARIABLE_NAME' }
        }
        const del = await pool.query(
          'DELETE FROM template_variables WHERE user_id = $1 AND name = $2',
          [userId, name]
        )
        if (del.rowCount === 0) return { error: 'VARIABLE_NOT_FOUND', code: 'VARIABLE_NOT_FOUND' }
        return { success: true, name, note: '模板变量已删除。' }
      }

      case 'get_profile': {
        const result = await pool.query(
          'SELECT id, phone, email, nickname, avatar_url, created_at, subscription_status FROM users WHERE id = $1',
          [userId]
        )
        if (result.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
        const u = result.rows[0]
        return {
          id: u.id,
          phone: u.phone,
          email: u.email,
          nickname: u.nickname,
          avatarUrl: u.avatar_url,
          createdAt: u.created_at,
          subscriptionStatus: u.subscription_status,
        }
      }

      case 'update_profile': {
        const { nickname, avatar_url } = args
        const updates = []
        const params = []
        let p = 1
        if (nickname !== undefined) { updates.push(`nickname = $${p++}`); params.push(String(nickname).trim().slice(0, 50)) }
        if (avatar_url !== undefined) { updates.push(`avatar_url = $${p++}`); params.push(String(avatar_url).trim().slice(0, 500)) }
        if (updates.length === 0) {
          return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'nickname / avatar_url 至少提供一个' }
        }
        updates.push('updated_at = NOW()')
        params.push(userId)
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${p}`, params)
        return { success: true, note: '账号资料已更新。' }
      }

      case 'get_subscription_plans': {
        const result = await pool.query(
          'SELECT id, name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features FROM subscription_plans WHERE is_active = true ORDER BY price_monthly ASC'
        )
        return {
          plans: result.rows.map((plan) => ({
            id: plan.id,
            name: plan.name,
            displayName: plan.display_name,
            priceMonthly: parseFloat(plan.price_monthly || 0),
            priceYearly: parseFloat(plan.price_yearly || 0),
            maxDevices: plan.max_devices,
            maxClipboardItems: plan.max_clipboard_items,
            maxFileSizeMb: plan.max_file_size_mb,
            maxStorageMb: plan.max_storage_mb,
            features: plan.features,
          })),
          count: result.rowCount,
        }
      }

      case 'cancel_subscription': {
        // 仅取消自动续费（cancel_at_period_end），当期结束前仍可用，无外部支付通道依赖
        const sub = await pool.query(
          'SELECT id, current_period_end FROM user_subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
          [userId, 'active']
        )
        if (sub.rows.length === 0) return { error: 'NO_ACTIVE_SUBSCRIPTION', code: 'NO_ACTIVE_SUBSCRIPTION', message: '没有活跃订阅可取消' }
        await pool.query(
          'UPDATE user_subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1',
          [sub.rows[0].id]
        )
        return { success: true, current_period_end: sub.rows[0].current_period_end, note: '已取消自动续费，订阅在当前计费周期结束前仍可用，不退款。' }
      }

      case 'resume_subscription': {
        const sub = await pool.query(
          'SELECT id FROM user_subscriptions WHERE user_id = $1 AND status = $2 AND cancel_at_period_end = true ORDER BY created_at DESC LIMIT 1',
          [userId, 'active']
        )
        if (sub.rows.length === 0) {
          return { error: 'NO_CANCELLABLE_SUBSCRIPTION', code: 'NO_CANCELLABLE_SUBSCRIPTION', message: '没有可恢复的已取消订阅' }
        }
        await pool.query(
          'UPDATE user_subscriptions SET cancel_at_period_end = false, updated_at = NOW() WHERE id = $1',
          [sub.rows[0].id]
        )
        return { success: true, subscription_id: sub.rows[0].id, note: '订阅已恢复自动续费。' }
      }

      case 'submit_survey': {
        const { type, score, feedback } = args
        if (typeof type !== 'string' || !type.trim()) return { error: 'TYPE_REQUIRED', code: 'TYPE_REQUIRED' }
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) {
          return { error: 'INVALID_SCORE', code: 'INVALID_SCORE', message: 'score 必须为 0-10 的整数' }
        }
        const safeType = type.trim().slice(0, 20) || 'nps'
        const safeFeedback = typeof feedback === 'string' ? feedback.slice(0, 2000) : null
        const result = await pool.query(
          'INSERT INTO surveys (user_id, type, score, feedback, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, type, score, feedback, created_at',
          [userId, safeType, score, safeFeedback]
        )
        return { success: true, survey: result.rows[0] }
      }

      case 'get_slow_queries': {
        // L3 超管运维：levels.L3 登记 + executeToolInner 顶部 assertToolAllowed 已硬性拦截低角色
        const { limit = 20, min_time = 1000 } = args
        const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
        const minT = Math.max(0, parseInt(min_time, 10) || 1000)
        const [slowQueries, poolStatus] = await Promise.all([getSlowQueries(lim, minT), getPoolStatus()])
        return { slowQueries, poolStatus, limit: lim, minTimeMs: minT }
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
    if (toolName === 'ask_user') {
      // 交互式提问门控：下发 SSE 卡片并在当前流内阻塞等待前端用户作答
      const gate = await runAskUserGate(toolName, args, userId, role, requestId, opts)
      confirmRequestId = gate.requestId || requestId
      result = {
        // 超时/断流必须显式标注，status:'completed' 会误导模型把超时当作用户已作答
        status: gate.timeout ? 'timeout' : gate.cancelled ? 'cancelled' : 'completed',
        user_response: gate.user_response || '用户已在界面卡片做出选择',
        questions: args.questions || [{ question: args.question, options: args.options }],
      }
    } else {
      // B8：数组参数上限在确认门控之前校验——超限直接返回参数错误，
      // 不进入等待态（否则 archive_items 201 条会先挂进确认流程才暴露错误）。
      const limitErr = clipIdsLimitError(args?.clip_ids)
      if (limitErr) {
        result = limitErr
      } else {
        // 确认门控：
        //   1) DESTRUCTIVE_CONFIRM_NEEDED 集合内的工具（如 destroy_clips）
        //   2) archive_items / unarchive_items 操作多条（>1）时，需用户确认
        const needsConfirm = DESTRUCTIVE_CONFIRM_NEEDED.has(toolName)
          || ((toolName === 'archive_items' || toolName === 'unarchive_items')
              && Array.isArray(args?.clip_ids) && args.clip_ids.length > 1)
        if (needsConfirm) {
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
      }
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

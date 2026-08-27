// ============ aiTools 分域拆分：共享辅助（shared） ============
// 承载跨 9 个业务域复用的常量、纯辅助函数与少量基础设施 imports。
// 本文件只容纳被 ≥2 个域引用的内容；单域专用 helper 随 handler 迁移。
// 纯重构（自 routes/aiTools.js 逐字迁移），禁止改写业务逻辑。

import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import pool from '../../db/pool.js'
import config from '../../config.js'
import { blacklistJti, parseDurationToSeconds } from '../../utils/redis-client.js'
import { isValidUUID } from '../../validation/validator.js'

// 服务端存储目录（与 storage.js / media.js 一致：src/server/uploads）
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const UPLOAD_BASE = path.join(__dirname, '../../../uploads')
export const IMAGE_DIR = path.join(UPLOAD_BASE, 'images')
export const FILE_DIR = path.join(UPLOAD_BASE, 'files')

// 在多个候选目录中定位媒体文件（media 直传在 files/ 或 images/，分片上传在 uploads/ 根）
export async function locateStoredFile(relName, dirs) {
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
export const UPLOAD_FILE_ALLOWED_EXT = new Map([
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
export function getFieldSalt() {
  const salt = process.env.ENCRYPTION_KEY?.substring(0, 16)
  if (!salt) {
    throw new Error('[SECURITY] ENCRYPTION_KEY 未配置：拒绝使用公开兜底盐计算字段哈希（B5 fail-fast）')
  }
  return salt
}

export function computeFieldHash(value) {
  if (!value) return null
  return crypto.createHash('sha256').update(String(value) + getFieldSalt()).digest('hex')
}

// 手机号脱敏：138****11072
export function maskPhone(p) {
  if (!p) return null
  const s = String(p)
  if (s.length < 7) return s.slice(0, 1) + '****'
  return s.slice(0, 3) + '****' + s.slice(-4)
}

// 邮箱脱敏：a***b@example.com
export function maskEmail(e) {
  if (!e) return null
  const s = String(e)
  const at = s.indexOf('@')
  if (at <= 1) return '***' + s.slice(at)
  return s.slice(0, 1) + '***' + s.slice(at - 1)
}

// B8：批量条目数组参数上限。clip_ids 超过上限直接返回参数错误（不执行任何 SQL），
// 防止超长数组撑爆 IN 查询/审计行。destroy_clips 有更严的 50 条独立上限，不受此影响。
export const MAX_CLIP_IDS = 200

/**
 * 校验 clip_ids 数组是否超出单批上限。
 * @returns {object|null} 超限时返回参数错误对象，否则返回 null
 */
export function clipIdsLimitError(clip_ids, max = MAX_CLIP_IDS) {
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
export async function revokeUserSessions(targetUserId) {
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
export const PLAN_RANK = { Free: 0, Pro: 1, Enterprise: 2 }

// 目标用户 + 目标角色保护：目标为自身或超管时返回拒绝原因（否则 null）
export async function guardTargetUser(targetUserId, operatorUserId) {
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

// ============ D6c：读类工具统一字符预算（不信任内容防线的一环）============
// read_clip_content / export_data / 搜索与最近列表结果统一约束在 ≤8k 字符：
// 超出截断并附提示，防止巨型剪贴板内容/导出报告撑爆模型上下文，
// 同时收窄"一次性注入海量不可信文本"的提示词注入面。
export const READ_RESULT_CHAR_BUDGET = 8_000

/**
 * 单段文本预算：超出则截断并追加截断提示（含原长度）。
 */
export function clampBudgetText(text, budget = READ_RESULT_CHAR_BUDGET) {
  const s = String(text ?? '')
  if (s.length <= budget) return { text: s, truncated: false }
  return {
    text: `${s.slice(0, budget)}\n…[内容过长，已截断（原 ${s.length} 字符）]`,
    truncated: true,
  }
}

/**
 * 行式结果列表预算：整包序列化长度不超过预算时逐条保留；放不下即停并标记截断。
 */
export function trimRowsToBudget(rows, budget = READ_RESULT_CHAR_BUDGET) {
  const list = Array.isArray(rows) ? rows : []
  const kept = []
  let acc = 2 // JSON 数组包裹括号的估算开销
  for (const row of list) {
    const size = (JSON.stringify(row) || '').length + (kept.length ? 1 : 0)
    if (acc + size > budget) break
    kept.push(row)
    acc += size
  }
  return { items: kept, truncated: kept.length < list.length }
}

// 供各域引用：isValidUUID 原样透传，保持 handlers 缩进与迁移一致由编译器保证
export { isValidUUID }
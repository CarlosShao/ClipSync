// =============================================
// 超级管理员敏感操作审计中间件（RBAC）
// - 当 req.user.roleKey === 'super_admin' 且请求为敏感写操作
//   （method ∈ POST / PUT / PATCH / DELETE）时，写一条 HTTP 审计日志。
// - 排除 AI 工具入口路径（/api/ai/chat 等），避免与 executeTool 的
//   logToolAudit 双写；这些路径 body 常含敏感大文本，也不应入库。
// - body 仅存顶层键名与前若干字符，禁止完整记录 password/apiKey/token/content。
// - 审计失败仅 logger.error，不阻断主流程。
// =============================================

import { logAuditEvent } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

// AI 工具入口路径前缀：此处已由 executeTool 的 logToolAudit 单独审计，跳过双写
const AI_EXCLUDED_PREFIXES = [
  '/api/ai/chat',
  '/api/ai/summarize',
  '/api/ai/refactor-prompt',
  '/api/ai/suggest',
];

// 敏感操作方法
const SENSITIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// body 摘要：仅取顶层键名 + 前若干字符，打码敏感键；返回可安全落库的结构
const SENSITIVE_KEY_RE = /password|api[_-]?key|token|secret|authorization|credential|content|text/i;
const MAX_VALUE_LENGTH = 200;

function sanitizedSummary(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '***';
      continue;
    }
    // 仅保留标量值的摘要；嵌套对象只标记存在且给出键，避免递归记录大文本
    if (typeof value === 'string') {
      out[key] = value.length > MAX_VALUE_LENGTH
        ? value.slice(0, MAX_VALUE_LENGTH) + `...[truncated:${value.length}]`
        : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = `[array:${value.length}]`;
    } else if (typeof value === 'object') {
      out[key] = `{object:${Object.keys(value).length}}`;
    }
  }
  return out;
}

function isExcludedPath(path) {
  return AI_EXCLUDED_PREFIXES.some((prefix) => path && path.startsWith(prefix));
}

export default async function superAdminAudit(req, res, next) {
  // 仅审计超级管理员
  if (req.user && req.user.roleKey === 'super_admin') {
    // 仅敏感写方法
    if (SENSITIVE_METHODS.has((req.method || '').toUpperCase())) {
      // 排除 AI 工具入口路径，避免与 executeTool 的 logToolAudit 双写
      if (!isExcludedPath(req.path)) {
        try {
          await logAuditEvent({
            userId: req.userId,
            action: 'super_admin_action',
            resourceType: 'http',
            resourceId: req.path,
            details: {
              method: req.method,
              path: req.path,
              body: sanitizedSummary(req.body),
            },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            status: 'success',
          });
        } catch (err) {
          // logAuditEvent 内部已 try/catch，此处再兜底，确保不阻断主流程
          logger.error('superAdminAudit failed', { error: err.message, path: req.path });
        }
      }
    }
  }
  next();
}
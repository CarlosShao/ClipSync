// =============================================
// Admin Console · 审计日志查询 API（Admin Console · T-A5）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/audit-logs', auditRouter) → GET /api/admin/audit-logs
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件额外细粒度权限：GET /audit-logs → requirePerm('admin.audit.view')
//
// 响应契约（src/admin-console/src/api/types.ts AuditLog / PageData 逐字段对齐）：
//   { code: 0, data: { list: AuditLog[], total, page, pageSize } }
//   AuditLog.details 为「key=value 摘要字符串」（JSONB 展示形态），
//   如 `amount=9.90, reason="用户重复支付"`；前端 parseDetailsToJson 可反向解析。
//
// 筛选语义契约（src/admin-console/src/mocks/handlers.test.ts 固化）：
//   - action=auth      → action 前缀 user.login* / user.logout*
//   - action=payment   → action 前缀 payment.* / admin.refund.*
//   - action=sensitive → action 前缀 admin.* 或 ∈ { user.deactivate, role.assign, user.delete }
//   - action=其他串    → 具体动作 includes 匹配（ILIKE %v%）
//   - operator=end_user → 操作者角色为 user（终端用户）；其他值 → 昵称精确匹配
//   - result=failed     → status <> 'success'（DB 侧含 failure/error）
//   - ip=116.24         → ip_address 包含匹配
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_RESULTS = new Set(['success', 'failed']);
// AN-11：操作者级别筛选（audit_logs JOIN roles.role_key），覆盖 super_admin_action 审计行的读取缺口
const VALID_ACTOR_LEVELS = new Set(['super_admin', 'admin', 'user']);
// 敏感操作判定（与前端 pages/audit/sensitive.ts 同一份规则）
const SENSITIVE_EXACT_ACTIONS = new Set(['user.deactivate', 'role.assign', 'user.delete']);
// 摘要字符串最大长度（超长截断，防止大对象 details 撑爆表格/CSV）
const MAX_DETAILS_LENGTH = 500;

/** 手机号打码：138****2765（与 routes/admin/orders.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 敏感操作判定：admin. 前缀或指定动作（审计页红底高亮同款规则） */
function isSensitiveAction(action) {
  return (
    typeof action === 'string' &&
    (action.startsWith('admin.') || SENSITIVE_EXACT_ACTIONS.has(action))
  );
}

/** timestamptz → 'YYYY-MM-DD HH:mm:ss'（契约形态，前端 dayjs 可直接解析） */
function formatDateTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 摘要值序列化：
 *  - 数字/布尔 → 裸值（amount=9.9 / enabled=true）
 *  - 无空白无特殊字符的字符串 → 裸值（orderNo=CS2026...）
 *  - 含空白/CJK 等字符串 → 双引号包裹（reason="用户重复支付"，内部引号替换为单引号）
 *  - 数组 → [a|b|c]（与前端 mock 详情形态一致）
 *  - 嵌套对象 → {k=v, k2=v2}（限深）
 */
function serializeDetailValue(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    const s = value.replace(/"/g, "'");
    return /^[\w.:@+/-]*$/.test(s) ? s : `"${s}"`;
  }
  if (depth > 2) return '[deep]';
  if (Array.isArray(value)) {
    return `[${value.slice(0, 20).map((v) => serializeDetailValue(v, depth + 1)).join('|')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .slice(0, 20)
      .map(([k, v]) => `${k}=${serializeDetailValue(v, depth + 1)}`)
      .join(', ')}}`;
  }
  return String(value);
}

/**
 * JSONB details → key=value 摘要字符串（AuditLog.details 契约）。
 * 非 JSONB（历史纯字符串/null）安全透传为字符串；超长截断并标注原长。
 */
function serializeDetails(details) {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details;
  if (typeof details !== 'object' || Array.isArray(details)) return String(details);

  const summary = Object.entries(details)
    .map(([key, value]) => `${key}=${serializeDetailValue(value)}`)
    .join(', ');
  if (summary.length > MAX_DETAILS_LENGTH) {
    return summary.slice(0, MAX_DETAILS_LENGTH) + `...[truncated:${summary.length}]`;
  }
  return summary;
}

/** 分页参数解析（与 orders.js 同口径：非法回默认 page=1 / pageSize=10，上限 200） */
function parsePaging(query) {
  let page = parseInt(query.page, 10);
  let pageSize = parseInt(query.pageSize, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
  if (pageSize > 200) pageSize = 200;
  if (page > 100000) page = 100000;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 组装审计日志 WHERE 子句（handlers.test.ts 固化语义）。
 * @returns {{ whereSql: string, params: any[] } | null} null 表示筛选参数非法（调用方 400）
 */
function buildAuditFilters(query, params) {
  const where = [];
  const { action, operator, actorLevel, result, ip, dateFrom, dateTo, q, userId } = query;

  if (action && action !== 'all') {
    if (action === 'auth') {
      where.push(`(al.action LIKE 'user.login%' OR al.action LIKE 'user.logout%')`);
    } else if (action === 'payment') {
      where.push(`(al.action LIKE 'payment.%' OR al.action LIKE 'admin.refund.%')`);
    } else if (action === 'sensitive') {
      const list = [...SENSITIVE_EXACT_ACTIONS].map((a) => `'${a}'`).join(', ');
      where.push(`(al.action LIKE 'admin.%' OR al.action IN (${list}))`);
    } else {
      // 具体动作串：includes 匹配（types.ts AuditActionFilter 注释口径）
      params.push(`%${String(action)}%`);
      where.push(`al.action ILIKE $${params.length}`);
    }
  }

  if (operator && operator !== 'all') {
    if (operator === 'end_user') {
      // AF-33：终端用户 = 角色为 user 或无角色（role_id 为空，LEFT JOIN 不得漏掉）
      where.push(`(r.role_key = 'user' OR u.role_id IS NULL)`);
    } else {
      // 具体操作者：昵称精确匹配（如 Carlos / Yuki）
      params.push(String(operator));
      where.push(`u.nickname = $${params.length}`);
    }
  }

  // AF-34：按用户过滤（用户抽屉「查看审计日志」跳转 /audit?userId=xxx）
  if (userId && String(userId).trim()) {
    params.push(String(userId).trim());
    where.push(`al.user_id = $${params.length}`);
  }

  // AN-11：按操作者级别过滤（super_admin / admin / user）。
  // 典型用途：读取 superAdminAudit 中间件写入的 action='super_admin_action' 审计行
  //（超管退款/维护模式等敏感 HTTP 写操作），此前只写不读。
  if (actorLevel && actorLevel !== 'all') {
    const level = String(actorLevel);
    if (!VALID_ACTOR_LEVELS.has(level)) return null;
    params.push(level);
    where.push(`r.role_key = $${params.length}`);
  }

  if (result && result !== 'all') {
    if (!VALID_RESULTS.has(result)) return null;
    if (result === 'success') {
      where.push(`al.status = 'success'`);
    } else {
      // failed：DB 侧含 failure / error 等一切非 success 状态
      where.push(`al.status <> 'success'`);
    }
  }

  if (ip && String(ip).trim()) {
    params.push(`%${String(ip).trim()}%`);
    where.push(`al.ip_address::text ILIKE $${params.length}`);
  }

  if (dateFrom) {
    if (!DATE_RE.test(dateFrom)) return null;
    params.push(dateFrom);
    where.push(`al.created_at >= ($${params.length})::date`);
  }

  if (dateTo) {
    if (!DATE_RE.test(dateTo)) return null;
    params.push(dateTo);
    where.push(`al.created_at < ($${params.length})::date + INTERVAL '1 day'`);
  }

  if (q && String(q).trim()) {
    const keyword = `%${String(q).trim()}%`;
    params.push(keyword);
    const idx = params.length;
    where.push(
      `(al.action ILIKE $${idx} OR al.resource_id::text ILIKE $${idx} OR al.details::text ILIKE $${idx})`
    );
  }

  return { whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

// 审计行查询（列表共用）：LEFT JOIN users 取操作者昵称/打码手机号，LEFT JOIN roles 取角色
const AUDIT_SELECT = `
  SELECT
    al.id,
    al.user_id,
    al.action,
    al.resource_type,
    al.resource_id,
    al.details,
    al.ip_address,
    al.user_agent,
    al.status,
    al.created_at,
    u.nickname AS operator_nickname,
    u.phone AS operator_phone,
    r.role_key AS operator_role_key
  FROM audit_logs al
  LEFT JOIN users u ON u.id = al.user_id
  LEFT JOIN roles r ON r.id = u.role_id`;

/** DB 行 → 前端 AuditLog 契约（admin-console/src/api/types.ts） */
function mapAuditRow(row) {
  const roleKey = row.operator_role_key || null;
  return {
    id: row.id,
    // 操作者：优先昵称，缺失回退打码手机号，系统级（user_id 为空）显示「系统」
    operator: (row.operator_nickname || '').trim() || maskPhone(row.operator_phone) || '系统',
    // 契约只含 super_admin/admin/user 三值，未知/自定义角色置 null
    operatorRole: ['super_admin', 'admin', 'user'].includes(roleKey) ? roleKey : null,
    userId: row.user_id || null,
    action: row.action,
    resourceType: row.resource_type || '',
    resourceId: row.resource_id ? String(row.resource_id) : '',
    details: serializeDetails(row.details),
    ipAddress: row.ip_address ? String(row.ip_address) : '',
    userAgent: row.user_agent || null,
    status: row.status === 'success' ? 'success' : 'failed',
    sensitive: isSensitiveAction(row.action),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * GET /api/admin/audit-logs
 *   ?action=&operator=&actorLevel=&result=&ip=&dateFrom=&dateTo=&q=&page=&pageSize=
 * 审计日志分页列表（动作组/操作者/操作者级别/结果/IP/日期筛选），按时间倒序。
 */
router.get('/', requirePerm('admin.audit.view'), async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const params = [];
    const filters = buildAuditFilters(req.query, params);
    if (!filters) {
      return res.status(400).json({ code: 4000, message: '筛选参数不合法' });
    }

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       LEFT JOIN roles r ON r.id = u.role_id${filters.whereSql}`,
      filters.params
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `${AUDIT_SELECT}${filters.whereSql} ORDER BY al.created_at DESC LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, pageSize, offset]
    );

    return res.json({ code: 0, data: { list: rows.map(mapAuditRow), total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/audit] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取审计日志失败' });
  }
});

export default router;

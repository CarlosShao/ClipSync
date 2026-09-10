// =============================================
// AN-12 管理员安全策略 · 管理员会话管理 API
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/sessions', sessionsAdminRoutes)
//     → GET  /api/admin/sessions        管理角色（level>=50）活跃会话分页列表
//     → POST /api/admin/sessions/:id/revoke  强制下线单个会话（高危，原因写审计）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限（复用既有用户管理键，不新增权限目录项）：
//   - GET  /sessions        → requirePerm('admin.users.view')
//   - POST /sessions/:id/revoke → requirePerm('admin.users.manage')
//
// 数据源：user_sessions（012 迁移）JOIN users + roles，
//         仅展示 roles.level >= 50（admin / super_admin）账号的活跃会话。
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 管理角色最低等级（028_roles.sql：user=10 / admin=50 / super_admin=100） */
const ADMIN_LEVEL_THRESHOLD = 50;

/** 手机号打码（与 routes/admin/users.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** timestamptz → 'YYYY-MM-DD HH:mm:ss'（契约形态，前端 dayjs 可直接解析） */
function formatDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** 分页参数解析（与 users.js 同口径：非法回默认 page=1 / pageSize=10，上限 200） */
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
 * GET /api/admin/sessions?page=&pageSize=&q=
 * 管理角色活跃会话分页列表（q 按操作者昵称/ID 过滤），按登录时间倒序。
 * isCurrent 标记请求者自己的会话（前端禁用「下线」按钮防自锁）。
 */
router.get('/', requirePerm('admin.users.view'), async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const params = [];
    const where = [];

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      params.push(`%${q}%`);
      const likeIdx = params.length;
      params.push(q);
      const eqIdx = params.length;
      where.push(`(u.nickname ILIKE $${likeIdx} OR u.id::text = $${eqIdx})`);
    }

    const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';

    const BASE_FROM = `
      FROM user_sessions s
      INNER JOIN users u ON u.id = s.user_id
      INNER JOIN roles r ON r.id = u.role_id`;

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total${BASE_FROM}
       WHERE r.level >= ${ADMIN_LEVEL_THRESHOLD} AND s.is_active = TRUE${whereSql}`,
      params
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `SELECT
        s.id,
        s.user_id,
        u.nickname,
        u.phone,
        r.role_key,
        s.device_name,
        s.device_type,
        s.platform,
        s.ip_address,
        s.user_agent,
        s.created_at,
        CASE WHEN s.id = $${params.length + 3} THEN TRUE ELSE FALSE END AS is_current${BASE_FROM}
       WHERE r.level >= ${ADMIN_LEVEL_THRESHOLD} AND s.is_active = TRUE${whereSql}
       ORDER BY s.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset, req.user?.userId ?? null]
    );

    const list = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      nickname: row.nickname || '',
      phone: maskPhone(row.phone),
      roleKey: row.role_key || null,
      deviceName: row.device_name || 'Unknown Device',
      deviceType: row.device_type || 'browser',
      platform: row.platform || 'unknown',
      ipAddress: row.ip_address ? String(row.ip_address) : '',
      userAgent: row.user_agent || null,
      createdAt: formatDateTime(row.created_at),
      // user_sessions 无 updated_at 列（audit-extend 阶段发现恒 500 的根因）：
      // lastActiveAt 以创建时间近似（会话创建即最后活跃基线），吊销时间用 revoked_at 呈现于状态
      lastActiveAt: formatDateTime(row.created_at),
      isCurrent: Boolean(row.is_current),
    }));

    return res.json({ code: 0, data: { list, total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/sessions] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取管理员会话列表失败' });
  }
});

/**
 * POST /api/admin/sessions/:id/revoke  body { reason }
 * 强制下线单个管理员会话（requirePerm admin.users.manage）：
 *  - 仅允许吊销管理角色（level>=50）的活跃会话（普通用户会话走用户页强制下线）；
 *  - DB 吊销（is_active=false）后由 authenticateToken 的 user/session active 检查兜底拒发，
 *    与 users.js force-logout 同一失效语义；
 *  - reason 必填，写入审计 admin.session.revoke。
 */
router.post('/:id/revoke', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '会话 ID 不合法' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '强制下线必须填写原因（写入审计日志）' });
    }

    // 目标会话必须属于管理角色且仍活跃（防止越权吊销普通用户会话）
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.device_name, u.nickname, u.role_id, r.role_key, r.level
       FROM user_sessions s
       INNER JOIN users u ON u.id = s.user_id
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE s.id = $1 AND s.is_active = TRUE AND r.level >= ${ADMIN_LEVEL_THRESHOLD}`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '会话不存在或已下线' });
    }
    const session = rows[0];
    if (session.user_id === req.user?.userId) {
      return res.status(400).json({ code: 4000, message: '不能下线自己当前的会话' });
    }

    await pool.query(
      `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
       WHERE id = $1`,
      [session.id]
    );

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.session.revoke',
      resourceType: 'user_session',
      resourceId: String(session.id),
      details: {
        targetUserId: session.user_id,
        nickname: session.nickname || '',
        deviceName: session.device_name || '',
        reason,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/sessions] session revoked', {
      sessionId: session.id,
      targetUser: session.user_id,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: { id: session.id, revoked: true },
      message: '该会话已强制下线',
    });
  } catch (err) {
    logger.error('[admin/sessions] revoke failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '强制下线会话失败' });
  }
});

export default router;

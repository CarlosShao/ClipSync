// =============================================
// Admin Console RBAC 鉴权中间件（T-A1）
//
// 与 authenticateToken（middleware/auth.js）配合使用：
//  - authenticateToken 负责 JWT 校验并把角色信息注入 req.user
//    （roleKey / roleLevel / isAdmin，见 auth.js :72-86）；
//  - 本文件在此基础上做「角色等级门槛」与「细粒度权限点」两级强制。
//
// 响应契约（docs/plans/admin-console-v1-tickets.md §二 错误壳）：
//  - 403 { code: 4030, message: '权限不足' }            —— 未认证（无 req.user）或角色等级不足
//  - 403 { code: 4030, message: '缺少权限: <permKey>' } —— 已认证但无对应权限点
//  - 500 { code: 5000, message: '权限校验失败' }        —— 权限查询本身出错（fail-closed，宁可拒绝不可放行）
//
// NODE_ENV==='test' 策略（与 auth.js 保持一致）：
//  - auth.js 在测试环境注入固定测试用户（roleKey='user', roleLevel=10，最小权限），
//    本中间件不做任何测试旁路 —— 管理端点在测试下默认 fail-closed，
//    需要管理员身份的用例应在用例内自行构造 req.user（或 mock auth.js）。
// =============================================

import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

// 权限查询内存缓存 TTL（毫秒）。角色/权限变更最迟 60s 生效，可调用 clearPermCache() 立即失效。
const PERM_CACHE_TTL_MS = 60 * 1000;

// key: `${userId}:${permKey}` -> { granted: boolean, expiresAt: number }
const permCache = new Map();

/** 清空权限缓存（角色/权限分配变更后可调用；测试隔离用） */
export function clearPermCache() {
  permCache.clear();
}

function deny(res, code, message) {
  return res.status(403).json({ code, message });
}

/**
 * 角色等级门槛中间件工厂。
 * 基于 authenticateToken 注入的 req.user.roleLevel：level >= minLevel 放行。
 * 未认证（无 req.user）或等级不足 → 403 { code: 4030, message: '权限不足' }。
 * 角色等级参照（028_roles.sql）：user=10 / admin=50 / super_admin=100。
 * @param {number} minLevel 最低角色等级
 */
export function requireRole(minLevel) {
  return function requireRoleMiddleware(req, res, next) {
    const level = req.user?.roleLevel;
    // roleLevel 缺失/非数值一律拒绝（fail-closed）：authenticateToken 正常链路必注入，
    // 缺失只可能出现在未挂 authenticateToken 的错误装配场景。
    if (typeof level !== 'number' || Number.isNaN(level) || level < minLevel) {
      return deny(res, 4030, '权限不足');
    }
    return next();
  };
}

// 按用户 id 回查 role_id（当前 JWT 不携带 roleId，users 表是角色归属的唯一事实来源）
const PERM_CHECK_BY_USER_SQL = `
  SELECT p.perm_key, r.role_key, r.level
  FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE u.id = $1 AND p.perm_key = $2
  LIMIT 1`;

// token 直接携带 roleId 时的快捷查询（未来 JWT 扩展字段，避免 users 表回查）
const PERM_CHECK_BY_ROLE_SQL = `
  SELECT p.perm_key, r.role_key, r.level
  FROM roles r
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE r.id = $1 AND p.perm_key = $2
  LIMIT 1`;

/**
 * 细粒度权限点中间件工厂。
 * 查库校验：users.role_id → role_permissions JOIN permissions JOIN roles，
 * 若 token/上游已带 req.user.roleId 则直接按 role_id 查询（跳过 users 回查）。
 * 结果（含无权限）写入模块级 Map 缓存，TTL 60s；DB 查询异常时 fail-closed 返回 500。
 * @param {string} permKey 权限点，如 'admin.users.manage'
 */
export function requirePerm(permKey) {
  return async function requirePermMiddleware(req, res, next) {
    const userId = req.user?.userId ?? req.userId;
    const roleId = req.user?.roleId;

    // 未认证：与 requireRole 保持同一错误壳（正常装配下 authenticateToken 会先行拦截）
    if (!userId && !roleId) {
      return deny(res, 4030, '权限不足');
    }

    const cacheKey = `${userId || roleId}:${permKey}`;
    const cached = permCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.granted) return next();
      return deny(res, 4030, `缺少权限: ${permKey}`);
    }

    let granted = false;
    try {
      const sql = roleId ? PERM_CHECK_BY_ROLE_SQL : PERM_CHECK_BY_USER_SQL;
      const { rows } = await pool.query(sql, [roleId || userId, permKey]);
      granted = rows.length > 0;
    } catch (err) {
      // fail-closed：权限校验失败时拒绝请求，绝不放行
      logger.error('[adminAuth] permission check failed', {
        permKey,
        userId,
        error: err.message,
      });
      return res.status(500).json({ code: 5000, message: '权限校验失败' });
    }

    permCache.set(cacheKey, { granted, expiresAt: Date.now() + PERM_CACHE_TTL_MS });

    if (!granted) {
      return deny(res, 4030, `缺少权限: ${permKey}`);
    }
    return next();
  };
}

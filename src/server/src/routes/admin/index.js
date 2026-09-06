// =============================================
// Admin Console 路由骨架（Admin Console · T-A1）
//
// 挂载点：src/index.js → app.use('/api/admin', adminRoutes)
// 顶层中间件链（顺序固定）：
//   1. authenticateToken   —— JWT 校验 + 注入 req.user（roleKey/roleLevel）
//   2. requireRole(50)     —— 角色等级门槛：admin(50) / super_admin(100) 可进入
//   3. superAdminAudit     —— 超管敏感写操作自动落审计日志
//
// 响应契约（docs/plans/admin-console-v1-tickets.md §二）：
//   成功 { code: 0, data: T }；错误 { code: number, message: string }
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { authenticateToken } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/adminAuth.js';
import superAdminAudit from '../../middleware/superAdminAudit.js';

const adminRouter = Router();

// ---- 顶层中间件：认证 → 等级门槛 → 超管审计 ----
adminRouter.use(authenticateToken, requireRole(50), superAdminAudit);

// 当前角色全部权限点（whoami 用；role_id 为空的用户 INNER JOIN 后自然返回空数组）
const WHOAMI_PERMS_SQL = `
  SELECT p.perm_key
  FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE u.id = $1
  ORDER BY p.perm_key`;

/**
 * GET /api/admin/whoami
 * 返回当前登录管理员自己的身份与权限清单（前端据此驱动菜单/按钮显隐）。
 */
adminRouter.get('/whoami', async (req, res) => {
  try {
    const userId = req.user.userId;
    const roleKey = req.user.roleKey || 'user';
    const roleLevel = typeof req.user.roleLevel === 'number' ? req.user.roleLevel : 10;

    const { rows } = await pool.query(WHOAMI_PERMS_SQL, [userId]);
    const permissions = rows.map((row) => row.perm_key);

    return res.json({ code: 0, data: { userId, roleKey, roleLevel, permissions } });
  } catch (err) {
    logger.error('[admin] whoami failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取权限信息失败' });
  }
});

// TODO(T-A1.5): users/devices —— 用户管理与设备管理 APIs（users.view/manage/delete, devices.manage）
// TODO(T-A3): orders/subscriptions/plans —— 订单/退款/对账 + 订阅赠期/套餐管理 APIs（orders.refund/reconcile, subscriptions.grant, plans.manage）
// TODO(T-A5): audit/roles/configs/announcements —— 审计日志 + 角色权限 + 系统配置/功能开关 + 公告下发 APIs（audit.view, roles.manage, configs.manage, announce.send）

export default adminRouter;

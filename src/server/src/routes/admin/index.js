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
// T-A1.5：数据看板 + 用户管理 + 设备管理
import overviewAdminRoutes from './overview.js';
import usersAdminRoutes from './users.js';
import devicesAdminRoutes from './devices.js';
// T-A3：订单/退款/对账 + 订阅赠期 + 套餐管理
import ordersAdminRoutes, { reconciliationRouter } from './orders.js';
import subscriptionsAdminRoutes from './subscriptions.js';
import plansAdminRoutes from './plans.js';
// T-A5：审计日志 + 角色权限 + 系统配置/功能开关 + 公告下发
import auditAdminRoutes from './audit.js';
import rolesAdminRoutes, { permissionsRouter as permissionsAdminRoutes } from './roles.js';
import configsAdminRoutes, { flagsRouter as flagsAdminRoutes } from './configs.js';
import announcementsAdminRoutes from './announcements.js';

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

// ---- T-A1.5：数据看板 + 用户管理 + 设备管理 ----
// 权限：用户查看 requirePerm('admin.users.view')、停用/启用/强制下线/重置2FA
//       requirePerm('admin.users.manage')、角色分配 requirePerm('admin.roles.manage')、
//       删除账户 requirePerm('admin.users.delete')、设备远程下线 requirePerm('admin.devices.manage')；
//       看板聚合与设备列表/统计仅要求 requireRole(50) 门槛（权限目录中无对应 view 权限点）。
adminRouter.use('/overview', overviewAdminRoutes);
adminRouter.use('/users', usersAdminRoutes);
adminRouter.use('/devices', devicesAdminRoutes);

// ---- T-A3：订单/退款/对账 + 订阅赠期 + 套餐管理 ----
// 权限：退款 requirePerm('admin.orders.refund')、对账 requirePerm('admin.orders.reconcile')、
//       赠期 requirePerm('admin.subscriptions.grant')、套餐编辑 requirePerm('admin.plans.manage')；
//       各 GET 列表仅要求 requireRole(50) 门槛（权限目录中无对应 view 权限点）。
adminRouter.use('/orders', ordersAdminRoutes);
adminRouter.use('/reconciliation', reconciliationRouter);
adminRouter.use('/subscriptions', subscriptionsAdminRoutes);
adminRouter.use('/plans', plansAdminRoutes);

// ---- T-A5：审计日志 + 角色权限 + 系统配置/功能开关 + 公告下发 ----
// 权限：审计查看 requirePerm('admin.audit.view')、角色写操作 requirePerm('admin.roles.manage')、
//       配置/开关写操作 requirePerm('admin.configs.manage')、公告下发 requirePerm('admin.announce.send')；
//       各 GET 列表仅要求 requireRole(50) 门槛（权限目录中除 audit.view 外无对应 view 权限点）。
adminRouter.use('/audit-logs', auditAdminRoutes);
adminRouter.use('/roles', rolesAdminRoutes);
adminRouter.use('/permissions', permissionsAdminRoutes);
adminRouter.use('/configs', configsAdminRoutes);
adminRouter.use('/flags', flagsAdminRoutes);
adminRouter.use('/announcements', announcementsAdminRoutes);

export default adminRouter;

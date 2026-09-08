// =============================================
// Admin Console 路由骨架（Admin Console · T-A1）
//
// 挂载点：src/index.js → app.use('/api/admin', adminRoutes)
// 顶层中间件链（顺序固定）：
//   1. authenticateToken   —— JWT 校验 + 注入 req.user（roleKey/roleLevel）
//   2. requireRole(50)     —— 角色等级门槛：admin(50) / super_admin(100) 可进入
//   3. superAdminAudit     —— 超管敏感写操作自动落审计日志
//
// 响应契约（docs/plans/archive/admin-console-v1-tickets.md §二）：
//   成功 { code: 0, data: T }；错误 { code: number, message: string }
// =============================================

import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { authenticateToken } from '../../middleware/auth.js';
import { requireRole, requirePerm } from '../../middleware/adminAuth.js';
import superAdminAudit from '../../middleware/superAdminAudit.js';
import { getSlowQueries, getPoolStatus } from '../../utils/query-monitor.js';
import { getRedisClient } from '../../utils/redis-client.js';
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
// CO-40：运维监控概览
import opsAdminRoutes from './ops.js';

const adminRouter = Router();

// ---- 顶层中间件：认证 → 等级门槛 → 超管审计 ----
adminRouter.use(authenticateToken, requireRole(50), superAdminAudit);

// 当前角色全部权限点（whoami 用；role_id 为空的用户 INNER JOIN 后自然返回空数组）。
// RB-10：按 category='admin' 过滤——028 的 ai.* / platform.* 死键保留在库但不再下发给前端；
// super_admin 的 ['*'] 归一逻辑在前端，后端照常返回键数组。
const WHOAMI_PERMS_SQL = `
  SELECT p.perm_key
  FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE u.id = $1 AND p.category = 'admin'
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
//       设备列表/统计 requirePerm('admin.devices.view')（RB-06，049 迁移）；
//       看板聚合仅要求 requireRole(50) 门槛（权限目录中无 overview view 权限点）。
adminRouter.use('/overview', overviewAdminRoutes);
adminRouter.use('/users', usersAdminRoutes);
adminRouter.use('/devices', devicesAdminRoutes);

// ---- T-A3：订单/退款/对账 + 订阅赠期 + 套餐管理 ----
// 权限：退款 requirePerm('admin.orders.refund')、对账 requirePerm('admin.orders.reconcile')、
//       赠期 requirePerm('admin.subscriptions.grant')、套餐编辑 requirePerm('admin.plans.manage')；
//       订单/订阅/套餐读端点挂对应 view 键（RB-06：admin.orders.view / subscriptions.view / plans.view）。
adminRouter.use('/orders', ordersAdminRoutes);
adminRouter.use('/reconciliation', reconciliationRouter);
adminRouter.use('/subscriptions', subscriptionsAdminRoutes);
adminRouter.use('/plans', plansAdminRoutes);

// ---- T-A5：审计日志 + 角色权限 + 系统配置/功能开关 + 公告下发 ----
// 权限：审计查看 requirePerm('admin.audit.view')、角色写操作 requirePerm('admin.roles.manage')、
//       配置/开关写操作 requirePerm('admin.configs.manage')、公告下发 requirePerm('admin.announce.send')；
//       角色/配置/公告读端点挂对应 view 键（RB-06：admin.roles.view / configs.view / announce.view）。
adminRouter.use('/audit-logs', auditAdminRoutes);
adminRouter.use('/roles', rolesAdminRoutes);
adminRouter.use('/permissions', permissionsAdminRoutes);
adminRouter.use('/configs', configsAdminRoutes);
adminRouter.use('/flags', flagsAdminRoutes);
adminRouter.use('/announcements', announcementsAdminRoutes);

// ---- CO-40：运维监控概览（admin.ops.view，052 仅授 super_admin）----
adminRouter.use('/ops', opsAdminRoutes);

// ---- RB-08：慢查询归位 RBAC（原游离端点在 src/index.js 用 users.is_admin 判权，已删除）----
// 权限：admin.audit.view（慢查询属数据库运维观测，与审计同受众）
adminRouter.get('/slow-queries', requirePerm('admin.audit.view'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const minTime = parseInt(req.query.minTime) || 1000;
    const slowQueries = await getSlowQueries(limit, minTime);
    const poolStatus = await getPoolStatus();
    return res.json({
      code: 0,
      data: {
        slowQueries,
        poolStatus,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('[admin] slow-queries failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: 'Failed to get slow queries' });
  }
});

// ---- RB-SSO：管理台单点登录凭据签发（仅超管；桌面端「管理控制台」入口调用）----
// 签发一次性 60 秒 code（Redis，GETDEL 原子单次消费），管理台 /sso 页面经
// POST /api/auth/sso-exchange 兑换为正式管理台会话。设计见 routes/auth.js sso-exchange。
adminRouter.post('/sso/token', requireRole(100), async (req, res) => {
  try {
    const client = await getRedisClient();
    if (!client) {
      return res.status(503).json({ code: 5030, message: 'SSO 暂不可用（Redis 不可达）' });
    }
    const code = crypto.randomBytes(32).toString('hex');
    // node-redis v4：无 setex，用 SET + EX 选项设置 60 秒 TTL
    await client.set(`sso:code:${code}`, req.user.userId, { EX: 60 });
    logger.info('[SSO] sso code issued for super_admin', { userId: req.user.userId });
    return res.json({ code: 0, data: { code, expiresIn: 60 } });
  } catch (err) {
    logger.error('[SSO] token issue failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: 'SSO 凭据签发失败' });
  }
});

export default adminRouter;

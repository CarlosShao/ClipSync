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
// AN-07：管理台高危写操作限流（adminLimiter 全量限流挂载在 index.js 的 /api/admin 挂载点）
import { adminStrictLimiter } from '../../middleware/rateLimiter.js';
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
// AN-02：客户端策略下发（读 admin.configs.view / 写 admin.configs.manage）
import policiesAdminRoutes from './policies.js';
// CO-40：运维监控概览
import opsAdminRoutes from './ops.js';
// AN-16：邮件多通道管理（多 SMTP 账号 + 按用途路由 + failover）
import emailChannelsAdminRoutes from './emailChannels.js';
// AN-12：管理员安全策略 —— 管理员会话列表 + 单会话强制下线
import sessionsAdminRoutes from './sessions.js';
// AN-03：AI 平台管理（供应商启停/编辑 + 全局参数经 configs 键消费）
import aiProvidersAdminRoutes from './aiProviders.js';
// AN-04：版本发布管理（admin.release.manage，065 迁移仅授 super_admin）
import releasesAdminRoutes from './releases.js';

const adminRouter = Router();

// ---- 顶层中间件：认证 → 等级门槛 → 超管审计 ----
adminRouter.use(authenticateToken, requireRole(50), superAdminAudit);

// ---- AN-07：高危写操作叠加更严限流（adminStrictLimiter：每 IP+资源段 10 次/分钟）----
// 命中工单列举的高危口径：退款 / 强制下线（用户/设备）/ 账号删除 / 运维动作区（全员下线等）。
// req.path 为相对 /api/admin 的子路径；未命中模式直接放行，不影响普通管理操作。
const ADMIN_STRICT_WRITE_PATTERNS = [
  /^\/orders\/[^/]+\/refund$/,      // 退款
  /^\/users\/[^/]+\/force-logout$/, // 强制下线用户
  /^\/users\/[^/]+$/,               // 删除账号（DELETE）
  /^\/devices\/[^/]+\/offline$/,    // 设备远程下线
  /^\/ops\/actions$/,               // 运维动作区（clear_cache / force_logout_all 等）
  /^\/sessions\/[^/]+\/revoke$/,    // AN-12：管理员单会话强制下线
];
adminRouter.use((req, res, next) => {
  if ((req.method === 'POST' || req.method === 'DELETE') &&
      ADMIN_STRICT_WRITE_PATTERNS.some((re) => re.test(req.path))) {
    return adminStrictLimiter(req, res, next);
  }
  next();
});

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
adminRouter.use('/policies', policiesAdminRoutes);

// ---- CO-40：运维监控概览（admin.ops.view，052 仅授 super_admin）----
adminRouter.use('/ops', opsAdminRoutes);

// ---- AN-16：邮件多通道管理（admin.email_channels.manage，059 迁移仅授 super_admin）----
// 权限：全部端点 requirePerm('admin.email_channels.manage')（列表/新建/编辑/删除/发送测试）。
// password 加密落库、GET 脱敏为 has_password；操作写审计 admin.email_channel.*。
adminRouter.use('/email-channels', emailChannelsAdminRoutes);

// ---- AN-12：管理员会话（复用 admin.users.view/manage，不新增权限键）----
// 权限：列表 requirePerm('admin.users.view')、单会话下线 requirePerm('admin.users.manage')；
// 数据源 user_sessions JOIN roles（仅 level>=50 管理角色）；下线写审计 admin.session.revoke。
adminRouter.use('/sessions', sessionsAdminRoutes);

// ---- AN-03：AI 平台管理（admin.ai.manage，062 迁移仅授 super_admin）----
// 权限：全部端点 requirePerm('admin.ai.manage')（供应商列表/启停/编辑）。
// api_key 不解密不回传（仅 has_key 布尔）；禁用行在用户端列表/聊天/OCR 全链路过滤。
adminRouter.use('/ai-providers', aiProvidersAdminRoutes);

// ---- AN-04：版本发布管理（admin.release.manage，065 迁移仅授 super_admin）----
// 权限：全部端点 requirePerm('admin.release.manage')（列表/新建/编辑/发布撤回/删除）。
// 消费方：routes/app.js 公开端点（/version、/update.json、/updates/latest）。
adminRouter.use('/releases', releasesAdminRoutes);

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

// =============================================
// Admin Console · 角色与权限 API（Admin Console · T-A5）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/roles', rolesRouter)            → GET  /api/admin/roles
//                                                       POST /api/admin/roles
//                                                       PATCH /api/admin/roles/:id/permissions
//   adminRouter.use('/permissions', permissionsRouter) → GET /api/admin/permissions
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件额外细粒度权限：
//   - POST /roles、PATCH /roles/:id/permissions → requirePerm('admin.roles.manage')（高危）
//   - GET /roles、GET /permissions → 无额外权限点（admin 等级即可见，目录中无 view 权限点）
//
// 响应契约（src/admin-console/src/api/types.ts Role / Permission / CreateRolePayload 逐字段对齐）：
//   Role: { id, roleKey, name, level, memberCount, isBuiltIn, isDefault?, description?, permissions[] }
//   Permission: { permKey, name, category, description?, superAdminOnly? }
//
// 写路径约束（工单 T-A5 + 前端 handlers.ts mock 语义）：
//   - role_key 必须 custom_ 前缀、名称唯一、级别 1-99 且 ≤ 操作者角色级别
//   - super_admin 角色权限不可修改（403）
//   - 未知权限键 400；目标角色 level ≥ 操作者 level 时拒绝授予 superAdminOnly 权限（403）
//   - 写审计 admin.roles.create / admin.roles.update（敏感操作）
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm, clearPermCache } from '../../middleware/adminAuth.js';

const router = Router();

// ───────────────────────── 权限展示目录 ─────────────────────────

// 13 项权限目录的展示元数据（顺序/分组/名称与前端 mocks/data.ts 契约一致）。
// DB permissions 表只存 perm_key/category/description；这里补齐「展示分类 + 展示名 + superAdminOnly」。
const PERM_CATALOG = [
  { permKey: 'admin.users.view', name: '查看用户列表与详情', category: 'users_devices' },
  { permKey: 'admin.users.manage', name: '停用 / 启用 / 强制下线', category: 'users_devices' },
  { permKey: 'admin.users.delete', name: '删除账户（高危）', category: 'users_devices', superAdminOnly: true },
  { permKey: 'admin.devices.manage', name: '设备远程下线 / 解绑', category: 'users_devices' },
  { permKey: 'admin.subscriptions.grant', name: '人工赠期 / 调整套餐', category: 'subscriptions_orders' },
  { permKey: 'admin.orders.refund', name: '执行退款（高危）', category: 'subscriptions_orders', superAdminOnly: true },
  { permKey: 'admin.plans.manage', name: '套餐与价格管理', category: 'subscriptions_orders' },
  { permKey: 'admin.orders.reconcile', name: '查看对账报告', category: 'subscriptions_orders' },
  { permKey: 'admin.audit.view', name: '查看审计日志', category: 'audit_security' },
  { permKey: 'admin.roles.manage', name: '角色与权限管理（高危）', category: 'audit_security', superAdminOnly: true },
  { permKey: 'admin.keys.view', name: '设备密钥细节（仅超管）', category: 'audit_security', superAdminOnly: true },
  { permKey: 'admin.configs.manage', name: '系统参数与功能开关', category: 'operations', superAdminOnly: true },
  { permKey: 'admin.announce.send', name: '公告与通知下发', category: 'operations' },
];

const PERM_CATALOG_MAP = new Map(PERM_CATALOG.map((p) => [p.permKey, p]));
const CATALOG_ORDER = new Map(PERM_CATALOG.map((p, i) => [p.permKey, i]));

// superAdminOnly 权限：目标角色 level ≥ 操作者 level 时禁止授予（越级防护）
const SUPERADMIN_ONLY_PERMS = new Set(
  PERM_CATALOG.filter((p) => p.superAdminOnly).map((p) => p.permKey)
);

const CUSTOM_ROLE_KEY_RE = /^custom_[a-z0-9_]+$/;
const DEFAULT_ROLE_KEY = 'user'; // 028_roles.sql：新用户默认角色

// ───────────────────────── 通用片段 ─────────────────────────

/** DB 角色行 + 权限键集合 → 前端 Role 契约 */
function mapRoleRow(row, permKeys) {
  return {
    id: row.id,
    roleKey: row.role_key,
    name: row.name,
    level: Number(row.level),
    memberCount: Number(row.member_count ?? 0),
    isBuiltIn: Boolean(row.is_system),
    isDefault: row.role_key === DEFAULT_ROLE_KEY,
    description: row.description || '',
    permissions: permKeys,
  };
}

// 角色列表：LEFT JOIN users 统计成员数（无成员角色也要返回，COUNT=0）
const ROLES_SELECT = `
  SELECT r.id, r.role_key, r.name, r.level, r.is_system, r.description,
         COUNT(u.id)::int AS member_count
  FROM roles r
  LEFT JOIN users u ON u.role_id = r.id
  GROUP BY r.id`;

// 角色权限键集合（admin.* 权限目录内的键；028 的 ai./platform. 权限不属于后台目录）
const ROLE_PERMS_SELECT = `
  SELECT rp.role_id, p.perm_key
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE p.category = 'admin'
  ORDER BY p.perm_key`;

// 单角色权限键集合（PATCH 变更前快照用）
const ROLE_PERMS_BY_ID_SELECT = `
  SELECT p.perm_key
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE p.category = 'admin' AND rp.role_id = $1
  ORDER BY p.perm_key`;

// 单角色成员数（PATCH 响应回填 Role.memberCount 用，与 ROLES_SELECT 同口径）
const ROLE_MEMBER_COUNT_SELECT = `
  SELECT COUNT(u.id)::int AS member_count
  FROM roles r
  LEFT JOIN users u ON u.role_id = r.id
  WHERE r.id = $1
  GROUP BY r.id`;

async function loadRoles() {
  const [{ rows }, { rows: permRows }] = await Promise.all([
    pool.query(`${ROLES_SELECT} ORDER BY r.level DESC, r.role_key`),
    pool.query(ROLE_PERMS_SELECT),
  ]);
  const permsByRole = new Map();
  for (const { role_id, perm_key } of permRows) {
    if (!permsByRole.has(role_id)) permsByRole.set(role_id, []);
    permsByRole.get(role_id).push(perm_key);
  }
  return rows.map((row) => mapRoleRow(row, permsByRole.get(row.id) || []));
}

// ───────────────────────── 角色列表 ─────────────────────────

/**
 * GET /api/admin/roles
 * 角色数组（含每个角色的权限键集合与成员数统计）。
 */
router.get('/', async (_req, res) => {
  try {
    const roles = await loadRoles();
    return res.json({ code: 0, data: roles });
  } catch (err) {
    logger.error('[admin/roles] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取角色列表失败' });
  }
});

// ───────────────────────── 权限目录 ─────────────────────────

const permissionsRouter = Router();

/**
 * GET /api/admin/permissions
 * 13 项后台权限目录（含 category 分组字段与 superAdminOnly 标记）。
 * 以 DB permissions(category='admin') 为事实来源，合并展示元数据；
 * DB 存在而目录未登记的键兜底追加（name 取 description）。
 */
permissionsRouter.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT perm_key, description FROM permissions WHERE category = 'admin'`
    );

    const list = rows.map((row) => {
      const meta = PERM_CATALOG_MAP.get(row.perm_key);
      return {
        permKey: row.perm_key,
        name: meta ? meta.name : row.description || row.perm_key,
        category: meta ? meta.category : 'operations',
        description: row.description || undefined,
        superAdminOnly: meta ? Boolean(meta.superAdminOnly) : false,
      };
    });
    // 按目录顺序输出（未登记键排在最后）
    list.sort(
      (a, b) =>
        (CATALOG_ORDER.has(a.permKey) ? CATALOG_ORDER.get(a.permKey) : 999) -
          (CATALOG_ORDER.has(b.permKey) ? CATALOG_ORDER.get(b.permKey) : 999) ||
        a.permKey.localeCompare(b.permKey)
    );

    return res.json({ code: 0, data: list });
  } catch (err) {
    logger.error('[admin/roles] permissions failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取权限目录失败' });
  }
});

// ───────────────────────── 创建自定义角色 ─────────────────────────

/**
 * POST /api/admin/roles  body { roleKey, name, level, description? }
 * 创建自定义角色（requirePerm('admin.roles.manage')）：
 *  - roleKey 必须 custom_ 前缀（仅小写字母/数字/下划线）
 *  - name 非空且 roleKey 全局唯一
 *  - level 为 1-99 整数，且 ≤ 操作者自身角色级别（不可越级创建）
 *  - 新角色权限集合为空；写审计 admin.roles.create
 */
router.post('/', requirePerm('admin.roles.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const roleKey = typeof body.roleKey === 'string' ? body.roleKey.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const level = Number(body.level);

    if (!roleKey || !name) {
      return res.status(400).json({ code: 40002, message: '角色标识与名称不能为空' });
    }
    if (!CUSTOM_ROLE_KEY_RE.test(roleKey)) {
      return res
        .status(400)
        .json({ code: 40007, message: '角色标识必须以 custom_ 开头，仅含小写字母 / 数字 / 下划线' });
    }
    if (!Number.isInteger(level) || level < 1 || level >= 100) {
      return res
        .status(400)
        .json({ code: 40009, message: '级别须为 1–99 的整数（超级管理员 level 100 由系统保留）' });
    }
    const operatorLevel = typeof req.user?.roleLevel === 'number' ? req.user.roleLevel : 0;
    if (level > operatorLevel) {
      return res
        .status(400)
        .json({ code: 40009, message: `级别不能超过操作者自身角色级别（${operatorLevel}）` });
    }

    const { rows: dupRows } = await pool.query(`SELECT id FROM roles WHERE role_key = $1`, [
      roleKey,
    ]);
    if (dupRows.length > 0) {
      return res.status(400).json({ code: 40008, message: `角色标识 ${roleKey} 已存在` });
    }

    // 名称唯一（工单要求：名称唯一，避免角色列表出现同名混淆）
    const { rows: dupNameRows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [name]);
    if (dupNameRows.length > 0) {
      return res.status(400).json({ code: 40008, message: `角色名称 ${name} 已存在` });
    }

    const { rows: insertRows } = await pool.query(
      `INSERT INTO roles (role_key, name, level, is_system, is_assignable, description)
       VALUES ($1, $2, $3, FALSE, TRUE, $4)
       RETURNING id, role_key, name, level, is_system, description`,
      [roleKey, name, level, description || '自定义角色，可分配']
    );
    const created = insertRows[0];

    // 审计：admin.roles.create（敏感操作）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.roles.create',
      resourceType: 'role',
      resourceId: created.role_key,
      details: { role_key: created.role_key, name: created.name, level },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/roles] role created', { roleKey, level, operator: req.user?.userId });

    return res.status(201).json({
      code: 0,
      data: mapRoleRow({ ...created, member_count: 0 }, []),
    });
  } catch (err) {
    // role_key 唯一约束兜底（并发创建场景）
    if (err && err.code === '23505') {
      return res.status(400).json({ code: 40008, message: '角色标识已存在' });
    }
    logger.error('[admin/roles] create failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '创建角色失败' });
  }
});

// ───────────────────────── 保存角色权限集合 ─────────────────────────

/**
 * PATCH /api/admin/roles/:id/permissions  body { permissions: string[] }
 * 全量替换角色权限集合（requirePerm('admin.roles.manage')，事务）：
 *  - super_admin 角色拒绝修改（403，数据库触发器保证超管唯一）
 *  - permissions 必须为字符串数组；未知权限键 400
 *  - 越级防护：目标角色 level ≥ 操作者 level 时，拒绝授予 superAdminOnly 权限（403）
 *  - 写审计 admin.roles.update（敏感，含 added/removed）
 *  - 变更后清空权限缓存，授权最迟 60s 生效 → 立即生效
 */
router.patch('/:id/permissions', requirePerm('admin.roles.manage'), async (req, res) => {
  const roleId = req.params.id;
  try {
    const body = req.body || {};
    const requested = body.permissions;

    if (!Array.isArray(requested) || requested.some((key) => typeof key !== 'string')) {
      return res.status(400).json({ code: 40002, message: 'permissions 必须为字符串数组' });
    }
    const permKeys = [...new Set(requested.map((key) => key.trim()).filter(Boolean))];

    // 目标角色
    const { rows: roleRows } = await pool.query(
      `SELECT id, role_key, name, level, is_system, description FROM roles WHERE id = $1`,
      [roleId]
    );
    if (roleRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '角色不存在' });
    }
    const role = roleRows[0];

    if (role.role_key === 'super_admin' || Number(role.level) >= 100) {
      return res
        .status(403)
        .json({ code: 40301, message: '超级管理员权限不可修改（数据库触发器保证超管唯一）' });
    }

    // 未知权限键校验（对照 admin 权限目录）
    let validKeys = [];
    if (permKeys.length > 0) {
      const { rows: permRows } = await pool.query(
        `SELECT perm_key FROM permissions WHERE category = 'admin' AND perm_key = ANY($1)`,
        [permKeys]
      );
      validKeys = permRows.map((row) => row.perm_key);
      const unknown = permKeys.filter((key) => !validKeys.includes(key));
      if (unknown.length > 0) {
        return res.status(400).json({ code: 40007, message: `未知权限键：${unknown.join(', ')}` });
      }
    }

    // 越级防护：目标角色级别不低于操作者时，禁止授予超管专属权限
    const operatorLevel = typeof req.user?.roleLevel === 'number' ? req.user.roleLevel : 0;
    if (Number(role.level) >= operatorLevel && permKeys.some((key) => SUPERADMIN_ONLY_PERMS.has(key))) {
      return res.status(403).json({
        code: 40301,
        message: '越级操作：目标角色级别不低于操作者，禁止授予超管专属权限',
      });
    }

    // 变更前权限集合（审计 added/removed 用）
    const { rows: beforeRows } = await pool.query(ROLE_PERMS_BY_ID_SELECT, [roleId]);
    const beforeKeys = beforeRows.map((row) => row.perm_key);

    // 事务全量替换 role_permissions
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      if (validKeys.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, id FROM permissions WHERE perm_key = ANY($2)`,
          [roleId, validKeys]
        );
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // 权限缓存立即失效（adminAuth requirePerm 60s TTL → 变更即时生效）
    clearPermCache();

    // 成员数回填（Role.memberCount 契约字段）
    const { rows: countRows } = await pool.query(ROLE_MEMBER_COUNT_SELECT, [roleId]);
    const memberCount = countRows[0] ? Number(countRows[0].member_count) : 0;

    // 审计：admin.roles.update（敏感操作，含 added/removed）
    const added = validKeys.filter((key) => !beforeKeys.includes(key));
    const removed = beforeKeys.filter((key) => !validKeys.includes(key));
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.roles.update',
      resourceType: 'role',
      resourceId: role.role_key,
      details: { role: role.role_key, added, removed },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/roles] permissions updated', {
      roleKey: role.role_key,
      added: added.length,
      removed: removed.length,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      // 按请求顺序回显（permKeys 与 validKeys 内容一致：未知键已在上方拦截），
      // 避免 DB ANY() 查询顺序不定导致响应数组顺序抖动
      data: mapRoleRow({ ...role, member_count: memberCount }, permKeys),
      message: '权限已保存并写入审计日志',
    });
  } catch (err) {
    logger.error('[admin/roles] update permissions failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '保存角色权限失败' });
  }
});

export default router;
export { permissionsRouter };

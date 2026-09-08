// =============================================
// Admin Console · 用户管理 APIs（Admin Console · T-A1.5 补票）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/users', usersRouter)
//     → GET    /api/admin/users                   用户分页列表（q / plan / status / registeredIn）
//     → GET    /api/admin/users/:id               用户详情聚合（资料 + 设备 + 最近审计）
//     → PATCH  /api/admin/users/:id/status        停用/启用  body { status, reason }（reason 停用必填）
//     → PATCH  /api/admin/users/:id/role          分配角色   body { roleId, reason }（super_admin 角色不可授予）
//     → POST   /api/admin/users/:id/force-logout  强制下线（吊销该用户全部会话）
//     → POST   /api/admin/users/:id/reset-2fa     重置两步验证
//     → DELETE /api/admin/users/:id               删除账户（软删：is_active=false + deactivation_reason）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限（043_admin_permission_catalog.sql 目录）：
//   - GET  /users, /users/:id   → requirePerm('admin.users.view')
//   - PATCH /status / force-logout / reset-2fa → requirePerm('admin.users.manage')
//   - PATCH /role               → requirePerm('admin.roles.manage')（高危）
//   - DELETE /users/:id         → requirePerm('admin.users.delete')（高危）
//
// 响应契约（src/admin-console/src/api/types.ts 逐字段对齐）：
//   成功 { code: 0, data: T, message? }；错误 { code, message }；
//   分页壳 { list, total, page, pageSize }；
//   AdminUser：id/phone(打码)/nickname/email(打码)/isActive/status/subscription/
//              deviceCount/totalSpent/orderCount/roleId/createdAt/lastActiveAt/lastActiveDesc/riskFlag
//   UserDetail：{ user, devices, recentAuditLogs }
//
// 隐私口径：手机号/邮箱不出明文 —— phone 直接打码（138****2765，不解密
//   phone_encrypted，见 006_phone_email_hash.sql / 009_encrypted_fields.sql），
//   email 仅保留本地部分前 3 位（lin***@gmail.com，与 mock 形态一致）。
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PLANS = new Set(['free', 'pro', 'enterprise']);
const REGISTERED_IN_INTERVALS = { '7d': '7 days', '30d': '30 days' };

// 用户行查询（列表/详情/写操作回读共用）：LEFT JOIN 当前订阅 + 套餐取名，
// 设备数/累计消费/订单数/最近活跃用子查询聚合（避免 JOIN 抛多行）。
const USER_SELECT = `
  SELECT
    u.id,
    u.phone,
    u.email,
    u.nickname,
    u.is_active,
    u.registration_status,
    u.subscription_status,
    u.role_id,
    u.deactivation_reason,
    u.created_at,
    r.role_key,
    r.level AS role_level,
    (SELECT COUNT(*)::int FROM devices d WHERE d.user_id = u.id) AS device_count,
    (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.user_id = u.id) AS last_active_at,
    (SELECT d.platform FROM devices d WHERE d.user_id = u.id AND d.last_seen_at IS NOT NULL
      ORDER BY d.last_seen_at DESC LIMIT 1) AS last_active_platform,
    (SELECT COUNT(*)::int FROM payment_orders po
      WHERE po.user_id = u.id AND po.status IN ('paid', 'refunded')) AS order_count,
    (SELECT COALESCE(SUM(po.amount), 0) FROM payment_orders po
      WHERE po.user_id = u.id AND po.status IN ('paid', 'refunded')) AS total_spent,
    us.status AS sub_status,
    us.billing_cycle AS sub_billing_cycle,
    us.id AS sub_id,
    us.current_period_end AS sub_current_period_end,
    us.auto_renew AS sub_auto_renew,
    sp.name AS sub_plan_name
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN user_subscriptions us ON us.id = u.current_subscription_id
  LEFT JOIN subscription_plans sp ON sp.id = us.plan_id`;

// 用户详情「最近动态」审计行（T-A5 audit.js 的 AUDIT_SELECT 同款 JOIN）
const USER_AUDIT_SELECT = `
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

// 敏感操作判定（与前端 pages/audit/sensitive.ts / T-A5 audit.js 同一规则）
const SENSITIVE_EXACT_ACTIONS = new Set(['user.deactivate', 'role.assign', 'user.delete']);

function isSensitiveAction(action) {
  return (
    typeof action === 'string' &&
    (action.startsWith('admin.') || SENSITIVE_EXACT_ACTIONS.has(action))
  );
}

/** 手机号打码：138****2765（与 routes/admin/orders.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 邮箱打码：保留本地部分前 3 位 → lin***@gmail.com（无 @ 等异常形态兜底） */
function maskEmail(email) {
  if (!email) return undefined;
  const s = String(email);
  const at = s.indexOf('@');
  if (at <= 0) return s.slice(0, 1) + '***';
  const local = s.slice(0, at);
  return `${local.slice(0, Math.min(3, local.length))}***${s.slice(at)}`;
}

/** timestamptz → 'YYYY-MM-DD HH:mm:ss'（契约形态，前端 dayjs 可直接解析） */
function formatDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** timestamptz → 'YYYY-MM-DD HH:mm'（AdminUser.lastActiveAt 契约形态） */
function formatMinute(value) {
  const full = formatDateTime(value);
  return full ? full.slice(0, 16) : null;
}

/** timestamptz → 'YYYY-MM-DD'（AdminUser.createdAt / Subscription.currentPeriodEnd 契约形态） */
function formatDateOnly(value) {
  const full = formatDateTime(value);
  return full ? full.slice(0, 10) : null;
}

/** 平台枚举 → 展示名（lastActiveDesc 用） */
const PLATFORM_LABELS = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
  browser: 'Web',
  ipados: 'iPadOS',
  web: 'Web',
};

/** 相对时间描述（mock 形态：8 分钟前 / 昨天 / 8 天前） */
function relativeTimeDesc(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

/** timestamptz → 剩余天数（向上取整，最少 0） */
function daysLeft(value) {
  if (!value) return 0;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000));
}

/**
 * DB 行 → 前端 AdminUser 契约（admin-console/src/api/types.ts）。
 * 订阅摘要：优先 current_subscription_id 关联行；无订阅行回退默认 Free。
 * status 归一化到前端 SubscriptionStatus 词表：'trial'→'trialing'、'cancelled'→'canceled'。
 */
function mapUserRow(row) {
  const subStatusRaw = row.sub_status
    ? row.sub_status === 'trial' || row.sub_status === 'trialing'
      ? 'trialing'
      : row.sub_status === 'cancelled'
        ? 'canceled'
        : row.sub_status
    : 'active';
  // plan：优先当前订阅套餐名（Free/Pro/Enterprise → 小写），回退 users.subscription_status
  const subPlanName = (row.sub_plan_name || '').toLowerCase();
  const plan = VALID_PLANS.has(subPlanName)
    ? subPlanName
    : VALID_PLANS.has(row.subscription_status)
      ? row.subscription_status
      : 'free';
  const lastActiveAt = formatMinute(row.last_active_at);
  const platform = row.last_active_platform ? PLATFORM_LABELS[row.last_active_platform] : null;
  // riskFlag：暂以 deactivation_reason 兜底展示（无独立风险标记字段，后续迭代接入风控）
  const riskFlag =
    row.deactivation_reason && row.deactivation_reason !== 'deleted_by_admin'
      ? row.deactivation_reason
      : null;

  return {
    id: row.id,
    phone: maskPhone(row.phone),
    nickname: row.nickname || '',
    email: maskEmail(row.email),
    isActive: Boolean(row.is_active),
    registrationStatus: row.registration_status || 'approved',
    status: row.is_active ? 'active' : 'disabled',
    subscription: {
      plan,
      // AF-10：订阅行 id（user_subscriptions.id），供抽屉赠期定位；无订阅行为 undefined
      id: row.sub_id || undefined,
      billingCycle: row.sub_billing_cycle || null,
      status: subStatusRaw,
      currentPeriodEnd: formatDateOnly(row.sub_current_period_end),
      autoRenew: Boolean(row.sub_auto_renew),
      ...(subStatusRaw === 'trialing'
        ? { trialDaysLeft: daysLeft(row.sub_current_period_end) }
        : {}),
    },
    deviceCount: Number(row.device_count) || 0,
    // 累计消费：已支付（含事后退款）订单金额合计，单位元
    totalSpent: Math.round(Number(row.total_spent) * 100) / 100,
    orderCount: Number(row.order_count) || 0,
    roleId: row.role_id || null,
    createdAt: formatDateOnly(row.created_at),
    lastActiveAt,
    ...(lastActiveAt
      ? { lastActiveDesc: `${relativeTimeDesc(row.last_active_at)}${platform ? ` · ${platform} 客户端` : ''}` }
      : {}),
    riskFlag,
  };
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
 * 组装用户列表 WHERE。
 * q：昵称 ILIKE / 用户 id 等值 / 手机号（纯数字关键词 → 全号精确 或 后 4 位精确）
 * plan：users.subscription_status 等值（free/pro/enterprise）
 * status：active → is_active=TRUE；disabled → FALSE
 * registeredIn：7d/30d → created_at 时间窗
 * @returns {{ whereSql: string, params: any[] } | null} null 表示筛选参数非法（调用方 400）
 */
function buildUserFilters(query, params) {
  const where = [];
  const { q, plan, status, registeredIn } = query;

  const keyword = typeof q === 'string' ? q.trim() : '';
  if (keyword) {
    const parts = [];
    params.push(`%${keyword}%`);
    parts.push(`u.nickname ILIKE $${params.length}`);
    params.push(keyword);
    const eqIdx = params.length;
    parts.push(`u.id::text = $${eqIdx}`);
    if (/^\+?\d{4,}$/.test(keyword)) {
      // 手机号：全号精确 或 后 4 位精确（不暴露中间号码段，避免 LIKE 扫描全表语义）
      parts.push(`u.phone = $${eqIdx}`);
      parts.push(`RIGHT(u.phone, 4) = $${eqIdx}`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  if (plan && plan !== 'all') {
    if (!VALID_PLANS.has(plan)) return null;
    params.push(plan);
    where.push(`u.subscription_status = $${params.length}`);
  }

  if (status && status !== 'all') {
    if (status === 'active') {
      where.push('u.is_active = TRUE');
    } else if (status === 'disabled') {
      where.push('u.is_active = FALSE');
    } else if (status === 'waitlist') {
      where.push("u.registration_status = 'waitlist'");
    } else {
      return null;
    }
  }

  if (registeredIn && registeredIn !== 'all') {
    const interval = REGISTERED_IN_INTERVALS[registeredIn];
    if (!interval) return null;
    where.push(`u.created_at >= NOW() - INTERVAL '${interval}'`);
  }

  return { whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

// ───────────────────────── 用户列表 ─────────────────────────

/**
 * GET /api/admin/users?page=&pageSize=&q=&plan=&status=&registeredIn=
 * 用户分页列表（关键词/套餐/状态/注册时间筛选），按注册时间倒序。
 */
router.get('/', requirePerm('admin.users.view'), async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const params = [];
    const filters = buildUserFilters(req.query, params);
    if (!filters) {
      return res.status(400).json({ code: 4000, message: '筛选参数不合法' });
    }

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u${filters.whereSql}`,
      filters.params
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `${USER_SELECT}${filters.whereSql} ORDER BY u.created_at DESC LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, pageSize, offset]
    );

    return res.json({ code: 0, data: { list: rows.map(mapUserRow), total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/users] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取用户列表失败' });
  }
});

// ───────────────────────── 用户详情 ─────────────────────────

/**
 * GET /api/admin/users/:id
 * 详情聚合：资料（AdminUser）+ 设备数组（轻量 Device）+ 最近 10 条该用户相关审计。
 */
router.get('/:id', requirePerm('admin.users.view'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const { rows } = await pool.query(`${USER_SELECT} WHERE u.id::text = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const user = mapUserRow(rows[0]);

    const { rows: deviceRows } = await pool.query(
      `SELECT id, device_name, platform, platform_version, is_online, last_seen_at
       FROM devices WHERE user_id = $1::uuid
       ORDER BY last_seen_at DESC NULLS LAST`,
      [id]
    );
    const devices = deviceRows.map((d) => ({
      id: d.id,
      name: d.device_name,
      platform: d.platform,
      os: d.platform_version || undefined,
      status: d.is_online ? 'online' : 'offline',
      lastActiveAt: formatMinute(d.last_seen_at),
    }));

    const { rows: auditRows } = await pool.query(
      `${USER_AUDIT_SELECT} WHERE al.user_id = $1::uuid ORDER BY al.created_at DESC LIMIT 10`,
      [id]
    );
    const recentAuditLogs = auditRows.map(mapAuditRow);

    return res.json({ code: 0, data: { user, devices, recentAuditLogs } });
  } catch (err) {
    logger.error('[admin/users] detail failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取用户详情失败' });
  }
});

// ───────────────────── 摘要字符串序列化（T-A5 audit.js 同款） ─────────────────────

/** 摘要值序列化：字符串含空白/CJK 时双引号包裹，数组 [a|b]，嵌套 {k=v}（限深） */
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

/** JSONB details → key=value 摘要字符串（AuditLog.details 契约） */
function serializeDetails(details) {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details;
  if (typeof details !== 'object' || Array.isArray(details)) return String(details);
  return Object.entries(details)
    .map(([key, value]) => `${key}=${serializeDetailValue(value)}`)
    .join(', ');
}

/** DB 审计行 → 前端 AuditLog 契约（T-A5 audit.js mapAuditRow 同款） */
function mapAuditRow(row) {
  const roleKey = row.operator_role_key || null;
  return {
    id: row.id,
    operator: (row.operator_nickname || '').trim() || maskPhone(row.operator_phone) || '系统',
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
    createdAt: formatDateTime(row.created_at) || '',
  };
}

// ───────────────────────── 写操作公共片段 ─────────────────────────

/** 按 id 取用户行（写操作前置校验 + 回读复用）；不存在返回 null */
async function fetchUserById(id) {
  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id::text = $1`, [id]);
  return rows[0] || null;
}

/**
 * 越级防护（与 roles.js「级别不能超过操作者」同一层级规则的反向约束）：
 * 敏感用户操作（停用/启用/强制下线/重置2FA/分配角色/删除）要求操作者角色等级
 * 严格高于目标用户——admin(50) 只能管理普通用户(10)，无法操作同级 admin(50)
 * 或 super_admin(100)；super_admin(100) 可操作所有人。
 * 无角色用户按最低级 10 处理（fail-closed）。
 * 返回 null 表示通过，否则为可直接返回的 403 响应体。
 */
function targetLevelGuardError(req, targetUser) {
  const operatorLevel = typeof req.user?.roleLevel === 'number' ? req.user.roleLevel : 0;
  const targetLevel = Number.isFinite(Number(targetUser?.role_level))
    ? Number(targetUser.role_level)
    : 10;
  if (targetLevel >= operatorLevel) {
    return {
      status: 403,
      body: {
        code: 40302,
        message: `越级防护：目标用户角色等级(${targetLevel})不低于操作者(${operatorLevel})，禁止执行该操作`,
      },
    };
  }
  return null;
}

/**
 * PATCH /api/admin/users/:id/status  body { status, reason }
 * 停用/启用账号（requirePerm admin.users.manage）：
 *  - status=disabled 停用：is_active=false + 落 deactivated_at/deactivation_reason，
 *    并吊销该用户全部会话（抽屉文案承诺「停用后该用户全部设备将退出登录」）；
 *  - status=active 启用：is_active=true + 清除停用标记；
 *  - reason 停用必填，写入审计 user.deactivate / user.activate。
 */
router.patch('/:id/status', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }
    const body = req.body || {};
    const { status } = body;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (status !== 'active' && status !== 'disabled') {
      return res.status(400).json({ code: 4000, message: 'status 取值不合法' });
    }
    if (status === 'disabled' && !reason) {
      return res.status(400).json({ code: 4000, message: '停用账号必须填写原因（写入审计日志）' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }

    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const disabling = status === 'disabled';
    await pool.query(
      `UPDATE users
       SET is_active = $2,
           deactivated_at = ${disabling ? 'NOW()' : 'NULL'},
           deactivation_reason = ${disabling ? '$3' : 'NULL'},
           updated_at = NOW()
       WHERE id = $1`,
      disabling ? [user.id, false, reason] : [user.id, true]
    );

    // 停用即下线：吊销该用户全部活跃会话（剪贴板同步中断，与抽屉文案一致）
    if (disabling) {
      await pool.query(
        `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
         WHERE user_id = $1 AND is_active = TRUE`,
        [user.id]
      );
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: disabling ? 'user.deactivate' : 'user.activate',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        ...(reason ? { reason } : {}),
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    const updated = await fetchUserById(id);
    return res.json({
      code: 0,
      data: mapUserRow(updated || user),
      message: disabling ? '账号已停用' : '账号已启用',
    });
  } catch (err) {
    logger.error('[admin/users] update status failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '更新用户状态失败' });
  }
});

/**
 * POST /api/admin/users/:id/approve  body { reason? }
 * 审批通过等待名单用户（requirePerm admin.users.manage）：
 *  - registration_status: 'waitlist' → 'approved'（signup_waitlist 开关落地，见 046 迁移）；
 *  - 仅对待审核用户生效，重复审批幂等返回当前状态；
 *  - 审计 admin.users.approve（敏感操作）。
 */
router.post('/:id/approve', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }
    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    // fetchUserById 返回原始行（蛇形键），camelCase 映射仅在 mapUserRow
    if (user.registration_status !== 'waitlist') {
      return res.status(409).json({ code: 4090, message: '该用户不在等待名单中' });
    }

    await pool.query(
      `UPDATE users SET registration_status = 'approved', updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.users.approve',
      resourceType: 'user',
      resourceId: String(user.id),
      details: { targetUserId: user.id, nickname: user.nickname || '', ...(reason ? { reason } : {}) },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    const updated = await fetchUserById(id);
    return res.json({
      code: 0,
      data: mapUserRow(updated || user),
      message: '已通过审核，用户现在可以登录',
    });
  } catch (err) {
    logger.error('[admin/users] approve failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '审批操作失败' });
  }
});

/**
 * PATCH /api/admin/users/:id/role  body { roleId, reason }
 * 分配角色（requirePerm admin.roles.manage，高危）：
 *  - super_admin 角色（role_key='super_admin' 或 level>=100）不可授予他人 ——
 *    028_roles.sql 的超管唯一性由数据库触发器保证，应用层先行拒绝；
 *  - 写审计 role.assign。
 */
router.patch('/:id/role', requirePerm('admin.roles.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }
    const body = req.body || {};
    const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!roleId || !UUID_RE.test(roleId)) {
      return res.status(400).json({ code: 4000, message: 'roleId 必填且须为合法 UUID' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }

    // 越级防护一：不可对同级/更高级用户改角色（防 admin 降级 super_admin）
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const { rows: roleRows } = await pool.query(
      `SELECT id, role_key, name, level FROM roles WHERE id::text = $1`,
      [roleId]
    );
    if (roleRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '角色不存在' });
    }
    const role = roleRows[0];
    if (role.role_key === 'super_admin' || Number(role.level) >= 100) {
      return res
        .status(403)
        .json({ code: 40301, message: '超级管理员角色不可授予其他用户（数据库触发器保证超管唯一）' });
    }
    // 越级防护二：不可授予不低于操作者自身等级的角色（防 admin 批量制造同级管理员）
    if (Number(role.level) >= (typeof req.user?.roleLevel === 'number' ? req.user.roleLevel : 0)) {
      return res.status(403).json({
        code: 40303,
        message: `越级防护：不能授予等级不低于操作者(${req.user?.roleLevel})的角色(${role.level})`,
      });
    }

    await pool.query(`UPDATE users SET role_id = $2, updated_at = NOW() WHERE id = $1`, [
      user.id,
      role.id,
    ]);

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'role.assign',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        roleId: role.id,
        roleKey: role.role_key,
        roleName: role.name,
        ...(reason ? { reason } : {}),
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    const updated = await fetchUserById(id);
    return res.json({
      code: 0,
      data: mapUserRow(updated || user),
      message: '角色已更新并写入审计日志',
    });
  } catch (err) {
    logger.error('[admin/users] assign role failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '分配角色失败' });
  }
});

/**
 * POST /api/admin/users/:id/force-logout
 * 强制下线（requirePerm admin.users.manage）：吊销该用户全部活跃会话。
 *
 * Redis 黑名单简化说明：authenticateToken 的 JWT 校验已有 DB 兜底 ——
 * 即便 Redis 黑名单未命中，只要 user_sessions.is_active=false 就拒绝请求
 * （见 middleware/auth.js 的 user/session active 检查），因此此处仅落 DB 层
 * 吊销即可让全部存量 token 立即失效，不额外写 Redis 黑名单。
 */
router.post('/:id/force-logout', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const { rowCount } = await pool.query(
      `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
       WHERE user_id = $1 AND is_active = TRUE`,
      [user.id]
    );
    const revokedSessions = rowCount || 0;

    // AF-11：前端弹窗要求填原因，随 body.reason 落审计
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.force_logout',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        sessionsRevoked: revokedSessions,
        ...(reason ? { reason } : {}),
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/users] force logout executed', {
      targetUser: user.id,
      revokedSessions,
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: { id: user.id, revokedSessions }, message: '已强制下线' });
  } catch (err) {
    logger.error('[admin/users] force logout failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '强制下线失败' });
  }
});

/**
 * POST /api/admin/users/:id/reset-2fa
 * 重置两步验证（requirePerm admin.users.manage）：
 * 两步验证落 users 表自身列（021_two_factor.sql：two_factor_enabled/secret/
 * pending_secret/backup_codes，无独立 two_factor 表），清空即完成重置，
 * 用户需重新绑定 TOTP。写审计 admin.user.reset_2fa。
 */
router.post('/:id/reset-2fa', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    await pool.query(
      `UPDATE users
       SET two_factor_enabled = FALSE,
           two_factor_secret = NULL,
           two_factor_pending_secret = NULL,
           two_factor_backup_codes = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.reset_2fa',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    return res.json({
      code: 0,
      data: { id: user.id, twoFactorEnabled: false },
      message: '两步验证已重置',
    });
  } catch (err) {
    logger.error('[admin/users] reset 2fa failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '重置两步验证失败' });
  }
});

/**
 * DELETE /api/admin/users/:id
 * 删除账户（requirePerm admin.users.delete，高危）：
 *  - super_admin 账户拒绝删除；
 *  - 软删：is_active=false + deactivation_reason='deleted_by_admin'（数据保留可追溯），
 *    会话随 is_active=false 由 authenticateToken 的 DB 兜底自然失效；
 *  - 写审计 user.delete。
 */
router.delete('/:id', requirePerm('admin.users.delete'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    if (user.role_key === 'super_admin') {
      return res.status(403).json({ code: 40301, message: '超级管理员账户不可删除' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    await pool.query(
      `UPDATE users
       SET is_active = FALSE,
           deactivated_at = NOW(),
           deactivation_reason = 'deleted_by_admin',
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // AF-12：前端弹窗要求填原因；deactivation_reason 保持 'deleted_by_admin' 供列表风险标记识别，
    // 运营填写的原因落到审计 details.reason
    const deleteReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'user.delete',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        reason: deleteReason || 'deleted_by_admin',
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/users] user soft deleted', {
      targetUser: user.id,
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: { id: user.id, deleted: true }, message: '账户已删除' });
  } catch (err) {
    logger.error('[admin/users] delete failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '删除账户失败' });
  }
});

export default router;

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
//     → POST   /api/admin/users/:id/reset-password 代重置密码（返回一次性临时密码，2026-10-05）
//     → POST   /api/admin/users/:id/rebind        换绑手机号/邮箱（三列一致，2026-10-05）
//     → POST   /api/admin/users/:id/trial         人工开通/重置试用（刻意绕过终身一次闸，2026-10-05）
//     → PATCH  /api/admin/users/:id/profile       违规昵称/头像处置（并清 Redis 用户缓存，2026-10-05）
//     → POST   /api/admin/users/:id/notify        对单个用户定向通知（权限是 announce.send，见下）
//     → DELETE /api/admin/users/:id               删除账户（软删：is_active=false + deactivation_reason）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限（043_admin_permission_catalog.sql 目录）：
//   - GET  /users, /users/:id   → requirePerm('admin.users.view')
//   - PATCH /status / force-logout / reset-2fa / profile → requirePerm('admin.users.manage')
//   - POST /reset-password      → requirePerm('admin.users.manage')（高危：直接换掉登录凭据）
//   - POST /rebind              → requirePerm('admin.users.manage')（高危：换掉登录标识）
//   - POST /trial               → requirePerm('admin.subscriptions.grant')（人工给出订阅权益，同类同权）
//   - POST /notify              → requirePerm('admin.announce.send')（对外触达类，刻意的：见该路由注释）
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
import { decryptField, encryptField } from '../../utils/encryption.js';
import { isValidEmail, isValidPhone, sanitizeString, validateNickname } from '../../validation/validator.js';
import { clearUserCache } from '../../utils/cache.js';
import { computeFieldHash } from '../../utils/fieldHash.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { sendNotification, getOnlineDeviceCount } from '../../ws/server.js';
import { resetUserPassword } from '../../services/userPasswordReset.js';

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
 * POST /api/admin/users/:id/rebind  body { phone?, email?, reason }
 * 换绑登录标识（手机号 / 邮箱）—— 2026-10-05 新增。
 *
 * 为什么之前只能改库：手机号是**登录标识**（auth.js 按 `phone` / `phone_hash` 查用户），
 * 用户换号就登不上了；而用户侧 `PUT /profile` 只允许改 email（且没有验证码校验），
 * phone 完全没有自助路径。更要命的是改库必须**同时**改三列
 *（`phone` / `phone_hash` / `phone_encrypted`，口径见 auth.js 的注册写入），人工改必错 ——
 * 少改一列的直接后果就是「这个人再也登录不进来」。
 *
 * 口径：
 *   - phone / email **至少给一个**；给了就三列一起写（明文 + 派生 hash + 密文）；
 *   - email 一律**小写归一**（auth.js 的注册与登录都是 lower-case 之后再写/查；
 *     不归一就会出现「注册写大写、登录查小写 ⇒ 查不到自己」这种事故）；
 *   - 撞号保护：新值已被**其他**账号占用（按值或 hash 查）→ 409；排除自己，因此允许改回原值；
 *   - 越级防护：不得换绑**自己**或等级不低于自己的用户 —— 否则 admin 把某个账号换绑到
 *     自己控制的手机号上，再走「忘记密码」即可接管；
 *   - 原因必填；审计只记**打码后**的新旧值（审计长期留存，不扩散明文 PII；明文在 users 表里）；
 *   - **不吊销会话**：换绑本身不授予新访问（仍需要密码），已登录设备仍是本人，
 *     强行踢掉只会把「换个手机号」变成一次全端下线事故。
 */
router.post('/:id/rebind', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '换绑必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
    if (!rawPhone && !rawEmail) {
      return res.status(400).json({ code: 4000, message: 'phone 与 email 至少提供一个' });
    }

    let cleanPhone = null;
    if (rawPhone) {
      cleanPhone = sanitizeString(rawPhone);
      if (!isValidPhone(cleanPhone)) {
        return res.status(400).json({ code: 4000, message: '手机号格式不合法（须为 11 位大陆手机号）' });
      }
    }
    let cleanEmail = null;
    if (rawEmail) {
      cleanEmail = sanitizeString(rawEmail.toLowerCase());
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ code: 4000, message: '邮箱格式不合法' });
      }
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    // 撞号检查（排除自己：允许把手机号/邮箱改回它原本的值）
    if (cleanPhone) {
      const dup = await pool.query(
        'SELECT id FROM users WHERE (phone = $1 OR phone_hash = $2) AND id <> $3',
        [cleanPhone, computeFieldHash(cleanPhone), user.id]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ code: 40904, message: '该手机号已被其他账号使用' });
      }
    }
    if (cleanEmail) {
      const dup = await pool.query(
        'SELECT id FROM users WHERE (email = $1 OR email_hash = $2) AND id <> $3',
        [cleanEmail, computeFieldHash(cleanEmail), user.id]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ code: 40904, message: '该邮箱已被其他账号使用' });
      }
    }

    // COALESCE：只写本次给到的列，其余保持原值（避免"只改邮箱"顺手把手机号清空）
    await pool.query(
      `UPDATE users
          SET phone = COALESCE($2, phone),
              phone_hash = COALESCE($3, phone_hash),
              phone_encrypted = COALESCE($4, phone_encrypted),
              email = COALESCE($5, email),
              email_hash = COALESCE($6, email_hash),
              email_encrypted = COALESCE($7, email_encrypted),
              updated_at = NOW()
        WHERE id = $1`,
      [
        user.id,
        cleanPhone,
        cleanPhone ? computeFieldHash(cleanPhone) : null,
        cleanPhone ? encryptField(cleanPhone) : null,
        cleanEmail,
        cleanEmail ? computeFieldHash(cleanEmail) : null,
        cleanEmail ? encryptField(cleanEmail) : null,
      ]
    );

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.rebind',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        reason,
        // 打码：审计是长期留存的，不该成为明文的第二份副本；要核对明文去 users 表
        fromPhone: user.phone ? maskPhone(user.phone) : null,
        fromEmail: user.email ? maskEmail(user.email) : null,
        toPhone: cleanPhone ? maskPhone(cleanPhone) : null,
        toEmail: cleanEmail ? maskEmail(cleanEmail) : null,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/users] rebind executed', {
      targetUserId: user.id,
      changedPhone: Boolean(cleanPhone),
      changedEmail: Boolean(cleanEmail),
      operator: req.user?.userId,
    });

    const refreshed = await fetchUserById(user.id);
    return res.json({
      code: 0,
      data: mapUserRow(refreshed || user),
      message: cleanPhone && cleanEmail ? '手机号与邮箱已换绑' : cleanPhone ? '手机号已换绑' : '邮箱已换绑',
    });
  } catch (err) {
    logger.error('[admin/users] rebind failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '换绑失败' });
  }
});

/**
 * POST /api/admin/users/:id/trial  body { reason, days?, planId?, billingCycle? }
 * 人工开通 / 重置试用（2026-10-05 新增）。
 *
 * 为什么之前只能改库：用户侧 `POST /api/subscriptions/trial` 有一条**终身一次**闸
 *（`SELECT id FROM user_subscriptions WHERE user_id = $1 LIMIT 1` —— 有行即拒，
 * 连 cancelled/expired 也算，专门防「取消后再试用」循环套取）。这条闸本身是对的，
 * 但它没有**例外通道**：客服想补一次试用（试用期内服务出故障、或用户是新人但库里
 * 已有 Free 订阅行）就只能改库 —— 而试用会同时写 `user_subscriptions`（含 `trial_end`）
 * 与 `users` 的两个快照列，人工改必错。
 *
 * 本端点**刻意绕过**那条闸（这就是「重置试用」的含义），所以：
 *   - 拒绝"已有生效中订阅"的用户（付费/试用进行中都算）→ 避免叠出两条 active/trialing 行，
 *     并提示改用「赠期」或先「收回」；
 *   - days 默认 7（与用户侧一致）、上限 30 —— 更长就不叫试用了，请用「赠期」；
 *   - 审计里明确记 `bypassedLifetimeGate: true`：**绕过产品规则必须留痕**，
 *     否则事后无法把"客服补的试用"与"用户自助试用"分开；
 *   - 通知用户（试用是用户可见的权益变化，静默开通也该在通知中心有迹可循）。
 *
 * 权限复用 `admin.subscriptions.grant`（同类：人工给出订阅权益）。
 */
router.post('/:id/trial', requirePerm('admin.subscriptions.grant'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '开通试用必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const days = body.days === undefined || body.days === null || body.days === '' ? 7 : Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      return res.status(400).json({
        code: 4000,
        message: '试用天数须为 1–30 的整数（更长请改用「赠期」）',
      });
    }
    const billingCycle = body.billingCycle === 'yearly' ? 'yearly' : 'monthly';

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    // 已有生效中订阅（付费或试用进行中）⇒ 不叠加，避免两条 active/trialing 行
    const live = await pool.query(
      `SELECT id, status, current_period_end
         FROM user_subscriptions
        WHERE user_id = $1
          AND status IN ('active', 'trialing', 'trial', 'past_due')
          AND (current_period_end IS NULL OR current_period_end > NOW())
        ORDER BY current_period_end DESC NULLS FIRST
        LIMIT 1`,
      [user.id]
    );
    if (live.rows.length > 0) {
      const existing = live.rows[0];
      const endStr = existing.current_period_end
        ? new Date(existing.current_period_end).toISOString().slice(0, 10)
        : '未知';
      return res.status(409).json({
        code: 40906,
        reason: 'ALREADY_SUBSCRIBED',
        existingStatus: existing.status,
        message: `该用户已有生效中的订阅（${existing.status}，到期 ${endStr}），无需试用；如需补偿请用「赠期」，或先用「收回」终止`,
      });
    }

    // 套餐解析：与 grant 同一套「UUID / 套餐名」分流（见 §4-A12：不能写成 id=$1 OR name=$1，
    // 非 UUID 字符串会被 PG 直接以 22P02 抛错）。默认取名为 pro 的套餐。
    const planInput = typeof body.planId === 'string' && body.planId.trim() ? body.planId.trim() : 'pro';
    const { rows: planRows } = await pool.query(
      UUID_RE.test(planInput)
        ? 'SELECT id, name, display_name FROM subscription_plans WHERE id = $1 AND is_active = true'
        : 'SELECT id, name, display_name FROM subscription_plans WHERE lower(name) = lower($1) AND is_active = true',
      [planInput]
    );
    if (planRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '套餐不存在' });
    }
    const plan = planRows[0];
    if (String(plan.name || '').toLowerCase() === 'free') {
      return res.status(400).json({ code: 4000, message: '免费版没有试用一说，请指定 Pro / Enterprise 套餐' });
    }

    // 与用户侧 trial 路由**同一口径**：status='trial'、区间用 SQL 计算（避免 JS/DB 时区偏移）
    const trial = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, start_date, end_date,
          current_period_start, current_period_end, billing_cycle, trial_end)
       VALUES ($1, $2, 'trial', NOW(), NOW() + make_interval(days => $4),
               NOW(), NOW() + make_interval(days => $4), $3,
               NOW() + make_interval(days => $4))
       RETURNING id, trial_end, current_period_end`,
      [user.id, plan.id, billingCycle, days]
    );
    const created = trial.rows[0];

    await pool.query(
      `UPDATE users
          SET subscription_status = 'trial', current_subscription_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [user.id, created.id]
    );

    const trialEndIso = created.current_period_end
      ? new Date(created.current_period_end).toISOString()
      : null;

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.subscriptions.trial',
      resourceType: 'user_subscription',
      resourceId: String(created.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        planId: plan.id,
        planName: plan.display_name || plan.name,
        days,
        billingCycle,
        trialEnd: trialEndIso,
        reason,
        // ★刻意绕过用户侧的"终身一次"闸 —— 必须留痕，否则事后分不清谁补的
        bypassedLifetimeGate: true,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    try {
      await sendNotification(user.id, {
        notificationType: 'subscription_notice',
        title: `已为你开通 ${days} 天试用`,
        body: `你的 ${plan.display_name || plan.name} 试用已开通，有效期至 ${
          trialEndIso ? trialEndIso.slice(0, 10) : '—'
        }。`,
        data: { subscriptionId: created.id, trialDays: days },
      });
    } catch (notifyErr) {
      logger.warn('[admin/users] trial notify failed (ignored)', {
        targetUserId: user.id,
        error: notifyErr?.message,
      });
    }

    logger.info('[admin/users] manual trial granted', {
      targetUserId: user.id,
      days,
      planName: plan.name,
      operator: req.user?.userId,
    });

    const refreshed = await fetchUserById(user.id);
    return res.json({
      code: 0,
      data: mapUserRow(refreshed || user),
      message: `已为 ${user.nickname || '该用户'} 开通 ${days} 天试用（${
        plan.display_name || plan.name
      }，到期 ${trialEndIso ? trialEndIso.slice(0, 10) : '—'}）`,
    });
  } catch (err) {
    logger.error('[admin/users] grant trial failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '开通试用失败' });
  }
});

/**
 * PATCH /api/admin/users/:id/profile  body { nickname?, avatarUrl?, clearAvatar?, reason }
 * 违规昵称 / 头像处置（2026-10-05 新增）。
 *
 * 为什么之前只能改库：`routes/admin/` 里**没有任何 profile 写端点**，而用户侧
 * `PUT /profile` 只能改**自己**的资料。于是运营遇到违规昵称/头像时只有两个选择：
 * 停用整个账号（过重，且与违规程度不成比例），或者改库。
 *
 * 改库在这里**确实不够**，有两个具体原因（本端点都处理了）：
 *   ① `GET /profile` 有 Redis 缓存（`utils/cache.js` 的 `user:<id>`，TTL 5 分钟）。
 *      用户侧改资料会 `clearUserCache`，改库**不会** —— 于是用户最长 5 分钟仍看到旧昵称，
 *      客服会以为"改了没生效"。
 *   ② 用户侧 `PUT /profile` 对昵称**没有长度校验**、对头像**完全不校验协议**
 *      （任何 trim 后的字符串都原样存下）。管理台入口比它更严，见下。
 *
 * 口径：
 *   - `nickname`：trim → 复用**与用户侧同一个** `validateNickname`（≤50、不含 `<>"'&`）
 *     → 再 `sanitizeString` 落库（存储形态与用户侧一致）。**不接受空值** ——
 *     空昵称在客户端会显示成空白，比违规昵称更糟；要"清掉"请给一个中性替代名（如「用户4821」）。
 *   - `clearAvatar: true` → `avatar_url = ''`（列默认值）。
 *   - `avatarUrl` → 替换头像，只接受 `http(s)://` 或 `data:image/...;base64,`
 *     （用户侧不校验协议，会把 `javascript:` 之类原样存下；管理台入口更严）。
 *   - 至少给一项；原因必填；审计记**改动前后**的昵称与"是否改了头像"（内容截断，避免审计膨胀）。
 *   - **不吊销会话**：昵称/头像可逆、不涉及访问凭据，为它把人踢下线不成比例。
 *   - 权限 `admin.users.manage`（账号治理族），并已登记进高危限流名单。
 */
router.patch('/:id/profile', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '处置原因必填（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const hasNickname = body.nickname !== undefined && body.nickname !== null;
    const clearAvatar = body.clearAvatar === true;
    const hasAvatarUrl = typeof body.avatarUrl === 'string' && body.avatarUrl.trim() !== '';
    if (!hasNickname && !clearAvatar && !hasAvatarUrl) {
      return res.status(400).json({
        code: 4000,
        message: 'nickname / avatarUrl / clearAvatar 至少给一项（否则没有任何改动）',
      });
    }

    let cleanNickname = null; // null = 不改
    if (hasNickname) {
      const raw = String(body.nickname).trim();
      if (!raw) {
        return res.status(400).json({
          code: 4000,
          message: '昵称不能为空（空昵称在客户端会显示成空白）；要清除违规昵称请给一个中性替代名，如「用户4821」',
        });
      }
      const check = validateNickname(raw);
      if (!check.valid) {
        return res.status(400).json({
          code: 4000,
          message: `昵称不合法：不超过 50 字、且不能包含 < > " ' &`,
        });
      }
      cleanNickname = sanitizeString(raw);
    }

    let cleanAvatar = null; // null = 不改；'' = 清空
    if (clearAvatar) {
      cleanAvatar = '';
    } else if (hasAvatarUrl) {
      const value = String(body.avatarUrl).trim();
      if (value.length > 2000) {
        return res.status(400).json({ code: 4000, message: '头像内容过长（≤2000 字符）' });
      }
      const acceptable =
        /^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
      if (!acceptable) {
        return res.status(400).json({
          code: 4000,
          message: '头像只接受 http(s) 链接或 data:image/...;base64, 形式',
        });
      }
      cleanAvatar = value;
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const params = [user.id];
    const sets = [];
    if (cleanNickname !== null) {
      params.push(cleanNickname);
      sets.push(`nickname = $${params.length}`);
    }
    if (cleanAvatar !== null) {
      params.push(cleanAvatar);
      sets.push(`avatar_url = $${params.length}`);
    }
    sets.push('updated_at = NOW()');

    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);

    // ★必须清缓存：GET /profile 走 Redis 缓存（TTL 5 分钟），清库不会让用户看到新昵称
    try {
      await clearUserCache(user.id);
    } catch (cacheErr) {
      logger.warn('[admin/users] clearUserCache failed (ignored)', {
        targetUserId: user.id,
        error: cacheErr?.message,
      });
    }

    const clip = (value, max = 60) => {
      const s = value == null ? '' : String(value);
      return s.length > max ? `${s.slice(0, max)}…` : s;
    };

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.profile_moderation',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        reason,
        nicknameFrom: clip(user.nickname),
        nicknameTo: cleanNickname === null ? '(未改动)' : clip(cleanNickname),
        avatarChanged: cleanAvatar !== null,
        avatarCleared: clearAvatar,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    // 用户可见的内容被改了，告知一声（否则最典型的追问就是"我昵称怎么变了"）
    try {
      await sendNotification(user.id, {
        notificationType: 'security_notice',
        title: '你的资料已被管理员调整',
        body: '你的昵称或头像因违反社区规范已被管理员调整。如有疑问请联系客服。',
        data: { fields: cleanNickname !== null ? ['nickname'] : [], avatar: cleanAvatar !== null },
      });
    } catch (notifyErr) {
      logger.warn('[admin/users] profile moderation notify failed (ignored)', {
        targetUserId: user.id,
        error: notifyErr?.message,
      });
    }

    logger.info('[admin/users] profile moderated', {
      targetUserId: user.id,
      nicknameChanged: cleanNickname !== null,
      avatarChanged: cleanAvatar !== null,
      operator: req.user?.userId,
    });

    const refreshed = await fetchUserById(user.id);
    return res.json({
      code: 0,
      data: mapUserRow(refreshed || user),
      message: cleanNickname !== null && cleanAvatar !== null
        ? '昵称与头像已处置'
        : cleanNickname !== null
          ? '昵称已处置'
          : clearAvatar
            ? '头像已清空'
            : '头像已更新',
    });
  } catch (err) {
    logger.error('[admin/users] profile moderation failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '资料处置失败' });
  }
});

/**
 * POST /api/admin/users/:id/reset-password  body { reason }
 * 管理员代重置密码（2026-10-05 新增）—— 用户**手机+邮箱双失效**时的唯一救援路径。
 *
 * 为什么之前只能改库：`routes/admin/` 里没有任何 `password_hash` 写路径，而用户侧的自助重置
 * 全都要验证码或旧密码。于是「收不到验证码」就等于**账号永久锁死**，客服没有任何办法。
 *
 * 口径：
 *   - 临时密码**只在本次响应里出现一次**，绝不写审计、不写日志（调用方自行安全转达）；
 *   - 同时**吊销该用户全部活跃会话**（否则旧会话还活着，重置等于没做）；
 *   - 越级防护复用 targetLevelGuardError：不得重置**自己**或等级不低于自己的用户
 *     （否则 admin 可以一步接管 super_admin 账号）；原因必填，写审计只记目标用户与原因，
 *     **不记凭据**。
 *
 * 实现复用 `services/userPasswordReset.js` —— 与 AI 工具 `reset_user_password` 同一份代码
 *（那份此前**没有**吊销会话，本次顺带补齐）。
 */
router.post('/:id/reset-password', requirePerm('admin.users.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '重置密码必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }

    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const { tempPassword, sessionsRevoked } = await resetUserPassword(user.id);

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.reset_password',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        reason,
        sessionsRevoked,
        // 刻意不写密码/哈希：审计要能看出"谁给谁重置了"，但绝不能成为凭据的第二份副本
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/users] password reset', {
      targetUserId: user.id,
      sessionsRevoked,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: { id: user.id, temporaryPassword: tempPassword, sessionsRevoked },
      message: '密码已重置。临时密码只在本次响应出现，请立即安全转达用户，并提示其登录后修改密码',
    });
  } catch (err) {
    logger.error('[admin/users] reset password failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '重置密码失败' });
  }
});

/**
 * POST /api/admin/users/:id/notify  body { title, body, notificationType? }
 * 对**单个用户**定向通知（2026-10-05 新增）。
 *
 * 为什么需要它：管理台此前只有「公告下发」，而公告受众只有 all / pro_plus / free
 * 三个**群体** —— 想只告知一个人（客服跟进、误发权益的说明、风控提醒）此前只能改库
 * 往 notification_history 插行，或者对全体广播。通道本身早就有了
 *（ws/server.js 的 sendNotification = WS 实时推 + 落 notification_history），只差一个入口。
 *
 * 权限刻意用 admin.announce.send（"公告与通知下发"）而不是本文件其它路由的
 * admin.users.manage：这是**对外触达**类能力，与公告同类；只负责改用户资料的运营角色
 * 不该顺带拿到"私信任意用户"的能力。
 *
 * 两个刻意设计：
 *  ① notificationType 由服务端**白名单**给出，不让调用方自由填。四个取值都落在客户端
 *     已有的分类映射上（useNotifications.ts 的 typeToCategory 按 includes 匹配，未知类型
 *     兜底 'update'）⇒ **不需要客户端改代码**，还没升级的版本也能正确归类。
 *  ② 不检查 notification_preferences：那是**产品推送**的开关，不该屏蔽管理员/客服的
 *     直接告知（与站内其它通知刻意不同，故写明）。
 */
const NOTIFY_TYPES = new Set([
  'admin_message', // → 客户端分类 update（通用告知）
  'subscription_notice', // → subscription
  'device_notice', // → device
  'security_notice', // → security
]);

router.post('/:id/notify', requirePerm('admin.announce.send'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.body === 'string' ? body.body.trim() : '';
    const notificationType =
      body.notificationType === undefined || body.notificationType === null
        ? 'admin_message'
        : body.notificationType;

    if (!title || !content) {
      return res.status(400).json({ code: 4000, message: '通知标题与内容不能为空' });
    }
    if (title.length > 100) {
      return res.status(400).json({ code: 4000, message: '通知标题不能超过 100 字' });
    }
    if (content.length > 500) {
      return res.status(400).json({ code: 4000, message: '通知内容不能超过 500 字' });
    }
    if (!NOTIFY_TYPES.has(notificationType)) {
      return res.status(400).json({
        code: 4000,
        message: `notificationType 取值不合法（${[...NOTIFY_TYPES].join(' / ')}）`,
      });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }

    // 与公告下发同一条通道：落 notification_history + WS 实时推给该用户所有在线设备
    await sendNotification(user.id, {
      notificationType,
      title,
      body: content,
      data: { source: 'admin', sentBy: req.user?.userId ?? null },
    });

    const onlineDevices = getOnlineDeviceCount(user.id);

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.user.notify',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        notificationType,
        title,
        // 只留预览：审计要能看出"发了什么"，但不该把整篇正文塞进审计表
        bodyPreview: content.slice(0, 200),
        onlineDevices,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/users] notify sent', {
      targetUserId: user.id,
      notificationType,
      onlineDevices,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: { userId: user.id, notificationType, title, onlineDevices },
      // 如实说明触达情况：落库一定会成功，但对方当前可能一台设备都不在线
      message:
        onlineDevices > 0
          ? `已下发（${onlineDevices} 台在线设备已实时收到）`
          : '已下发（对方当前无在线设备，下次打开客户端即可在通知中心看到）',
    });
  } catch (err) {
    logger.error('[admin/users] notify failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '通知下发失败' });
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

// ───────────────────── AN-13 数据主体请求：用户数据导出 ─────────────────────

// 导出硬上限（大数据防护：分页拉取 + 截断，meta 中标注 total 与 exported）。
// 剪贴板正文 content_encrypted 两态（E2E 协议 v1，见 docs/plans/e2e-protocol.md §2）：
//   - metadata.e2e 存在 → 端到端加密密文，服务端无法解密；
//   - metadata.e2e 不存在 → 历史条目，正文为历史明文。
// 导出统一只含服务端可见的 content_preview 与元数据，不含任何解密能力
// （E2E 信封中的 wrapped key 须配合设备私钥才能解开，私钥永不离开客户端），meta 中注明。
const EXPORT_CLIPBOARD_LIMIT = 1000;
const EXPORT_ORDER_LIMIT = 500;
const EXPORT_AUDIT_LIMIT = 200;

/**
 * GET /api/admin/users/:id/export?reason=
 * 数据主体数据可携权导出（requirePerm admin.users.view + 越级防护）：
 * 打包资料（解密手机号/邮箱）/设备/订阅/订单/剪贴板元数据/相关审计为 JSON 下载；
 * reason 写入审计 admin.users.export（数据主体请求留痕）。
 */
router.get('/:id/export', requirePerm('admin.users.view'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '用户 ID 不合法' });
    }

    const user = await fetchUserById(id);
    if (!user) {
      return res.status(404).json({ code: 40404, message: '用户不存在' });
    }
    // 越级防护：不可导出同级/更高级账号（与停用/删除同口径）
    const guard = targetLevelGuardError(req, user);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    const reason = typeof req.query.reason === 'string' ? req.query.reason.trim() : '';

    // 1) 资料（可携权导出：解密后的手机号/邮箱仅写入本次响应体，不落日志明文）
    const profile = {
      id: user.id,
      phone: decryptField(user.phone_encrypted) || user.phone || null,
      email: decryptField(user.email_encrypted) || user.email || null,
      nickname: user.nickname || null,
      isActive: Boolean(user.is_active),
      registrationStatus: user.registration_status || 'approved',
      roleKey: user.role_key || null,
      deactivationReason: user.deactivation_reason || null,
      createdAt: formatDateTime(user.created_at),
    };

    // 2) 设备清单
    const { rows: deviceRows } = await pool.query(
      `SELECT id, device_name, device_type, platform, platform_version, is_online, last_seen_at
       FROM devices WHERE user_id = $1::uuid`,
      [id]
    );
    const devices = deviceRows.map((d) => ({
      id: d.id,
      name: d.device_name,
      type: d.device_type,
      platform: d.platform,
      osVersion: d.platform_version || null,
      isOnline: Boolean(d.is_online),
      lastSeenAt: formatDateTime(d.last_seen_at),
    }));

    // 3) 订阅（含历史订阅行）
    const { rows: subRows } = await pool.query(
      `SELECT us.id, us.status, us.billing_cycle, us.current_period_start, us.current_period_end,
              us.auto_renew, us.created_at, sp.name AS plan_name
       FROM user_subscriptions us
       LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1::uuid
       ORDER BY us.created_at DESC`,
      [id]
    );
    const subscriptions = subRows.map((s) => ({
      id: s.id,
      plan: s.plan_name || null,
      status: s.status,
      billingCycle: s.billing_cycle || null,
      currentPeriodStart: formatDateTime(s.current_period_start),
      currentPeriodEnd: formatDateTime(s.current_period_end),
      autoRenew: Boolean(s.auto_renew),
      createdAt: formatDateTime(s.created_at),
    }));

    // 4) 订单（上限内全量，超出截断）
    const { rows: orderTotalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM payment_orders WHERE user_id = $1::uuid`,
      [id]
    );
    const { rows: orderRows } = await pool.query(
      `SELECT id, order_no, amount, currency, payment_method, status, paid_at, created_at
       FROM payment_orders WHERE user_id = $1::uuid
       ORDER BY created_at DESC LIMIT ${EXPORT_ORDER_LIMIT}`,
      [id]
    );
    const ordersTotal = orderTotalRows[0] ? Number(orderTotalRows[0].total) : 0;
    const orders = orderRows.map((o) => ({
      id: o.id,
      orderNo: o.order_no,
      amount: Number(o.amount),
      currency: o.currency || 'CNY',
      paymentMethod: o.payment_method || null,
      status: o.status,
      paidAt: formatDateTime(o.paid_at),
      createdAt: formatDateTime(o.created_at),
    }));

    // 5) 剪贴板条目元数据（不含正文 content_encrypted；E2E 条目 preview 为占位串 [E2E]，meta 注明）
    const { rows: clipTotalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM clipboard_items WHERE user_id = $1::uuid`,
      [id]
    );
    const { rows: clipRows } = await pool.query(
      `SELECT id, content_type, content_preview, content_size, metadata, is_favorite, created_at, updated_at
       FROM clipboard_items WHERE user_id = $1::uuid
       ORDER BY created_at DESC LIMIT ${EXPORT_CLIPBOARD_LIMIT}`,
      [id]
    );
    const clipboardTotal = clipTotalRows[0] ? Number(clipTotalRows[0].total) : 0;
    const clipboardItems = clipRows.map((c) => ({
      id: c.id,
      contentType: c.content_type,
      preview: c.content_preview || '',
      size: Number(c.content_size) || 0,
      isFavorite: Boolean(c.is_favorite),
      // metadata 原样导出：E2E 条目内含信封（epk/iv/keys wrapped key），仅密钥封装材料，无解密能力
      metadata: c.metadata ?? {},
      createdAt: formatDateTime(c.created_at),
      updatedAt: formatDateTime(c.updated_at),
    }));

    // 6) 该用户相关审计日志（上限内全量，超出截断）
    const { rows: auditTotalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_logs WHERE user_id = $1::uuid`,
      [id]
    );
    const { rows: auditRows } = await pool.query(
      `SELECT id, action, resource_type, resource_id, details, ip_address, status, created_at
       FROM audit_logs WHERE user_id = $1::uuid
       ORDER BY created_at DESC LIMIT ${EXPORT_AUDIT_LIMIT}`,
      [id]
    );
    const auditTotal = auditTotalRows[0] ? Number(auditTotalRows[0].total) : 0;
    const auditLogs = auditRows.map((a) => ({
      id: a.id,
      action: a.action,
      resourceType: a.resource_type || '',
      resourceId: a.resource_id ? String(a.resource_id) : '',
      details: serializeDetails(a.details),
      ipAddress: a.ip_address ? String(a.ip_address) : '',
      status: a.status,
      createdAt: formatDateTime(a.created_at),
    }));

    const payload = {
      meta: {
        exportedAt: new Date().toISOString(),
        requestedBy: req.user?.userId ?? null,
        reason: reason || '未填写',
        notes:
          '剪贴板正文 content_encrypted 不在导出范围内：metadata.e2e 存在的条目为端到端加密密文（服务端不可解密），历史条目（metadata.e2e 不存在）为历史明文；导出统一仅含服务端可见的预览与元数据，不含任何解密能力；各数据域超出上限部分已截断（total 为库中总量）。',
        limits: {
          clipboardItems: EXPORT_CLIPBOARD_LIMIT,
          orders: EXPORT_ORDER_LIMIT,
          auditLogs: EXPORT_AUDIT_LIMIT,
        },
        counts: {
          clipboardItems: { exported: clipboardItems.length, total: clipboardTotal },
          orders: { exported: orders.length, total: ordersTotal },
          auditLogs: { exported: auditLogs.length, total: auditTotal },
        },
      },
      profile,
      devices,
      subscriptions,
      orders,
      clipboardItems,
      auditLogs,
    };

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.users.export',
      resourceType: 'user',
      resourceId: String(user.id),
      details: {
        targetUserId: user.id,
        nickname: user.nickname || '',
        reason: reason || '未填写',
        clipboardItemsExported: clipboardItems.length,
        ordersExported: orders.length,
        auditLogsExported: auditLogs.length,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    // JSON 附件下载（非 { code, data } 壳——导出产物直接是数据文件）
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clipsync-user-export-${id}.json"`
    );
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    logger.error('[admin/users] export failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '导出用户数据失败' });
  }
});

export default router;

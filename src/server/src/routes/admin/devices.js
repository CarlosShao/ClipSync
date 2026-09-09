// =============================================
// Admin Console · 设备管理 APIs（Admin Console · T-A1.5 补票）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/devices', devicesRouter)
//     → GET  /api/admin/devices/stats          设备页头统计（总数/在线数/平台分布）
//     → GET  /api/admin/devices                设备分页列表（q / platform / status）
//     → POST /api/admin/devices/:id/offline    远程下线  body { reason }（原因必填）
//
//   注意与前端契约一致：远程下线用 POST /devices/:id/offline 而非 DELETE /devices/:id
//   —— 下线是状态变更（设备记录保留），非删除资源（types.ts DeviceOfflinePayload 注释口径）。
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：POST /:id/offline → requirePerm('admin.devices.manage')；
//   GET 列表/统计仅要求 requireRole(50) 门槛（权限目录中无 devices.view 权限点）。
//
// 响应契约（src/admin-console/src/api/types.ts 逐字段对齐）：
//   AdminDevice：id/name/platform/kind/os/appVersion/ownerId/ownerNickname/ownerPhone/
//                lastActiveAt/status
//   DeviceStats：{ total, online, byPlatform: [{ platform, count }] }
// =============================================

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { forceDisconnectDevice } from '../../ws/server.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 设备行查询（列表/下线回读共用）：JOIN users 取属主摘要
const DEVICE_SELECT = `
  SELECT
    d.id,
    d.device_name,
    d.device_type,
    d.platform,
    d.platform_version,
    d.app_version,
    d.is_online,
    d.last_seen_at,
    u.id AS owner_id,
    u.nickname AS owner_nickname,
    u.phone AS owner_phone
  FROM devices d
  JOIN users u ON u.id = d.user_id`;

/** 手机号打码：138****2765（与 routes/admin/orders.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** timestamptz → 'YYYY-MM-DD HH:mm'（AdminDevice.lastActiveAt 契约形态） */
function formatMinute(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** DB 行 → 前端 AdminDevice 契约（kind = devices.device_type，os = platform_version） */
function mapDeviceRow(row) {
  return {
    id: row.id,
    name: row.device_name,
    platform: row.platform,
    kind: row.device_type,
    os: row.platform_version || '',
    appVersion: row.app_version || '',
    ownerId: row.owner_id,
    ownerNickname: row.owner_nickname || '',
    ownerPhone: maskPhone(row.owner_phone),
    lastActiveAt: formatMinute(row.last_seen_at),
    status: row.is_online ? 'online' : 'offline',
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
 * 组装设备列表 WHERE。
 * q：设备名 ILIKE / 属主昵称 ILIKE / 纯数字关键词 → 属主手机号后 4 位精确
 * platform：d.platform 等值（windows/macos/linux/ios/android/browser；
 *   ipados/web 为前端扩展位，DB 不落该值，等值过滤自然返回空集）
 * status：online → is_online=TRUE；offline → FALSE
 * @returns {{ whereSql: string, params: any[] } | null} null 表示筛选参数非法（调用方 400）
 */
function buildDeviceFilters(query, params) {
  const where = [];
  const { q, platform, status } = query;

  const keyword = typeof q === 'string' ? q.trim() : '';
  if (keyword) {
    const parts = [];
    params.push(`%${keyword}%`);
    const likeIdx = params.length;
    parts.push(`d.device_name ILIKE $${likeIdx}`);
    parts.push(`u.nickname ILIKE $${likeIdx}`);
    if (/^\+?\d{4,}$/.test(keyword)) {
      params.push(keyword.slice(-4));
      parts.push(`RIGHT(u.phone, 4) = $${params.length}`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  if (platform && platform !== 'all') {
    params.push(String(platform));
    where.push(`d.platform = $${params.length}`);
  }

  if (status && status !== 'all') {
    if (status === 'online') {
      where.push('d.is_online = TRUE');
    } else if (status === 'offline') {
      where.push('d.is_online = FALSE');
    } else {
      return null;
    }
  }

  return { whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

// ───────────────────────── 设备统计 ─────────────────────────

/**
 * GET /api/admin/devices/stats
 * 设备页头统计：总数 / 在线数 / 平台分布（count 之和 = total）。
 * RB-06：读侧细粒度权限 requirePerm('admin.devices.view')。
 */
router.get('/stats', requirePerm('admin.devices.view'), async (req, res) => {
  try {
    const { rows: totals } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE is_online)::int AS online
      FROM devices`);
    const { rows: platformRows } = await pool.query(`
      SELECT platform, COUNT(*)::int AS count
      FROM devices
      GROUP BY platform
      ORDER BY count DESC, platform`);

    const total = totals[0] ? Number(totals[0].total) : 0;
    const online = totals[0] ? Number(totals[0].online) : 0;

    return res.json({
      code: 0,
      data: {
        total,
        online,
        byPlatform: platformRows.map((r) => ({ platform: r.platform, count: Number(r.count) })),
      },
    });
  } catch (err) {
    logger.error('[admin/devices] stats failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取设备统计失败' });
  }
});

// ───────────────────────── 设备列表 ─────────────────────────

/**
 * GET /api/admin/devices?page=&pageSize=&q=&platform=&status=
 * 设备分页列表（设备名/属主关键词 + 平台/在线状态筛选），按最近活跃倒序。
 * RB-06：读侧细粒度权限 requirePerm('admin.devices.view')（与 /stats 一致）。
 */
router.get('/', requirePerm('admin.devices.view'), async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const params = [];
    const filters = buildDeviceFilters(req.query, params);
    if (!filters) {
      return res.status(400).json({ code: 4000, message: '筛选参数不合法' });
    }

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM devices d
       JOIN users u ON u.id = d.user_id${filters.whereSql}`,
      filters.params
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `${DEVICE_SELECT}${filters.whereSql} ORDER BY d.last_seen_at DESC NULLS LAST LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, pageSize, offset]
    );

    return res.json({ code: 0, data: { list: rows.map(mapDeviceRow), total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/devices] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取设备列表失败' });
  }
});

// ───────────────────────── 密钥摘要（AF-43 / RB-02）─────────────────────────

/**
 * GET /api/admin/devices/:id/keys
 * 设备公钥脱敏摘要（requirePerm('admin.keys.view')，RB-02 承载端点）：
 *  - 仅返回公钥 SHA-256 指纹（前 16 位 hex），严禁返回公钥原文或任何私钥；
 *  - 无 public_key 的设备返回 { hasPublicKey: false, fingerprint: null }；
 *  - 查看动作写审计 admin.device.keys_view（敏感信息访问）。
 */
router.get('/:id/keys', requirePerm('admin.keys.view'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '设备 ID 不合法' });
    }

    const { rows } = await pool.query(
      `SELECT d.id, d.device_name, d.public_key
       FROM devices d WHERE d.id::text = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '设备不存在' });
    }
    const device = rows[0];

    const publicKey = typeof device.public_key === 'string' ? device.public_key : '';
    const hasPublicKey = publicKey.length > 0;
    const fingerprint = hasPublicKey
      ? createHash('sha256').update(publicKey, 'utf8').digest('hex').slice(0, 16)
      : null;

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.device.keys_view',
      resourceType: 'device',
      resourceId: String(device.id),
      details: {
        device: device.device_name,
        hasPublicKey,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/devices] device keys viewed', {
      deviceId: device.id,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: {
        deviceId: device.id,
        hasPublicKey,
        fingerprint,
      },
    });
  } catch (err) {
    logger.error('[admin/devices] keys view failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取设备密钥摘要失败' });
  }
});

// ───────────────────────── 远程下线 ─────────────────────────

/**
 * POST /api/admin/devices/:id/offline  body { reason }
 * 远程下线（requirePerm('admin.devices.manage')）：
 *  - 仅在线设备可下线（离线设备重复下线无意义，400 拦截）；
 *  - 原因必填，写审计 admin.device.offline（敏感）；
 *  - 落库口径：is_online=false + last_seen_at=NOW()；
 *  - AF-41：同时对该设备活跃 WS 连接推送 force_logout 并以 4003 断开，
 *    客户端清除登录态回登录页（重新登录即恢复），不再是"仅改标志位"。
 */
router.post('/:id/offline', requirePerm('admin.devices.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '设备 ID 不合法' });
    }
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '远程下线必须填写原因（写入审计日志）' });
    }

    const { rows } = await pool.query(`${DEVICE_SELECT} WHERE d.id::text = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '设备不存在' });
    }
    const device = rows[0];
    if (!device.is_online) {
      return res.status(400).json({ code: 40005, message: '仅在线设备可执行远程下线' });
    }

    await pool.query(
      `UPDATE devices SET is_online = FALSE, last_seen_at = NOW() WHERE id = $1`,
      [device.id]
    );

    // AF-41：真实下线——立即断开该设备的活跃 WS 连接并推送 force_logout，
    // 客户端清除本地登录态回登录页（重新登录即重新信任设备）。连接未找到（客户端
    // 恰好掉线）也不影响：is_online=false + 心跳超时扫描保证状态最终一致。
    let wsKicked = false;
    try {
      wsKicked = forceDisconnectDevice(device.owner_id, device.id, reason);
    } catch (err) {
      logger.warn('[admin/devices] force disconnect failed', { error: err.message });
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.device.offline',
      resourceType: 'device',
      resourceId: String(device.id),
      details: {
        device: device.device_name,
        owner: device.owner_nickname || '',
        ownerId: device.owner_id,
        reason,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/devices] device offline executed', {
      deviceId: device.id,
      wsKicked,
      operator: req.user?.userId,
    });

    const { rows: updatedRows } = await pool.query(`${DEVICE_SELECT} WHERE d.id::text = $1`, [id]);
    return res.json({
      code: 0,
      data: mapDeviceRow(updatedRows[0] || device),
      message: '设备已远程下线',
    });
  } catch (err) {
    logger.error('[admin/devices] offline failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '远程下线失败' });
  }
});

export default router;

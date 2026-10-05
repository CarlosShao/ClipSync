// =============================================
// Admin Console · 设备管理 APIs（Admin Console · T-A1.5 补票）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/devices', devicesRouter)
//     → GET  /api/admin/devices/stats          设备页头统计（总数/在线数/平台分布）
//     → GET  /api/admin/devices                设备分页列表（q / platform / status）
//     → POST /api/admin/devices/:id/offline    远程下线  body { reason }（原因必填）
//     → DELETE /api/admin/devices/:id          强制解绑  body { reason, confirmItemCount? }
//                                              （2026-10-05 新增；会连带删除该设备产生的内容，
//                                                故条数 > 0 时必须回传确认，详见该路由注释）
//
//   注意与前端契约一致：远程下线用 POST /devices/:id/offline 而非 DELETE /devices/:id
//   —— 下线是状态变更（设备记录保留），非删除资源（types.ts DeviceOfflinePayload 注释口径）。
//   解绑**确实是**删除资源，故用 DELETE；两者不是同一件事：
//   下线保留设备行（仍占 max_devices 名额），解绑移除设备行（释放名额）。
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
import { broadcastToUser, forceDisconnectDevice, sendNotification } from '../../ws/server.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 设备行查询（列表/下线/解绑回读共用）：JOIN users 取属主摘要，LEFT JOIN roles 取属主等级
// （解绑要做越级防护）
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
    u.phone AS owner_phone,
    r.level AS owner_role_level
  FROM devices d
  JOIN users u ON u.id = d.user_id
  LEFT JOIN roles r ON r.id = u.role_id`;

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

/**
 * 越级防护（与 admin/users.js 的 targetLevelGuardError 同口径）：
 * 不得解绑**自己**或等级不低于自己的用户的设备 —— 否则 admin 可以一步把超管的
 * 所有设备踢掉，而解绑还会连带删除那些设备产生的内容。
 */
function deviceOwnerLevelGuardError(req, device) {
  const operatorLevel = typeof req.user?.roleLevel === 'number' ? req.user.roleLevel : 0;
  const ownerLevel = Number.isFinite(Number(device.owner_role_level))
    ? Number(device.owner_role_level)
    : 10;
  if (ownerLevel >= operatorLevel) {
    return {
      status: 403,
      body: {
        code: 40302,
        message: `越级防护：设备属主角色等级(${ownerLevel})不低于操作者(${operatorLevel})，禁止解绑该设备`,
      },
    };
  }
  return null;
}

/**
 * DELETE /api/admin/devices/:id  body { reason, confirmItemCount? }
 * 强制解绑设备（2026-10-05 新增）。
 *
 * 为什么要它（与「远程下线」的区别）：
 *   - 下线只把 `is_online` 置 false + 踢 WS，**设备行还在**，仍占 `max_devices` 名额；
 *   - 解绑是**真正移除设备行**：释放名额（`middleware/subscriptionCheck.js` 就是按
 *     `COUNT(*) FROM devices WHERE user_id = $1` 算名额的），并连带清掉该设备的密钥。
 *   权限目录里早就写着「远程下线 / 解绑」，但此前只有下线 —— 文案与能力不相称。
 *
 * ⚠️ 解绑会**连带删除该设备产生的剪贴板内容**，这是数据库层面的既定行为。
 * 生产库实测（2026-10-05）：`clipboard_items_source_device_id_fkey ... ON DELETE CASCADE`，
 * 另有 `encryption_keys` / `device_sync_state` 同为 CASCADE、`file_versions` 为 SET NULL。
 * 用户侧自助解绑（`routes/device.js` 的 `DELETE /:deviceId`）一直是这个语义且**不提示**，
 * 用户不会知道自己丢了内容。管理台**不能也这样**：
 *   - 先数出将被删除的条数；
 *   - **条数 > 0 时必须把条数回传确认**（`confirmItemCount`），否则 409 并引导改用「远程下线」。
 *     这既让"随手点一下毁掉内容"不可能发生，也天然防住"计数与执行之间条数变了"的竞态
 *    （条数对不上就拒，不会按旧计数删）。
 *
 * 其余口径：
 *   - 越级防护见 deviceOwnerLevelGuardError；原因必填（≤200 字）；审计 `admin.device.unbind`
 *     记被删条数；
 *   - 与用户侧一致地广播 `device_removed` + `forceDisconnectDevice`：否则已解绑设备仍留在
 *     连接表里继续接收该用户全部剪贴板广播（2026-10-04 审计 S1-4 修的就是这个洞）；
 *   - 通知设备属主：设备消失且内容被删，他有权知道，否则只会看到"我的记录不见了"。
 */
router.delete('/:id', requirePerm('admin.devices.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '设备 ID 不合法' });
    }
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '解绑必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const { rows } = await pool.query(`${DEVICE_SELECT} WHERE d.id::text = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '设备不存在' });
    }
    const device = rows[0];

    const guard = deviceOwnerLevelGuardError(req, device);
    if (guard) {
      return res.status(guard.status).json(guard.body);
    }

    // ★先数清楚会连带删掉多少内容
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM clipboard_items WHERE source_device_id = $1`,
      [device.id]
    );
    const itemCount = Number(countRows[0]?.n) || 0;

    const rawConfirm = body.confirmItemCount;
    const confirmItemCount =
      rawConfirm === undefined || rawConfirm === null || rawConfirm === '' ? null : Number(rawConfirm);
    if (itemCount > 0 && confirmItemCount !== itemCount) {
      logger.warn('[admin/devices] unbind blocked pending content confirmation', {
        deviceId: device.id,
        itemCount,
        providerConfirm: confirmItemCount,
        operator: req.user?.userId,
      });
      return res.status(409).json({
        code: 40906,
        reason: 'CONTENT_WILL_BE_DELETED',
        itemCount,
        message: `解绑会连带删除该设备产生的 ${itemCount} 条剪贴板内容（外键 CASCADE，不可恢复）。确认后请带上 confirmItemCount: ${itemCount} 重试；若只想让它下线并保留内容，请改用「远程下线」`,
      });
    }

    const { rows: deletedRows } = await pool.query(
      `DELETE FROM devices WHERE id = $1 RETURNING id`,
      [device.id]
    );
    if (deletedRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '设备不存在（可能已被删除）' });
    }

    // 与用户侧 DELETE /api/devices/:deviceId 同一套收尾
    let wsKicked = false;
    try {
      broadcastToUser(device.owner_id, { type: 'device_removed', deviceId: device.id });
      wsKicked = forceDisconnectDevice(device.owner_id, device.id, 'device_unbound_by_admin');
    } catch (err) {
      logger.warn('[admin/devices] unbind broadcast/disconnect failed', { error: err.message });
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.device.unbind',
      resourceType: 'device',
      resourceId: String(device.id),
      details: {
        device: device.device_name,
        platform: device.platform,
        owner: device.owner_nickname || '',
        ownerId: device.owner_id,
        reason,
        // 留痕：这次解绑连带删掉了多少内容（事后追责/申诉都靠它）
        removedItems: itemCount,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    try {
      await sendNotification(device.owner_id, {
        notificationType: 'device_notice',
        title: '一个设备已被管理员解绑',
        body:
          itemCount > 0
            ? `设备「${device.device_name}」已被管理员解绑，其产生的 ${itemCount} 条内容同时被删除。如有疑问请联系客服。`
            : `设备「${device.device_name}」已被管理员解绑，需要时在客户端重新登录即可重新绑定。`,
        data: { deviceId: device.id, removedItems: itemCount },
      });
    } catch (notifyErr) {
      logger.warn('[admin/devices] unbind notify failed (ignored)', {
        deviceId: device.id,
        error: notifyErr?.message,
      });
    }

    logger.info('[admin/devices] device unbound', {
      deviceId: device.id,
      removedItems: itemCount,
      wsKicked,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: {
        id: device.id,
        name: device.device_name,
        removedItems: itemCount,
        wsKicked,
      },
      message:
        itemCount > 0
          ? `设备已解绑（同时删除该设备产生的 ${itemCount} 条内容）`
          : '设备已解绑',
    });
  } catch (err) {
    logger.error('[admin/devices] unbind failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '解绑设备失败' });
  }
});

export default router;

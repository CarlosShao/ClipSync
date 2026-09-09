// =============================================
// Admin Console · 邮件通道管理（AN-16 方案 A）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/email-channels', emailChannelsRouter)
//     → GET    /api/admin/email-channels          通道列表（password 脱敏为 has_password）
//     → POST   /api/admin/email-channels          新建通道（password 加密落库）
//     → PATCH  /api/admin/email-channels/:id      编辑（含启停/改密/调优先级）
//     → DELETE /api/admin/email-channels/:id      删除通道
//     → POST   /api/admin/email-channels/:id/test 发送测试邮件（指定通道）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件细粒度权限：全部端点 requirePerm('admin.email_channels.manage')
//   （059 迁移新增该键，仅授予 super_admin；roles.js PERM_CATALOG 未登记，
//   权限页不出现该键，属仅超管的运维能力，与 admin.ops.view 同策略）
//
// 语义契约：
//   - purpose 仅 'transactional' | 'marketing'；provider 仅 'smtp'（aliyun_dm/sendgrid
//     预留枚举未实现，POST/PATCH 传非 smtp → 400）
//   - host/name 必填；port 1-65535；priority 整数（越小越优先，发送失败按序降级）
//   - password 永不回传（GET 返回 has_password 布尔）；PATCH 传空/缺省 = 保持不变
//   - provider='smtp' 时 username/password 建议齐全（缺则发送走 console 兜底，
//     测试接口返回 4090 提示）
//   - 审计：admin.email_channel.create/update/delete/test
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { encryptField } from '../../utils/encryption.js';
import { logAuditEvent } from '../../utils/audit.js';
import { sendTestMail } from '../../utils/email.js';

const router = Router();

// AN-16：purpose/provider 白名单（与 email_channels CHECK 约束一致）
const PURPOSES = new Set(['transactional', 'marketing']);
const PROVIDERS = new Set(['smtp', 'aliyun_dm', 'sendgrid']);
const IMPLEMENTED_PROVIDERS = new Set(['smtp']); // AN-16：本期仅实现 smtp，其余预留枚举

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** timestamptz → 'YYYY-MM-DD HH:mm'（与 configs.js formatDateTimeMinute 同口径） */
function formatDateTimeMinute(value) {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * DB 通道行 → 前端契约（EmailChannel，见 admin-console/src/api/emailChannels.ts）：
 * password 只回 has_password 布尔，永不回传密文（与 smtp_pass 脱敏同策略，CO-30）
 */
function mapChannelRow(row) {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    provider: row.provider,
    host: row.host,
    port: Number(row.port),
    secure: Boolean(row.secure),
    username: row.username ?? '',
    has_password: Boolean(row.password),
    from_addr: row.from_addr ?? '',
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    created_at: formatDateTimeMinute(row.created_at),
    updated_at: formatDateTimeMinute(row.updated_at),
  };
}

/** 单值文本入参归一：undefined/null → 缺省标记，其余 trim 后返回 */
function pickText(v) {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

/**
 * 校验并归一通道写入载荷（POST/PATCH 共用）。
 * 返回 { ok: true, fields } 或 { ok: false, message }；
 * 仅收集载荷中显式出现的键（PATCH 部分更新语义；password 缺省/空 = 保持不变）。
 */
function normalizePayload(body, { requireCore }) {
  const fields = {};

  const name = pickText(body.name);
  if (name !== undefined) {
    if (!name) return { ok: false, message: '通道名称不能为空' };
    if (name.length > 100) return { ok: false, message: '通道名称最长 100 字符' };
    fields.name = name;
  } else if (requireCore) {
    return { ok: false, message: '通道名称不能为空' };
  }

  const purpose = pickText(body.purpose);
  if (purpose !== undefined) {
    if (!PURPOSES.has(purpose)) return { ok: false, message: 'purpose 仅允许 transactional / marketing' };
    fields.purpose = purpose;
  } else if (requireCore) {
    fields.purpose = 'transactional';
  }

  const provider = pickText(body.provider);
  if (provider !== undefined) {
    if (!PROVIDERS.has(provider)) {
      return { ok: false, message: 'provider 仅允许 smtp / aliyun_dm / sendgrid（后两者预留未实现）' };
    }
    if (!IMPLEMENTED_PROVIDERS.has(provider)) {
      return { ok: false, message: '该 provider 尚未实现，当前仅支持 smtp' };
    }
    fields.provider = provider;
  } else if (requireCore) {
    fields.provider = 'smtp';
  }

  const host = pickText(body.host);
  if (host !== undefined) {
    if (!host) return { ok: false, message: 'SMTP 服务器地址不能为空' };
    if (host.length > 255) return { ok: false, message: 'SMTP 服务器地址过长' };
    fields.host = host;
  } else if (requireCore) {
    return { ok: false, message: 'SMTP 服务器地址不能为空' };
  }

  const port = body.port;
  if (port !== undefined && port !== null && port !== '') {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, message: 'port 须为 1-65535 的整数' };
    }
    fields.port = portNum;
  } else if (requireCore) {
    fields.port = 587;
  }

  if (body.secure !== undefined) {
    fields.secure = body.secure === true || body.secure === 'true';
  } else if (requireCore) {
    fields.secure = false;
  }

  const username = pickText(body.username);
  if (username !== undefined) fields.username = username;

  // AN-16：password 加密落库（AES-256-GCM，沿用 utils/encryption.js 与 smtp_pass 同主密钥）；
  // 空串/缺省 = 保持不变（部分更新时避免误清空），新建时空串按「未配置凭据」处理
  const password = typeof body.password === 'string' ? body.password : '';
  if (requireCore) {
    fields.password = password ? encryptField(password) : '';
  } else if (password) {
    fields.password = encryptField(password);
  }

  const fromAddr = pickText(body.from_addr);
  if (fromAddr !== undefined) {
    if (fromAddr && !EMAIL_RE.test(fromAddr)) {
      return { ok: false, message: '发件人地址格式不合法' };
    }
    fields.from_addr = fromAddr;
  }

  if (body.enabled !== undefined) {
    fields.enabled = body.enabled === true || body.enabled === 'true';
  }

  const priority = body.priority;
  if (priority !== undefined && priority !== null && priority !== '') {
    const priorityNum = Number(priority);
    if (!Number.isInteger(priorityNum) || priorityNum < 0) {
      return { ok: false, message: 'priority 须为 ≥0 的整数（越小越优先）' };
    }
    fields.priority = priorityNum;
  }

  return { ok: true, fields };
}

/**
 * 写审计（成功路径调用；details 不落密码明文/密文，仅记「已更新」占位）
 */
async function auditChannel(action, req, resourceId, details) {
  await logAuditEvent({
    userId: req.user?.userId,
    action,
    resourceType: 'email_channel',
    resourceId,
    details,
    ipAddress: req.ip,
    userAgent: req.headers ? req.headers['user-agent'] : undefined,
  });
}

// ───────────────────────── 通道列表 ─────────────────────────

/**
 * GET /api/admin/email-channels
 * 通道列表（purpose ASC + priority ASC 排序；password 脱敏为 has_password）。
 */
router.get('/', requirePerm('admin.email_channels.manage'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, purpose, provider, host, port, secure, username, password,
              from_addr, enabled, priority, created_at, updated_at
       FROM email_channels
       ORDER BY purpose ASC, priority ASC, created_at ASC`
    );
    return res.json({ code: 0, data: rows.map(mapChannelRow) });
  } catch (err) {
    logger.error('[admin/email-channels] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取邮件通道列表失败' });
  }
});

/**
 * POST /api/admin/email-channels  body { name, purpose?, provider?, host, port?, secure?,
 *                                        username?, password?, from_addr?, enabled?, priority? }
 * 新建通道（password 加密落库；审计 admin.email_channel.create）。
 */
router.post('/', requirePerm('admin.email_channels.manage'), async (req, res) => {
  try {
    const normalized = normalizePayload(req.body || {}, { requireCore: true });
    if (!normalized.ok) {
      return res.status(400).json({ code: 40002, message: normalized.message });
    }
    const f = normalized.fields;
    const { rows } = await pool.query(
      `INSERT INTO email_channels
         (name, purpose, provider, host, port, secure, username, password, from_addr, enabled, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, purpose, provider, host, port, secure, username, password,
                 from_addr, enabled, priority, created_at, updated_at`,
      [
        f.name, f.purpose, f.provider, f.host, f.port, f.secure,
        f.username ?? '', f.password ?? '', f.from_addr ?? '',
        f.enabled ?? true, f.priority ?? 10,
      ]
    );
    const row = rows[0];
    await auditChannel('admin.email_channel.create', req, row.id, {
      name: row.name,
      purpose: row.purpose,
      provider: row.provider,
      host: row.host,
      password: '***',
    });
    logger.info('[admin/email-channels] channel created', {
      id: row.id,
      operator: req.user?.userId,
    });
    return res.json({ code: 0, data: mapChannelRow(row), message: '邮件通道已创建' });
  } catch (err) {
    logger.error('[admin/email-channels] create failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '创建邮件通道失败' });
  }
});

/**
 * PATCH /api/admin/email-channels/:id
 * 部分更新通道（含启停 / 改密 / 调优先级；password 缺省/空 = 保持不变；
 * 审计 admin.email_channel.update，details 只记变更键名）。
 */
router.patch('/:id', requirePerm('admin.email_channels.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const normalized = normalizePayload(req.body || {}, { requireCore: false });
    if (!normalized.ok) {
      return res.status(400).json({ code: 40002, message: normalized.message });
    }
    const f = normalized.fields;
    if (Object.keys(f).length === 0) {
      return res.status(400).json({ code: 40002, message: '没有需要更新的字段' });
    }

    // 白名单拼 SET 子句（键名全部来自 normalizePayload 固定白名单，无注入面）
    const keys = Object.keys(f);
    const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const params = [id, ...keys.map((k) => f[k])];

    const { rows } = await pool.query(
      `UPDATE email_channels SET ${setSql}, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, purpose, provider, host, port, secure, username, password,
                 from_addr, enabled, priority, created_at, updated_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '邮件通道不存在' });
    }

    const changed = keys.includes('password') ? [...keys, 'password(已更新)'] : keys;
    await auditChannel('admin.email_channel.update', req, id, {
      changed,
      ...(keys.includes('enabled') ? { enabled: rows[0].enabled } : {}),
      ...(keys.includes('priority') ? { priority: rows[0].priority } : {}),
    });
    logger.info('[admin/email-channels] channel updated', {
      id,
      changed: keys,
      operator: req.user?.userId,
    });
    return res.json({ code: 0, data: mapChannelRow(rows[0]), message: '邮件通道已更新' });
  } catch (err) {
    logger.error('[admin/email-channels] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '更新邮件通道失败' });
  }
});

/**
 * DELETE /api/admin/email-channels/:id
 * 删除通道（审计 admin.email_channel.delete；删除后该用途发送自动顺延到
 * 剩余通道，全部通道删除时回退 legacy smtp_* / console 兜底）。
 */
router.delete('/:id', requirePerm('admin.email_channels.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `DELETE FROM email_channels WHERE id = $1
       RETURNING id, name, purpose`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '邮件通道不存在' });
    }
    // AN-16：删除原因（前端 ConfirmReasonModal 必填）写入审计
    const reason = pickText(req.body?.reason) || '';
    await auditChannel('admin.email_channel.delete', req, id, {
      name: rows[0].name,
      purpose: rows[0].purpose,
      ...(reason ? { reason } : {}),
    });
    logger.info('[admin/email-channels] channel deleted', {
      id,
      operator: req.user?.userId,
    });
    return res.json({ code: 0, data: { id: rows[0].id }, message: '邮件通道已删除' });
  } catch (err) {
    logger.error('[admin/email-channels] delete failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '删除邮件通道失败' });
  }
});

/**
 * POST /api/admin/email-channels/:id/test  body { to?: string }
 * 发送测试邮件（指定通道，不按用途路由、不降级）：
 *  - to 缺省取通道 username；两者皆空/格式非法 → 400 { code: 40002 }
 *  - 通道凭据不完整（username/password 缺）→ 409 { code: 4090 }
 *  - 成功/失败均写审计 admin.email_channel.test
 */
router.post('/:id/test', requirePerm('admin.email_channels.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, name, username FROM email_channels WHERE id = $1`,
      [id]
    );
    const channel = rows[0];
    if (!channel) {
      return res.status(404).json({ code: 40404, message: '邮件通道不存在' });
    }

    let to = pickText(req.body?.to) || '';
    if (!to) {
      to = channel.username || '';
    }
    if (!to || !EMAIL_RE.test(to)) {
      return res
        .status(400)
        .json({ code: 40002, message: '收件人邮箱无效（未传 to 且通道未配置 username）' });
    }

    const result = await sendTestMail(to, id);

    if (result.unconfigured) {
      return res
        .status(409)
        .json({ code: 4090, message: '该通道凭据不完整（缺少 username/password），无法发送' });
    }

    await auditChannel('admin.email_channel.test', req, id, {
      to,
      channelName: channel.name,
      success: result.success,
      error: result.error || undefined,
      messageId: result.messageId || undefined,
      failoverChannelId: result.channelId && result.channelId !== id ? result.channelId : undefined,
    });

    if (!result.success) {
      return res
        .status(500)
        .json({ code: 5000, message: `测试邮件发送失败：${result.error || '未知错误'}` });
    }

    logger.info('[admin/email-channels] test mail sent', {
      id,
      to,
      operator: req.user?.userId,
    });
    return res.json({
      code: 0,
      data: { to, messageId: result.messageId || null, channelName: channel.name },
      message: '测试邮件已发送',
    });
  } catch (err) {
    logger.error('[admin/email-channels] test failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '发送测试邮件失败' });
  }
});

export default router;

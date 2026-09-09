// =============================================
// Admin Console · 版本发布管理 API（AN-04）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/releases', releasesRouter)
//     → GET    /api/admin/releases           发布全量列表（含未发布草稿）
//     → POST   /api/admin/releases           新建版本
//     → PATCH  /api/admin/releases/:id       编辑 / 发布 / 撤回（is_published 切换即回滚）
//     → DELETE /api/admin/releases/:id       删除（body.reason 必填，写审计）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：全部端点 requirePerm('admin.release.manage')（065 迁移仅授 super_admin，原 061 撞号改 065）
//
// 消费方：routes/app.js 公开端点（/version、/update.json、/updates/latest）
//   — 按 is_published + published_at 取最新已发布版本，60s 进程内缓存。
//
// 响应契约：成功 { code: 0, data }；错误 { code, message }
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 语义化版本（宽松）：主.次.补丁，可带 prerelease 后缀
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** DB 行 → 前端版本对象（camelCase；platforms JSONB 由 pg 解析为对象直接透传） */
function mapReleaseRow(row) {
  return {
    id: row.id,
    version: row.version,
    name: row.name ?? '',
    releaseDate: row.release_date,
    notes: row.notes ?? '',
    platforms: row.platforms ?? {},
    forceUpdate: Boolean(row.force_update),
    rolloutPercent: row.rollout_percent,
    isPublished: Boolean(row.is_published),
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── 字段校验器：返回 { ok: true, value } 或 { ok: false, message } ──

function validateVersion(value) {
  if (typeof value !== 'string' || !VERSION_RE.test(value.trim())) {
    return { ok: false, message: '必须是语义化版本号（如 1.2.0）' };
  }
  return { ok: true, value: value.trim() };
}

function validateName(value) {
  if (typeof value !== 'string') return { ok: false, message: '必须为字符串' };
  const trimmed = value.trim();
  if (trimmed.length > 100) return { ok: false, message: '长度不能超过 100' };
  return { ok: true, value: trimmed };
}

function validateNullableDate(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: '必须是 YYYY-MM-DD 格式日期' };
  }
  return { ok: true, value };
}

function validateNotes(value) {
  if (typeof value !== 'string') return { ok: false, message: '必须为字符串' };
  if (value.length > 10000) return { ok: false, message: '长度不能超过 10000' };
  return { ok: true, value };
}

/**
 * platforms JSONB 校验：接受对象或 JSON 字符串。
 * 结构 { "<target>": { url, signature? } }；每个 url 必须是 http(s) 绝对地址。
 */
function validatePlatforms(value) {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: 'platforms 必须是合法的 JSON 对象' };
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, message: 'platforms 必须是合法的 JSON 对象' };
  }
  for (const [target, entry] of Object.entries(candidate)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, message: `platforms.${target} 必须是对象` };
    }
    if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) {
      return { ok: false, message: `platforms.${target}.url 必须是 http(s) 地址` };
    }
  }
  return { ok: true, value: candidate };
}

function validateBoolean(value) {
  if (typeof value !== 'boolean') return { ok: false, message: '必须为布尔值' };
  return { ok: true, value };
}

function validateRollout(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 100) {
    return { ok: false, message: '必须是 0-100 的整数' };
  }
  return { ok: true, value: num };
}

// PATCH 白名单：field → 校验器（version 建单后不可改，防止公开端点语义漂移）
const FIELD_VALIDATORS = {
  name: validateName,
  release_date: validateNullableDate,
  notes: validateNotes,
  platforms: validatePlatforms,
  force_update: validateBoolean,
  rollout_percent: validateRollout,
  is_published: validateBoolean,
};

// ───────────────────────── 发布列表 ─────────────────────────

/**
 * GET /api/admin/releases
 * 发布全量列表（含未发布草稿，管理页需要完整视图），按创建时间倒序。
 * 返回 { code: 0, data: { list: Release[] } }。
 */
router.get('/', requirePerm('admin.release.manage'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM app_releases ORDER BY created_at DESC'
    );
    return res.json({ code: 0, data: { list: rows.map(mapReleaseRow) } });
  } catch (err) {
    logger.error('[admin/releases] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取发布列表失败' });
  }
});

// ───────────────────────── 新建版本 ─────────────────────────

/**
 * POST /api/admin/releases
 * 新建版本（默认未发布草稿；body 可直接带 is_published=true 一步发布）。
 * 写审计 admin.release.create。
 */
router.post('/', requirePerm('admin.release.manage'), async (req, res) => {
  try {
    const body = req.body || {};

    const versionResult = validateVersion(body.version);
    if (!versionResult.ok) {
      return res.status(400).json({ code: 4000, message: `version ${versionResult.message}` });
    }

    // 可选字段校验（缺省走默认值）
    const optional = {};
    for (const field of ['name', 'release_date', 'notes', 'platforms', 'force_update', 'rollout_percent', 'is_published']) {
      if (!(field in body)) continue;
      const result = FIELD_VALIDATORS[field](body[field]);
      if (!result.ok) {
        return res.status(400).json({ code: 4000, message: `${field} ${result.message}` });
      }
      optional[field] = result.value;
    }

    // 同版本号防重复（表级 UNIQUE 兜底，这里先给友好错误）
    const { rows: dupRows } = await pool.query(
      'SELECT id FROM app_releases WHERE version = $1',
      [versionResult.value]
    );
    if (dupRows.length > 0) {
      return res.status(409).json({ code: 4090, message: '该版本号已存在' });
    }

    const isPublished = optional.is_published === true;
    const { rows: inserted } = await pool.query(
      `INSERT INTO app_releases
         (version, name, release_date, notes, platforms, force_update, rollout_percent, is_published, published_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [
        versionResult.value,
        optional.name ?? '',
        optional.release_date ?? new Date().toISOString().slice(0, 10),
        optional.notes ?? '',
        JSON.stringify(optional.platforms ?? {}),
        optional.force_update ?? false,
        optional.rollout_percent ?? 100,
        isPublished,
        isPublished ? new Date() : null,
      ]
    );
    const created = inserted[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.release.create',
      resourceType: 'app_release',
      resourceId: created.id,
      details: { version: created.version, isPublished },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/releases] release created', {
      releaseId: created.id,
      version: created.version,
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: mapReleaseRow(created) });
  } catch (err) {
    logger.error('[admin/releases] create failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '版本创建失败' });
  }
});

// ───────────────────────── 编辑 / 发布 / 撤回 ─────────────────────────

/**
 * PATCH /api/admin/releases/:id
 * 部分字段更新（只更新 body 中出现的白名单字段）。
 * is_published false→true 视为「发布」（补 published_at）；true→false 视为「撤回/回滚」。
 * 写审计 admin.release.update（details 含逐字段变更值）。
 */
router.patch('/:id', requirePerm('admin.release.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '版本 ID 不合法' });
    }

    const body = req.body || {};

    const updates = []; // { column, value, isJsonb }
    const changes = {}; // 审计用：field → 新值
    for (const [field, validator] of Object.entries(FIELD_VALIDATORS)) {
      if (!(field in body)) continue;
      const result = validator(body[field]);
      if (!result.ok) {
        return res.status(400).json({ code: 4000, message: `${field} ${result.message}` });
      }
      updates.push({ column: field, value: result.value, isJsonb: field === 'platforms' });
      changes[field] = result.value;
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: 4000, message: '没有可更新的字段' });
    }

    const { rows: existRows } = await pool.query(
      'SELECT id, version, is_published FROM app_releases WHERE id = $1',
      [id]
    );
    if (existRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '版本不存在' });
    }
    const existing = existRows[0];

    // 发布/撤回状态切换时补/清 published_at（首次发布时间固定，撤回重发不覆盖）
    const publishTransition =
      'is_published' in changes && changes.is_published !== existing.is_published;
    if (publishTransition && changes.is_published === true && !existing.published_at) {
      updates.push({ column: 'published_at', value: new Date(), isJsonb: false });
      changes.published_at = 'now()';
    }

    const setSql = updates
      .map((u, i) => `${u.column} = $${i + 2}${u.isJsonb ? '::jsonb' : ''}`)
      .join(', ');
    const params = [
      id,
      ...updates.map((u) => (u.isJsonb ? JSON.stringify(u.value) : u.value)),
    ];

    const { rows: updatedRows } = await pool.query(
      `UPDATE app_releases SET ${setSql}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      params
    );
    const updated = updatedRows[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.release.update',
      resourceType: 'app_release',
      resourceId: id,
      details: { version: existing.version, changes },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/releases] release updated', {
      releaseId: id,
      version: existing.version,
      fields: Object.keys(changes),
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: mapReleaseRow(updated) });
  } catch (err) {
    logger.error('[admin/releases] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '版本更新失败' });
  }
});

// ───────────────────────── 删除 ─────────────────────────

/**
 * DELETE /api/admin/releases/:id
 * 删除版本（body.reason 必填，写入审计）。写审计 admin.release.delete。
 */
router.delete('/:id', requirePerm('admin.release.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '版本 ID 不合法' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '删除原因必填（写入审计日志）' });
    }

    const { rows: deletedRows } = await pool.query(
      'DELETE FROM app_releases WHERE id = $1 RETURNING id, version',
      [id]
    );
    if (deletedRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '版本不存在' });
    }
    const deleted = deletedRows[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.release.delete',
      resourceType: 'app_release',
      resourceId: id,
      details: { version: deleted.version, reason },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/releases] release deleted', {
      releaseId: id,
      version: deleted.version,
      reason,
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: { id } });
  } catch (err) {
    logger.error('[admin/releases] delete failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '版本删除失败' });
  }
});

export default router;

// =============================================
// Admin Console · 套餐管理 APIs（Admin Console · T-A3）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/plans', plansRouter)
//     → GET   /api/admin/plans      套餐全量列表（含停用，供管理）
//     → PATCH /api/admin/plans/:id  编辑套餐（高危）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：PATCH /:id → requirePerm('admin.plans.manage')
//
// 可编辑字段（PATCH body，snake_case 与工单一致）：
//   display_name / description / price_monthly / price_yearly /
//   max_devices / max_clipboard_items / max_file_size_mb / max_storage_mb /
//   features(JSONB，非法 JSON 400) / is_active
// 其余字段（name/created_at 等）不可改；空更新 400。
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

/** DB 行 → 前端套餐对象（camelCase；features JSONB 由 pg 解析为对象直接透传） */
function mapPlanRow(row) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description ?? '',
    priceMonthly: row.price_monthly != null ? Number(row.price_monthly) : null,
    priceYearly: row.price_yearly != null ? Number(row.price_yearly) : null,
    maxDevices: row.max_devices,
    maxClipboardItems: row.max_clipboard_items,
    maxFileSizeMb: row.max_file_size_mb,
    maxStorageMb: row.max_storage_mb,
    features: row.features ?? {},
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

// ── PATCH 字段校验器：返回 { ok: true, value } 或 { ok: false, message } ──

function validateStringField(value, { maxLen, allowEmpty = false }) {
  if (typeof value !== 'string') return { ok: false, message: '必须为字符串' };
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return { ok: false, message: '不能为空' };
  if (trimmed.length > maxLen) return { ok: false, message: `长度不能超过 ${maxLen}` };
  return { ok: true, value: trimmed };
}

function validateNullableString(value, maxLen) {
  if (value === null) return { ok: true, value: null };
  return validateStringField(value, { maxLen, allowEmpty: true });
}

function validatePrice(value) {
  if (value === null) return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 999999.99) {
    return { ok: false, message: '必须为 0-999999.99 的数字' };
  }
  return { ok: true, value: num };
}

function validateNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 1000000000) {
    return { ok: false, message: '必须为非负整数' };
  }
  return { ok: true, value: num };
}

function validateBoolean(value) {
  if (typeof value !== 'boolean') return { ok: false, message: '必须为布尔值' };
  return { ok: true, value };
}

/**
 * features JSONB 校验：接受对象（express json body 已解析）或 JSON 字符串
 * （字符串必须 JSON.parse 成功且结果为普通对象），否则 400。
 */
function validateFeatures(value) {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: 'features 必须是合法的 JSON 对象' };
    }
  }
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    return { ok: false, message: 'features 必须是合法的 JSON 对象' };
  }
  return { ok: true, value: candidate };
}

// PATCH 白名单：field → 校验器
const FIELD_VALIDATORS = {
  display_name: (v) => validateStringField(v, { maxLen: 100 }),
  description: (v) => validateNullableString(v, 1000),
  price_monthly: validatePrice,
  price_yearly: validatePrice,
  max_devices: validateNonNegativeInt,
  max_clipboard_items: validateNonNegativeInt,
  max_file_size_mb: validateNonNegativeInt,
  max_storage_mb: validateNonNegativeInt,
  is_active: validateBoolean,
  features: validateFeatures,
};

// ───────────────────────── 套餐列表 ─────────────────────────

/**
 * GET /api/admin/plans
 * 套餐全量列表（含 is_active=false 的停用套餐，管理页需要完整视图）。
 * 返回 { code: 0, data: { list: Plan[] } }（套餐数量有限，不做分页）。
 */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM subscription_plans ORDER BY price_monthly ASC NULLS LAST, created_at ASC'
    );
    return res.json({ code: 0, data: { list: rows.map(mapPlanRow) } });
  } catch (err) {
    logger.error('[admin/plans] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取套餐列表失败' });
  }
});

// ───────────────────────── 套餐编辑 ─────────────────────────

/**
 * PATCH /api/admin/plans/:id
 * 部分字段更新（只更新 body 中出现的白名单字段），写审计（details 含逐字段变更值）。
 */
router.patch('/:id', requirePerm('admin.plans.manage'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '套餐 ID 不合法' });
    }

    const body = req.body || {};

    // 逐字段校验并收集变更
    const updates = []; // { column, value }
    const changes = {}; // 审计用：field → 新值
    for (const [field, validator] of Object.entries(FIELD_VALIDATORS)) {
      if (!(field in body)) continue;
      const result = validator(body[field]);
      if (!result.ok) {
        return res.status(400).json({ code: 4000, message: `${field} ${result.message}` });
      }
      updates.push({ column: field, value: result.value });
      changes[field] = result.value;
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: 4000, message: '没有可更新的字段' });
    }

    const { rows: existRows } = await pool.query(
      'SELECT id, name, display_name FROM subscription_plans WHERE id = $1',
      [id]
    );
    if (existRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '套餐不存在' });
    }
    const existing = existRows[0];

    // features 为 JSONB 列：字符串化后由 pg 以 jsonb 字面量写入
    const setSql = updates
      .map((u, i) => `${u.column} = $${i + 2}${u.column === 'features' ? '::jsonb' : ''}`)
      .join(', ');
    const params = [
      id,
      ...updates.map((u) => (u.column === 'features' ? JSON.stringify(u.value) : u.value)),
    ];

    const { rows: updatedRows } = await pool.query(
      `UPDATE subscription_plans SET ${setSql} WHERE id = $1 RETURNING *`,
      params
    );
    const updated = updatedRows[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.plans.update',
      resourceType: 'subscription_plan',
      resourceId: id,
      details: {
        planName: existing.display_name || existing.name,
        changes,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/plans] plan updated', {
      planId: id,
      fields: Object.keys(changes),
      operator: req.user?.userId,
    });

    return res.json({ code: 0, data: mapPlanRow(updated) });
  } catch (err) {
    logger.error('[admin/plans] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '套餐更新失败' });
  }
});

export default router;

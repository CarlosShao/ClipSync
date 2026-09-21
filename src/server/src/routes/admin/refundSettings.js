// =============================================
// Admin Console · 退款策略配置（时限可配置）
//
// 挂载（routes/admin/index.js）：adminRouter.use('/refund-settings', refundSettingsRouter)
//   GET /api/admin/refund-settings → { code:0, data:{ windowDays, reviewBusinessDays } }
//   PUT /api/admin/refund-settings body { windowDays?, reviewBusinessDays? }
//
// 为什么不并进 routes/admin/configs.js：那份文件用 CONFIG_CATALOG 白名单管键，
// 未登记的键一律 40404；而本次要加的两个键属于「退款策略」而非通用系统配置，
// 且 configs.js 当前有并行改动（A4 短信）不宜再动。先例见 utils/runtimeLimits.js
// 与 utils/clientPolicies.js —— 它们同样直接读写 system_configs 而不进 CATALOG。
// 代价：这两个键不会出现在通用配置列表页里，只在退款审核页的那个小面板可见。
//
// 值沿用 system_configs 既有写法：to_jsonb(text)，读侧 Number() 归一
// （services/refundPolicy.js#getRefundSettings）。
// =============================================

import { Router } from 'express';
import pool from '../../db/pool.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../../utils/audit.js';
import {
  REFUND_CONFIG_KEYS,
  SELF_REFUND_WINDOW_DAYS,
  DEFAULT_REVIEW_BUSINESS_DAYS,
  clearRefundSettingsCache,
} from '../../services/refundPolicy.js';

const router = Router();

// 上下界是防呆而非安全边界：填 0 会让所有退款申请被拒，填 3650 等于放开闸门
const BOUNDS = {
  windowDays: { key: REFUND_CONFIG_KEYS.windowDays, min: 1, max: 365, fallback: SELF_REFUND_WINDOW_DAYS },
  reviewBusinessDays: {
    key: REFUND_CONFIG_KEYS.reviewBusinessDays,
    min: 1,
    max: 30,
    fallback: DEFAULT_REVIEW_BUSINESS_DAYS,
  },
};

function parseBound(field, raw) {
  const spec = BOUNDS[field];
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    return { error: `${field} 必须是 ${spec.min}~${spec.max} 之间的整数` };
  }
  return { value: n };
}

async function readCurrent() {
  const { rows } = await pool.query(
    'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
    [[BOUNDS.windowDays.key, BOUNDS.reviewBusinessDays.key]]
  );
  const byKey = new Map(rows.map((r) => [r.config_key, Number(r.config_value)]));
  return {
    windowDays: Number.isInteger(byKey.get(BOUNDS.windowDays.key))
      ? byKey.get(BOUNDS.windowDays.key)
      : SELF_REFUND_WINDOW_DAYS,
    reviewBusinessDays: Number.isInteger(byKey.get(BOUNDS.reviewBusinessDays.key))
      ? byKey.get(BOUNDS.reviewBusinessDays.key)
      : DEFAULT_REVIEW_BUSINESS_DAYS,
  };
}

router.get('/', requirePerm('admin.orders.view'), async (req, res) => {
  try {
    res.json({ code: 0, data: await readCurrent() });
  } catch (err) {
    logger.error('[admin/refund-settings] read failed', { error: err.message });
    res.status(500).json({ code: 5000, message: '读取退款配置失败' });
  }
});

router.put('/', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const field of ['windowDays', 'reviewBusinessDays']) {
      if (body[field] === undefined || body[field] === null || body[field] === '') continue;
      const parsed = parseBound(field, body[field]);
      if (parsed.error) return res.status(400).json({ code: 4000, message: parsed.error });
      patch[field] = parsed.value;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: 4000, message: '没有要保存的配置项' });
    }

    for (const [field, value] of Object.entries(patch)) {
      const { rows } = await pool.query(
        `UPDATE system_configs
            SET config_value = to_jsonb($2::text), updated_by = $3, updated_at = NOW()
          WHERE config_key = $1
          RETURNING config_key`,
        [BOUNDS[field].key, String(value), req.user?.userId ?? null]
      );
      // 迁移没跑过（键不存在）时补插，而不是让管理台报一个看不懂的 404
      if (rows.length === 0) {
        await pool.query(
          `INSERT INTO system_configs (config_key, config_value, description, category)
           VALUES ($1, to_jsonb($2::text), $3, 'payment')
           ON CONFLICT (config_key) DO NOTHING`,
          [BOUNDS[field].key, String(value), `${field}（管理台退款审核页设置）`]
        );
      }
    }

    // 写侧必须失效读侧的 5s TTL 缓存，否则「改成 1 天」要等 5 秒才生效，
    // 管理员会以为没保存上（多实例下其余实例最迟 5s 后自然收敛）
    clearRefundSettingsCache();

    await logAuditEvent({
      userId: req.user?.userId,
      action: AUDIT_ACTIONS.ADMIN_ACTION,
      resourceType: 'system_config',
      resourceId: Object.keys(patch).join(','),
      details: { refundSettings: patch },
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    }).catch((e) => logger.error('[admin/refund-settings] audit failed', { error: e.message }));

    logger.info('[admin/refund-settings] updated', { ...patch, operator: req.user?.userId });
    res.json({ code: 0, data: await readCurrent() });
  } catch (err) {
    logger.error('[admin/refund-settings] write failed', { error: err.message });
    res.status(500).json({ code: 5000, message: '保存退款配置失败' });
  }
});

export default router;

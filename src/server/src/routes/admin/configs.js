// =============================================
// Admin Console · 系统配置 / 功能开关 APIs（Admin Console · T-A5）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/configs', configsRouter) → GET   /api/admin/configs
//                                                PATCH /api/admin/configs/:key
//   adminRouter.use('/flags', flagsRouter)     → GET   /api/admin/flags
//                                                PATCH /api/admin/flags/:key
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件额外细粒度权限：PATCH /configs/:key、PATCH /flags/:key → requirePerm('admin.configs.manage')
//   （权限目录中该点标记 superAdminOnly，043/044 仅授予 super_admin；GET 列表无额外权限点）
//
// 响应契约（src/admin-console/src/api/types.ts SystemConfig / FeatureFlag 逐字段对齐）：
//   SystemConfig: { key, name, value, description?, updatedAt? }  —— value 为字符串
//   FeatureFlag:  { key, name, description, enabled }
//   GET 返回数组（前端设置页一次性渲染，无分页）；PATCH 返回更新后的单条 + message
//
// 展示目录（name/描述文案）与前端设置页契约（admin-console/src/mocks/data.ts
// mockConfigs / mockFlags）逐键对齐；DB（038/044 种子）只存键值与布尔值，
// 展示元数据在此补齐（与 roles.js PERM_CATALOG 同一模式）。
//
// 语义契约（src/admin-console/src/mocks/handlers.ts / handlers.test.ts 固化）：
//   - PATCH 未知配置键/开关键 → 404 { code: 40404 }
//   - value 空 / enabled 非布尔 → 400 { code: 40002 }
//   - maintenance_mode 缺 reason → 400 { code: 40003 }（原因必填，写入审计日志）
//   - 写路径审计：admin.config.update（resourceType=system_config）/ admin.flag.update（feature_flag）
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

// ───────────────────────── 展示目录 ─────────────────────────

const CONFIG_CATALOG = [
  {
    key: 'maintenance_mode',
    name: '维护模式',
    description: '开启后客户端暂停同步并显示维护公告（仅 super_admin）',
  },
  {
    key: 'ai_max_tokens',
    name: 'AI 单次最大 Token 数',
    description: 'AI 助手单次对话 / 补全的 token 上限',
  },
  {
    key: 'ai_default_provider',
    name: 'AI 默认服务商',
    description: 'AI 助手默认模型路由（openrouter / openai / anthropic / deepseek）',
  },
  {
    key: 'session_timeout_minutes',
    name: '管理台会话超时（分钟）',
    description: '管理员无操作自动登出时间',
  },
  {
    key: 'audit_log_retention_days',
    name: '审计日志保留天数',
    description: 'audit_logs 保留策略，超期归档后删除',
  },
];

const CONFIG_CATALOG_MAP = new Map(CONFIG_CATALOG.map((c) => [c.key, c]));
const MAINTENANCE_MODE_KEY = 'maintenance_mode';

const FLAG_CATALOG = [
  {
    key: 'enable_subscription',
    name: '订阅功能',
    description: '关闭后所有用户临时按 Free 配额处理（不影响已有订单）',
  },
  {
    key: 'enable_ai_agent',
    name: 'AI 助手',
    description: 'AI 侧边栏、智能分类与写作工具',
  },
  {
    key: 'enable_public_sharing',
    name: '公开分享',
    description: '共享链接能力（含文件分享）',
  },
  {
    key: 'enable_2fa',
    name: '两步验证',
    description: '用户级 TOTP；关闭不影响已开启用户',
  },
  {
    key: 'signup_waitlist',
    name: '注册审核',
    description: '新注册进入等待名单（运营灰度）',
  },
];

const FLAG_CATALOG_MAP = new Map(FLAG_CATALOG.map((f) => [f.key, f]));

// ───────────────────────── 通用片段 ─────────────────────────

/** JSONB config_value → 契约字符串（SystemConfig.value）：'"off"'→'off'、'4096'→'4096'、false→'false' */
function jsonbValueToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/** timestamptz → 'YYYY-MM-DD HH:mm'（SystemConfig.updatedAt / 设置页展示口径） */
function formatDateTimeMinute(value) {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** DB 配置行 + 目录元数据 → 前端 SystemConfig 契约 */
function mapConfigRow(meta, row) {
  return {
    key: meta.key,
    name: meta.name,
    value: jsonbValueToString(row?.config_value),
    description: meta.description || row?.description || undefined,
    updatedAt: formatDateTimeMinute(row?.updated_at),
  };
}

// ───────────────────────── 系统配置 ─────────────────────────

/**
 * GET /api/admin/configs
 * 系统参数列表（目录 5 键，目录顺序输出；DB 缺行时 value 兜底空串，不阻塞设置页渲染）。
 */
router.get('/', async (_req, res) => {
  try {
    const keys = CONFIG_CATALOG.map((c) => c.key);
    const { rows } = await pool.query(
      `SELECT config_key, config_value, description, updated_at
       FROM system_configs WHERE config_key = ANY($1)`,
      [keys]
    );
    const byKey = new Map(rows.map((row) => [row.config_key, row]));
    return res.json({ code: 0, data: CONFIG_CATALOG.map((meta) => mapConfigRow(meta, byKey.get(meta.key))) });
  } catch (err) {
    logger.error('[admin/configs] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取系统配置失败' });
  }
});

/**
 * PATCH /api/admin/configs/:key  body { value: string, reason?: string }
 * 更新单项系统参数（requirePerm('admin.configs.manage')）：
 *  - 仅目录内键可改（未知键 404）；value 必填（40002）
 *  - maintenance_mode 原因必填（40003，写入审计日志）
 *  - JSONB 写入 to_jsonb($2::text) 保持 value 字符串往返一致；updated_by 记录修改人
 *  - 审计 admin.config.update（敏感操作）
 */
router.patch('/:key', requirePerm('admin.configs.manage'), async (req, res) => {
  try {
    const key = req.params.key;
    const meta = CONFIG_CATALOG_MAP.get(key);
    if (!meta) {
      return res.status(404).json({ code: 40404, message: '配置项不存在' });
    }

    const body = req.body || {};
    const rawValue = body.value;
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      return res.status(400).json({ code: 40002, message: 'value 不能为空' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (key === MAINTENANCE_MODE_KEY && !reason) {
      return res
        .status(400)
        .json({ code: 40003, message: '维护模式切换必须填写原因（写入审计日志）' });
    }

    const valueStr = String(rawValue);
    const { rows } = await pool.query(
      `UPDATE system_configs
       SET config_value = to_jsonb($2::text), updated_by = $3, updated_at = NOW()
       WHERE config_key = $1
       RETURNING config_key, config_value, description, updated_at`,
      [key, valueStr, req.user?.userId ?? null]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '配置项不存在' });
    }

    // 审计：admin.config.update（敏感操作，details 含 value 与可选 reason）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.config.update',
      resourceType: 'system_config',
      resourceId: key,
      details: reason ? { value: valueStr, reason } : { value: valueStr },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/configs] config updated', { key, operator: req.user?.userId });

    return res.json({
      code: 0,
      data: mapConfigRow(meta, rows[0]),
      message: key === MAINTENANCE_MODE_KEY ? '维护模式已更新' : '配置已更新并写入审计',
    });
  } catch (err) {
    logger.error('[admin/configs] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '更新系统配置失败' });
  }
});

// ───────────────────────── 功能开关 ─────────────────────────

const flagsRouter = Router();

/**
 * GET /api/admin/flags
 * 功能开关列表（目录 5 开关，目录顺序输出）。
 */
flagsRouter.get('/', async (_req, res) => {
  try {
    const keys = FLAG_CATALOG.map((f) => f.key);
    const { rows } = await pool.query(
      `SELECT flag_key, enabled, description FROM feature_flags WHERE flag_key = ANY($1)`,
      [keys]
    );
    const byKey = new Map(rows.map((row) => [row.flag_key, row]));
    const data = FLAG_CATALOG.map((meta) => {
      const row = byKey.get(meta.key);
      return {
        key: meta.key,
        name: meta.name,
        description: row?.description || meta.description,
        enabled: row ? Boolean(row.enabled) : false,
      };
    });
    return res.json({ code: 0, data });
  } catch (err) {
    logger.error('[admin/flags] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取功能开关失败' });
  }
});

/**
 * PATCH /api/admin/flags/:key  body { enabled: boolean }
 * 切换单个功能开关（requirePerm('admin.configs.manage')，即时生效）：
 *  - enabled 必须为布尔值（40002）；未知开关 404
 *  - 审计 admin.flag.update（敏感操作）
 */
flagsRouter.patch('/:key', requirePerm('admin.configs.manage'), async (req, res) => {
  try {
    const key = req.params.key;
    const meta = FLAG_CATALOG_MAP.get(key);
    if (!meta) {
      return res.status(404).json({ code: 40404, message: '功能开关不存在' });
    }

    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ code: 40002, message: 'enabled 必须为布尔值' });
    }

    const { rows } = await pool.query(
      `UPDATE feature_flags SET enabled = $2, updated_at = NOW()
       WHERE flag_key = $1
       RETURNING flag_key, enabled, description`,
      [key, body.enabled]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '功能开关不存在' });
    }
    const row = rows[0];

    // 审计：admin.flag.update（敏感操作）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.flag.update',
      resourceType: 'feature_flag',
      resourceId: key,
      details: { enabled: body.enabled },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/flags] flag updated', { key, enabled: body.enabled, operator: req.user?.userId });

    return res.json({
      code: 0,
      data: {
        key,
        name: meta.name,
        description: row.description || meta.description,
        enabled: Boolean(row.enabled),
      },
      message: '开关已切换并写入审计',
    });
  } catch (err) {
    logger.error('[admin/flags] update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '切换功能开关失败' });
  }
});

export default router;
export { flagsRouter };

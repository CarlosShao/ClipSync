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
// 本文件细粒度权限：PATCH /configs/:key、PATCH /flags/:key → requirePerm('admin.configs.manage')
//   （权限目录中该点标记 superAdminOnly，043/044 仅授予 super_admin）；
//   GET /configs、GET /flags → requirePerm('admin.configs.view')（RB-06 读侧细粒度校验）
//
// 响应契约（src/admin-console/src/api/types.ts SystemConfig / FeatureFlag 逐字段对齐）：
//   SystemConfig: { key, name, value, description?, updatedAt?, consumer? }  —— value 为字符串；
//     consumer 为消费方登记（AN-09）：字符串 = 消费方文件路径说明；null = 暂无消费方
//     （管理台对该键显示「未接入」角标——改了不生效，运营可分辨）
//   FeatureFlag:  { key, name, description, enabled, enforced }
//     enforced（AN-10）：该键是否存在服务端强制点（requireFlag/isFlagEnabled 调用），
//     清单见 utils/featureFlags.js ENFORCED_FLAG_KEYS；false = UI 有开关但改了不生效（AF-04 告警口径）
//   GET 返回数组（前端设置页一次性渲染，无分页）；PATCH 返回更新后的单条 + message
//
// 展示目录（name/描述文案）与前端设置页契约（admin-console/src/mocks/data.ts
// mockConfigs / mockFlags）逐键对齐；DB（038/044 种子）只存键值与布尔值，
// 展示元数据在此补齐（与 roles.js PERM_CATALOG 同一模式）。
// consumer（AN-09）：每键登记真实消费方文件，禁止臆造——新增键时必须先 grep
// 查证消费点再填；查无消费点一律填 null，由管理台打「未接入」角标。
//
// 语义契约（src/admin-console/src/mocks/handlers.ts / handlers.test.ts 固化）：
//   - PATCH 未知配置键/开关键 → 404 { code: 40404 }
//   - value 空 / enabled 非布尔 → 400 { code: 40002 }
//   - maintenance_mode 缺 reason → 400 { code: 40003 }（原因必填，写入审计日志）
//   - rate_limit_disabled 写 true 且 NODE_ENV=production → 400（CO-11）
//   - log_level 仅允许 debug/info/warn/error（CO-41）
//   - smtp_pass 写入前 AES 加密、读取统一脱敏为「已配置/未配置」（CO-30）
//   - maintenance_mode 更新成功 → 失效本进程缓存 + WS 广播 maintenance.updated（CO-20）
//   - 写路径审计：admin.config.update（resourceType=system_config）/ admin.flag.update（feature_flag）
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { broadcastToAllClients } from '../../ws/server.js';
import { invalidateFlagsCache, getFeatureFlags, isFlagEnforced } from '../../utils/featureFlags.js';
import { encryptField } from '../../utils/encryption.js';
import { invalidateMaintenanceCache } from '../../middleware/maintenance.js';
import { logger, setLogLevel } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { sendTestMail } from '../../utils/email.js';
// AN-03：AI 全局参数（ai_max_tokens/ai_default_provider）写库后失效 AI 运行时缓存
import { invalidateAiRuntimeConfigCache } from '../../utils/aiRuntimeConfig.js';

const router = Router();

// ───────────────────────── 展示目录 ─────────────────────────

const CONFIG_CATALOG = [
  {
    key: 'maintenance_mode',
    name: '维护模式',
    description: '开启后客户端暂停同步并显示维护公告',
    // AN-09 查证：maintenanceGuard 挂载于 index.js 同步链路（363-382），isMaintenanceOn 供 ws/server.js
    consumer: 'src/server/src/middleware/maintenance.js（maintenanceGuard，index.js 挂载）+ ws/server.js',
  },
  {
    key: 'ai_max_tokens',
    name: 'AI 单次最大 Token 数',
    description: 'AI 助手单次对话 / 补全的 token 上限',
    // AN-03 已接线：utils/aiProviders.js buildUpstreamChat 三协议分支统一 clampMaxTokens，
    // 覆盖 chat/summarize/dedup/refactor/suggest/OCR/压缩全链路（经 aiRuntimeConfig.js 5s TTL 读取）
    consumer: 'src/server/src/utils/aiProviders.js（buildUpstreamChat 经 utils/aiRuntimeConfig.js 统一钳制 max_tokens）',
  },
  {
    key: 'ai_default_provider',
    name: 'AI 默认服务商',
    description: 'AI 助手默认模型路由（openrouter / openai / anthropic / deepseek）',
    // AN-03 已接线：客户端请求未传 providerId 时的服务端兜底路由
    //（用户 is_default 行 → 按该键供应商族选该用户已配置供应商，见 aiRuntimeConfig.js resolveUserProvider）
    consumer: 'src/server/src/utils/aiRuntimeConfig.js（resolveUserProvider 兜底路由，aiChat.js 各端点消费）',
  },
  {
    key: 'session_timeout_minutes',
    name: '管理台会话超时（分钟）',
    description: '管理员无操作自动登出时间',
    // AN-09 查证：AdminLayout.tsx 空闲登出计时器读取（AF-51 方案 a 已接线，前端消费）
    consumer: 'src/admin-console/src/layouts/AdminLayout.tsx（空闲自动登出，前端消费）',
  },
  {
    key: 'audit_log_retention_days',
    name: '审计日志保留天数',
    description: '审计日志的保留时长，超期归档后删除',
    consumer: 'src/server/src/db/cleanup.js（审计归档任务 readAuditRetentionDays）',
  },
  // AN-14（第二轮死配置清理）：max_collection_depth / enable_audit_log 已从目录移除——
  // AN-09 查证两者均无任何消费方（collections 无 depth 读取点；audit.js 无条件写库），
  // 且无任何工单规划接线。库中行保留（057 迁移仅标注废弃，不删历史数据）；
  // ai_max_tokens / ai_default_provider 虽然 consumer=null 但 AN-03 已规划接线，暂不移除。
  // —— 限流配置（050，方案三 WP-A：运行时可调，rateLimiter.js 经 runtimeLimits 消费）——
  {
    key: 'rate_limit_api_per_min',
    name: '全局 API 限流（次/分钟）',
    description: '滑动窗口限流阈值，按用户计数（匿名按 IP）',
    consumer: 'src/server/src/middleware/rateLimiter.js（经 utils/runtimeLimits.js 读取）',
  },
  {
    key: 'rate_limit_send_code_per_hour',
    name: '验证码发送限流（次/小时）',
    description: '单手机号验证码发送上限，短信成本保护',
    consumer: 'src/server/src/middleware/rateLimiter.js（经 utils/runtimeLimits.js 读取）',
  },
  {
    key: 'rate_limit_login_failed_per_15min',
    name: '登录失败锁定（次/15分钟）',
    description: '单手机号登录失败锁定阈值',
    consumer: 'src/server/src/middleware/rateLimiter.js（经 utils/runtimeLimits.js 读取）',
  },
  {
    key: 'rate_limit_upload_per_min',
    name: '上传接口限流（次/分钟）',
    description: '上传与大文件分片接口的独立限流',
    consumer: 'src/server/src/middleware/rateLimiter.js（经 utils/runtimeLimits.js 读取）',
  },
  {
    key: 'rate_limit_disabled',
    name: '关闭限流（生产禁用）',
    description: '总开关：开启后全部限流失效；生产环境后端拒绝写入 true',
    consumer: 'src/server/src/middleware/rateLimiter.js（经 utils/runtimeLimits.js 读取）',
  },
  // —— 运维（050，CO-41：日志级别热调）——
  {
    key: 'log_level',
    name: '运行时日志级别',
    description: 'debug / info / warn / error，保存后热生效（debug/info/warn/error）',
    consumer: 'src/server/src/utils/logger.js（setLogLevel，configs PATCH 后热生效）',
  },
  // —— 运维（055，AF-30：Grafana 跳转地址，ops/overview 下发，空则前端置灰）——
  {
    key: 'grafana_url',
    name: 'Grafana 地址',
    description: '运维页「打开 Grafana 容器总览」跳转地址，如 http://127.0.0.1:3004；为空则按钮置灰',
    consumer: 'src/server/src/routes/admin/ops.js（readGrafanaUrl，ops/overview 下发）',
  },
  // —— 运维（063，AN-15：Prometheus 告警只读代理地址，ops/alerts 消费）——
  {
    key: 'prometheus_url',
    name: 'Prometheus 地址',
    description: '运维页「活跃告警」数据源，如 http://127.0.0.1:9090；为空或不可达时告警卡显示「告警服务不可用」',
    consumer: 'src/server/src/routes/admin/ops.js（readConfigString，ops/alerts 代理 /api/v1/alerts）',
  },
  // —— 运维（063，AN-06：手动备份保留策略，trigger_backup 落盘后清理超期文件）——
  {
    key: 'backup_retention_days',
    name: '备份保留天数',
    description: '手动/定时备份文件的保留天数（默认 7），触发备份后自动清理超期文件',
    consumer: 'src/server/src/routes/admin/ops.js（runManualBackup 保留策略清理）',
  },
  // —— 运维（063，AN-08：存储清理总开关，ops/cleanup 手动触发闸门）——
  {
    key: 'storage_cleanup_enabled',
    name: '存储清理开关',
    description: '关闭后管理台「存储清理」动作拒绝执行（定时清理任务不受影响）',
    consumer: 'src/server/src/routes/admin/ops.js（ops/cleanup 端点 readConfigBool 闸门）',
  },
  // —— 设备（056，AF-50：在线判定超时，deviceOnlineSweep 每 60s 扫描）——
  {
    key: 'device_offline_timeout_minutes',
    name: '设备离线判定阈值（分钟）',
    description: '在线设备超过该时长未上报心跳（WS ping）将被定时扫描置为离线，默认 5',
    // AN-14 复查补录：056 迁移落地时漏登记消费方（实为已接线键）
    consumer: 'src/server/src/services/deviceOnlineSweep.js（deviceOnlineSweep 每 60s 扫描读取）',
  },
  // —— 邮件 SMTP（050，CO-30：smtp_pass 由管理台加密写入、脱敏展示）——
  {
    key: 'smtp_host',
    name: 'SMTP 服务器地址',
    description: '为空时邮件走控制台兜底（不真实发送）',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  {
    key: 'smtp_port',
    name: 'SMTP 端口',
    description: '465=SSL 直连 / 587=STARTTLS',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  {
    key: 'smtp_user',
    name: 'SMTP 用户名',
    description: '邮箱账号或 API 用户',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  {
    key: 'smtp_pass',
    name: 'SMTP 密码/授权码',
    description: '加密存储，保存后仅显示是否已配置',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  {
    key: 'smtp_from',
    name: '发件人地址',
    description: '如 no-reply@example.com',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  {
    key: 'smtp_secure',
    name: 'SMTP SSL 直连',
    description: 'true=SSL(465) / false=STARTTLS(587)',
    consumer: 'src/server/src/utils/email.js（SMTP_KEYS 配置读取）',
  },
  // AF-42：menu_overrides 已从管理台目录移除——客户端无读取通道（setOverrides 预留未调用），
  // 属"可改不生效"。库中行保留，待客户端下发通道立项后恢复（见 docs/plans/tickets AN-02）。
];

const CONFIG_CATALOG_MAP = new Map(CONFIG_CATALOG.map((c) => [c.key, c]));
const MAINTENANCE_MODE_KEY = 'maintenance_mode';

const FLAG_CATALOG = [
  {
    key: 'enable_subscription',
    name: '订阅功能',
    description: '关闭后全部用户立即按 Free 配额执行（不改库、不影响已有订单与订阅记录）',
  },
  {
    key: 'enable_ai_agent',
    name: 'AI 助手',
    description: '关闭后 AI 全部接口（对话/记忆/设置/供应商）服务端直接拒绝，客户端即时感知',
  },
  {
    key: 'enable_public_sharing',
    name: '公开分享',
    description: '关闭后禁止新建共享链接与文件分享；已创建的链接保持可访问',
  },
  {
    key: 'enable_2fa',
    name: '两步验证',
    description: '关闭后禁止新开启两步验证；已开启用户的登录验证与关闭操作不受影响',
  },
  {
    key: 'signup_waitlist',
    name: '注册审核',
    description: '开启后新注册进入待审核状态，登录被拦截，需在「用户管理」审批通过',
  },
  {
    key: 'enable_signup',
    name: '注册总开关',
    description: '关闭后完全禁止新用户注册（与注册审核正交：关闭 > 审核 > 开放），客户端注册入口同步隐藏',
  },
  // AN-12：管理员安全策略 —— 强制管理角色绑定两步验证
  {
    key: 'force_2fa_for_admin',
    name: '强制管理员两步验证',
    description: '开启后管理角色（admin/super_admin）未绑定 2FA 时登录被拦截，需先在客户端绑定两步验证',
  },
];

const FLAG_CATALOG_MAP = new Map(FLAG_CATALOG.map((f) => [f.key, f]));

// ───────────────────────── 通用片段 ─────────────────────────

/** JSONB config_value → 契约字符串（SystemConfig.value）：'"off"'→'off'、'4096'→'4096'、false→'false' */
function jsonbValueToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  // 对象/数组（如 menu_overrides 的 050 种子 '{}'::jsonb）→ JSON 文本，避免前端显示 [object Object]
  if (typeof value === 'object') return JSON.stringify(value);
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
  let value = jsonbValueToString(row?.config_value);
  // CO-30：smtp_pass 加密存储，任何读取路径（GET 列表 / PATCH 回显）只暴露配置状态，不回传密文
  if (meta.key === 'smtp_pass') {
    value = value ? '已配置' : '未配置';
  }
  return {
    key: meta.key,
    name: meta.name,
    value,
    description: meta.description || row?.description || undefined,
    updatedAt: formatDateTimeMinute(row?.updated_at),
    // AN-09：消费方登记（null = 未接入，管理台打角标）；缺省兜底 null 保证契约字段稳定
    consumer: meta.consumer ?? null,
  };
}

// ───────────────────────── 系统配置 ─────────────────────────

/**
 * GET /api/admin/configs
 * 系统参数列表（目录 5 键，目录顺序输出；DB 缺行时 value 兜底空串，不阻塞设置页渲染）。
 * RB-06：读侧细粒度权限 requirePerm('admin.configs.view')。
 */
router.get('/', requirePerm('admin.configs.view'), async (_req, res) => {
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
 *  - rate_limit_disabled 写 true 且 NODE_ENV=production 拒绝（400，CO-11）
 *  - log_level 仅允许 debug/info/warn/error（400，CO-41）
 *  - smtp_pass 写入前加密（CO-30），读取路径统一脱敏（mapConfigRow）
 *  - maintenance_mode 成功后失效维护缓存 + WS 广播 maintenance.updated（CO-20）
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

    // CO-11：限流总开关在生产环境禁止关闭（配置写错路径即熔断全站保护）
    if (key === 'rate_limit_disabled' && valueStr === 'true' && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ code: 40002, message: '生产环境禁止关闭限流' });
    }

    // CO-41：日志级别白名单校验（logger.js 热生效链路的脏数据防线）
    if (key === 'log_level' && !['debug', 'info', 'warn', 'error'].includes(valueStr)) {
      return res.status(400).json({ code: 40002, message: 'log_level 仅允许 debug / info / warn / error' });
    }

    // CO-30：smtp_pass 落库前加密（AES-256-GCM），其余键原样写入
    const valueToStore = key === 'smtp_pass' ? encryptField(valueStr) : valueStr;

    const { rows } = await pool.query(
      `UPDATE system_configs
       SET config_value = to_jsonb($2::text), updated_by = $3, updated_at = NOW()
       WHERE config_key = $1
       RETURNING config_key, config_value, description, updated_at`,
      [key, valueToStore, req.user?.userId ?? null]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '配置项不存在' });
    }

    // CO-20：维护模式切换 → 失效本进程缓存 + 全端广播（客户端即时出/收维护横幅；
    // 未连 WS 的客户端最迟在同步链路被 maintenanceGuard 以 503 拦截（≤5s TTL 兜底）。
    if (key === MAINTENANCE_MODE_KEY) {
      invalidateMaintenanceCache();
      const mode = valueStr.trim().toLowerCase() === 'on' ? 'on' : 'off';
      broadcastToAllClients({ type: 'maintenance.updated', mode });
    }

    // AF-52：log_level 写库后热生效（CO-41 承诺的「保存后热生效」此前未接线）
    if (key === 'log_level') {
      const applied = setLogLevel(valueStr);
      if (!applied) {
        logger.warn('[admin/configs] log_level setLogLevel rejected', { value: valueStr });
      }
    }

    // AN-03：AI 全局参数写库后失效 aiRuntimeConfig 5s TTL 缓存（下次 AI 调用直连库读取）
    if (key === 'ai_max_tokens' || key === 'ai_default_provider') {
      invalidateAiRuntimeConfigCache();
    }

    // 审计：admin.config.update（敏感操作，details 含 value 与可选 reason；
    // smtp_pass 不落明文——审计流水常驻库中，只记录「已更新」占位符）
    const auditValue = key === 'smtp_pass' ? '***' : valueStr;
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.config.update',
      resourceType: 'system_config',
      resourceId: key,
      details: reason ? { value: auditValue, reason } : { value: auditValue },
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

// ───────────────────────── SMTP 测试邮件（CO-30） ─────────────────────────

/**
 * POST /api/admin/configs/smtp/test  body { to?: string }
 * 发送 SMTP 测试邮件（requirePerm('admin.configs.manage')，与配置写路径权限一致）：
 *  - to 缺省取 system_configs.smtp_user；两者皆空/格式非法 → 400 { code: 40002 }
 *  - 未配置 SMTP（host/user/pass 不全）→ 409 { code: 4090 }（当前验证码走控制台兜底，不算成功）
 *  - 发送成功/失败均写审计 admin.config.smtp_test（与 admin.config.update 风格对齐）
 */
router.post('/smtp/test', requirePerm('admin.configs.manage'), async (req, res) => {
  try {
    let to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!to) {
      const { rows } = await pool.query(
        `SELECT config_value FROM system_configs WHERE config_key = 'smtp_user'`
      );
      to = jsonbValueToString(rows[0]?.config_value).trim();
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ code: 40002, message: '收件人邮箱无效（未传 to 且 smtp_user 未配置）' });
    }

    const result = await sendTestMail(to);

    if (result.unconfigured) {
      return res.status(409).json({ code: 4090, message: '未配置 SMTP，当前验证码走控制台兜底' });
    }

    // 成功/失败均写审计（失败时 error 进入 details 便于排查）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.config.smtp_test',
      resourceType: 'system_config',
      resourceId: 'smtp_test',
      details: {
        to,
        success: result.success,
        error: result.error || undefined,
        messageId: result.messageId || undefined,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    if (!result.success) {
      return res.status(500).json({ code: 5000, message: `测试邮件发送失败：${result.error || '未知错误'}` });
    }

    logger.info('[admin/configs] smtp test mail sent', { to, operator: req.user?.userId });
    return res.json({ code: 0, data: { to, messageId: result.messageId || null }, message: '测试邮件已发送' });
  } catch (err) {
    logger.error('[admin/configs] smtp test failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '发送测试邮件失败' });
  }
});

// ───────────────────────── 功能开关 ─────────────────────────

const flagsRouter = Router();

/**
 * GET /api/admin/flags
 * 功能开关列表（目录 5 开关，目录顺序输出）。
 * RB-06：读侧细粒度权限 requirePerm('admin.configs.view')。
 */
flagsRouter.get('/', requirePerm('admin.configs.view'), async (_req, res) => {
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
        // AN-10：是否存在服务端强制点（ENFORCED_FLAG_KEYS 静态清单，防 AF-04 复发）
        enforced: isFlagEnforced(meta.key),
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

    // 立即失效本进程缓存并向全部在线客户端广播新开关快照；
    // 未连 WS 的客户端最迟在下一个请求被服务端 requireFlag 拦截（≤5s TTL 兜底）。
    invalidateFlagsCache();
    const flags = await getFeatureFlags();
    broadcastToAllClients({ type: 'feature_flags.updated', flags });

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
        // AN-10：与 GET 列表契约对齐（前端切换后单条回显同样带强制点标记）
        enforced: isFlagEnforced(key),
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

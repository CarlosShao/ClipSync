// =============================================
// Admin Console · 运维监控 APIs（方案三 CO-40 · ops overview；CO-33 · 备份可视化；CO-42 · 部署形态）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/ops', opsRouter) → GET   /api/admin/ops/overview
//                                       GET   /api/admin/ops/backups
//                                       GET   /api/admin/ops/backups/download   （AN-06 备份下载）
//                                       POST  /api/admin/ops/actions            （AN-06 运维动作区）
//                                       GET   /api/admin/ops/alerts             （AN-15 Prometheus 告警代理，只读）
//                                       GET   /api/admin/ops/storage            （AN-08 存储用量统计）
//                                       POST  /api/admin/ops/cleanup            （AN-08 清理归档手动触发）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：requirePerm('admin.ops.view')（052 迁移，仅授 super_admin）
//
// 响应契约（{ code: 0, data } / { code, message }，供管理台运维页红绿灯卡片）：
//   GET /overview → data: {
//     status: 'ok' | 'degraded' | 'error',   // db error → error；db ok 且 redis 不可用 → degraded
//     version: string,                        // package.json version
//     uptimeSec: number,                      // process.uptime()
//     db:      { ok: boolean, latencyMs: number|null },
//     redis:   { ok: boolean, latencyMs: number|null },  // Redis 未部署时 ok:false（降级非致命）
//     memory:  { rss: number, heapUsed: number },        // 字节
//     metrics: { requests, errors, p95 } | null,         // getMetricsSnapshot 未就绪/异常时为 null
//     deployment: { type: 'k8s'|'docker-compose', replicas: number|null }  // CO-42，探测失败降级 replicas:null
//   }
//   GET /backups → data: {
//     items: [{ file, sizeBytes, mtime, kind }],   // mtime 倒序，最多 100 条；kind: db/audit/media/other
//     summary: { total, totalBytes, lastBackupAt } // 全量统计（不截断）；无备份目录/目录为空时 items=[]、lastBackupAt=null
//   }
// =============================================

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { getMetricsSnapshot, getMetricsSeries } from '../../middleware/metrics.js';
import { performance } from 'perf_hooks';
import pool from '../../db/pool.js';
import config from '../../config.js';
import { getRedisClient } from '../../utils/redis-client.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { logAuditEvent } from '../../utils/audit.js';
// AN-06 运维动作区：缓存失效与配置重载
import { invalidateFlagsCache, getFeatureFlags } from '../../utils/featureFlags.js';
import { invalidateLimitsCache, getRuntimeLimits } from '../../utils/runtimeLimits.js';
import { invalidateMaintenanceCache } from '../../middleware/maintenance.js';
// AN-08：存储清理手动触发（复用既有清理逻辑）
import { runManualCleanup } from '../../db/cleanup.js';

const router = Router();

/** package.json version（读取失败返回 'unknown'，不阻塞概览） */
async function readVersion() {
  try {
    const packagePath = path.resolve('package.json');
    const packageData = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
    return packageData.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** DB 连通性：SELECT 1 计时（毫秒）；失败 ok:false */
async function probeDb() {
  const start = performance.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    logger.error('[admin/ops] db probe failed', { error: err.message });
    return { ok: false, latencyMs: null };
  }
}

/** Redis 连通性：PING 计时（毫秒）；未部署/连接失败 ok:false（非致命，降级 degraded） */
async function probeRedis() {
  const start = performance.now();
  try {
    const redis = await getRedisClient();
    if (!redis) return { ok: false, latencyMs: null };
    await redis.ping();
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    logger.error('[admin/ops] redis probe failed', { error: err.message });
    return { ok: false, latencyMs: null };
  }
}

/**
 * AF-30：读 system_configs.grafana_url（运维页跳转）。缺行/查库失败 → 空串（前端置灰）。
 */
async function readGrafanaUrl() {
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM system_configs WHERE config_key = 'grafana_url' LIMIT 1`
    );
    const raw = rows[0]?.config_value;
    return typeof raw === 'string' ? raw.trim() : '';
  } catch (err) {
    logger.warn('[admin/ops] grafana_url read failed', { error: err.message });
    return '';
  }
}

/**
 * 应用层指标快照：AF-02 落地——middleware/metrics.js 已导出 getMetricsSnapshot，
 * 这里直接同步调用（保留 try/catch 兜底：异常时降级 null，不阻塞概览）。
 */
function readMetricsSnapshot() {
  try {
    const snap = getMetricsSnapshot();
    return {
      requests: snap?.requests?.total ?? null,
      errors: snap?.errors?.total ?? null,
      p95: snap?.responseTime?.p95 ?? null,
      sampledAt: snap?.sampledAt ?? null,
    };
  } catch (err) {
    logger.warn('[admin/ops] metrics snapshot unavailable', { error: err.message });
    return null; // 指标读取异常不阻塞概览，降级为 null
  }
}

/**
 * CO-42：部署形态探测（不引额外依赖）。
 * 判定：KUBERNETES_SERVICE_HOST 存在且 serviceaccount token 可读 → 'k8s'；
 * 副本数简化为读 REPLICAS 环境变量（POD_NAME/REPLICAS 均未注入时 replicas:null），
 * 不调 K8s API 数 Pod（过重）。任何异常都不影响 overview 主流程，降级 replicas:null。
 */
async function detectDeployment() {
  const inK8sEnv = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  try {
    if (!inK8sEnv) return { type: 'docker-compose' };
    await fs.access('/var/run/secrets/kubernetes.io/serviceaccount/token');
    const replicas = parseInt(process.env.REPLICAS, 10);
    return { type: 'k8s', replicas: Number.isFinite(replicas) && replicas > 0 ? replicas : null };
  } catch (err) {
    // env 已存在但 token 不可读等边缘形态：仍按 k8s 上报，仅副本数降级为 null
    logger.warn('[admin/ops] deployment probe degraded', { error: err.message });
    return inK8sEnv ? { type: 'k8s', replicas: null } : { type: 'docker-compose' };
  }
}

/**
 * D1：对象存储（MinIO/OSS/COS/S3）状态探测。
 *
 * 目标：管理台运维页直接看到对象存储是否可用 + 一键进控制台，
 * 免去每次手敲 http://localhost:9011。
 *
 * 返回：
 *   { configured: false }                      —— STORAGE_TYPE=local，未启用对象存储
 *   { configured: true, ok, endpoint, bucket, consoleUrl, consoleConfigured, message }
 *
 * consoleUrl 读 system_configs.minio_console_url（管理台可配）。
 * 探测失败一律降级（不抛错、不阻塞 overview）——与 alerts/grafana 同口径。
 */
async function probeObjectStorage() {
  const storageType = (process.env.STORAGE_TYPE || 'local').toLowerCase();
  if (storageType !== 's3') {
    return { configured: false, storageType };
  }

  const endpoint = (process.env.S3_ENDPOINT || '').trim();
  const bucket = (process.env.S3_BUCKET || '').trim();

  let consoleUrl = '';
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM system_configs WHERE config_key = 'minio_console_url' LIMIT 1`
    );
    const raw = rows[0]?.config_value;
    consoleUrl = typeof raw === 'string' ? raw.trim() : '';
  } catch (err) {
    logger.warn('[admin/ops] minio_console_url read failed', { error: err.message });
  }

  // 探测：HEAD bucket（复用已初始化的 S3 客户端，不新建连接）
  let ok = false;
  let message = '';
  try {
    if (!endpoint || !bucket) {
      message = '未配置 S3_ENDPOINT / S3_BUCKET';
    } else {
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const { getStorageClient } = await import('../../utils/storage.js');
      const client = await getStorageClient();
      if (!client) {
        message = '存储客户端未初始化（initStorage 未执行）';
      } else {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        ok = true;
      }
    }
  } catch (err) {
    message = err?.name === 'NotFound'
      ? `桶不存在：${bucket}`
      : err?.message || '探测失败';
    logger.warn('[admin/ops] object storage probe degraded', { error: err.message });
  }

  return {
    configured: true,
    storageType,
    ok,
    endpoint,
    bucket,
    consoleUrl, // 空串 = 未配置（前端按钮置灰，与 grafanaUrl 同口径）
    consoleConfigured: Boolean(consoleUrl),
    message: ok ? '' : message,
  };
}

/**
 * GET /api/admin/ops/overview
 * 运维概览聚合（requirePerm('admin.ops.view')）：健康探针 + 版本/运行时长 +
 * 进程内存 + 近端请求/错误指标 + 部署形态（CO-42），全部来自既有组件，不新增采集器。
 */
router.get('/overview', requirePerm('admin.ops.view'), async (_req, res) => {
  try {
    const [version, db, redis, metrics, deployment, grafanaUrl, objectStorage] = await Promise.all([
      readVersion(),
      probeDb(),
      probeRedis(),
      readMetricsSnapshot(),
      detectDeployment(),
      readGrafanaUrl(),
      probeObjectStorage(),
    ]);

    const status = !db.ok ? 'error' : !redis.ok ? 'degraded' : 'ok';
    const mem = process.memoryUsage();

    return res.json({
      code: 0,
      data: {
        status,
        version,
        uptimeSec: Math.round(process.uptime()),
        db,
        redis,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
        },
        metrics,
        series: getMetricsSeries(), // AF-21：近 10 分钟趋势（30s 增量桶），重启后从空逐步累积
        grafanaUrl, // AF-30：system_configs.grafana_url，空串表示未配置（前端按钮置灰）
        deployment,
        objectStorage, // D1：对象存储状态 + 控制台地址（configured=false 表示仍用 local）
      },
    });
  } catch (err) {
    logger.error('[admin/ops] overview failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取运维概览失败' });
  }
});

// ───────────────────────── 备份可视化（CO-33） ─────────────────────────

// 备份目录：scripts/backup-db.sh 以 BACKUP_DIR=./backups（项目根）落盘 clipsync_*.sql.gz*。
// server 进程 cwd 为 src/server（readVersion 同口径），故首选向上两级；兼容 cwd 已在项目根的形态。
const BACKUP_DIR_CANDIDATES = [
  path.resolve(process.cwd(), '../../backups'),
  path.resolve(process.cwd(), 'backups'),
];

const BACKUPS_MAX_ITEMS = 100;

async function resolveBackupDir() {
  for (const dir of BACKUP_DIR_CANDIDATES) {
    try {
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch {
      // 候选不存在，试下一个
    }
  }
  return null;
}

/** 按文件名推断备份类型（db / audit / media / other） */
function inferBackupKind(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('audit')) return 'audit';
  if (name.includes('media') || name.includes('upload')) return 'media';
  if (/\.sql(\.gz|\.gpg)?(\.sha256)?$/.test(name) || name.endsWith('.dump')) return 'db';
  return 'other';
}

/** 递归收集备份目录文件（深度限制 3，防异常嵌套目录拖垮请求） */
async function collectBackupFiles(dir, depth = 0, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= BACKUPS_MAX_ITEMS) return acc;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3) await collectBackupFiles(full, depth + 1, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * GET /api/admin/ops/backups
 * 备份文件可视化（requirePerm('admin.ops.view')）：扫描 backups/ 目录，mtime 倒序，
 * 最多 100 条；目录不存在/不可读时返回空列表而非报错（备份可能由宿主机 cron 产出，容器内未必挂载）。
 */
router.get('/backups', requirePerm('admin.ops.view'), async (_req, res) => {
  try {
    const backupDir = await resolveBackupDir();
    if (!backupDir) {
      return res.json({
        code: 0,
        data: { items: [], summary: { total: 0, totalBytes: 0, lastBackupAt: null } },
      });
    }

    const files = await collectBackupFiles(backupDir);
    const stats = await Promise.all(
      files.map(async (full) => {
        try {
          const st = await fs.stat(full);
          return {
            file: path.relative(backupDir, full).split(path.sep).join('/'),
            sizeBytes: st.size,
            mtime: st.mtime.toISOString(),
            kind: inferBackupKind(path.basename(full)),
          };
        } catch {
          return null; // stat 失败（并发被清理等）跳过该文件
        }
      })
    );

    const valid = stats.filter(Boolean).sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    const totalBytes = valid.reduce((sum, it) => sum + it.sizeBytes, 0);
    const lastBackupAt = valid.length > 0 ? valid[0].mtime : null;

    return res.json({
      code: 0,
      data: {
        items: valid.slice(0, BACKUPS_MAX_ITEMS),
        summary: { total: valid.length, totalBytes, lastBackupAt },
      },
    });
  } catch (err) {
    logger.error('[admin/ops] backups list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取备份列表失败' });
  }
});

// ───────────────────────── AN-06：运维动作区 + 备份管理 ─────────────────────────

/**
 * 读 system_configs 数字配置（AN-06 backup_retention_days）：JSONB 数字/字符串均兼容，
 * 非法值回退 fallback。
 */
async function readConfigNumber(key, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM system_configs WHERE config_key = $1 LIMIT 1`,
      [key]
    );
    const n = parseInt(rows[0]?.config_value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch (err) {
    logger.warn(`[admin/ops] config ${key} read failed`, { error: err.message });
    return fallback;
  }
}

/** 读 system_configs 字符串配置（AN-15 prometheus_url）：缺失/查库失败返回空串 */
async function readConfigString(key) {
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM system_configs WHERE config_key = $1 LIMIT 1`,
      [key]
    );
    const raw = rows[0]?.config_value;
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number') return String(raw);
    return '';
  } catch (err) {
    logger.warn(`[admin/ops] config ${key} read failed`, { error: err.message });
    return '';
  }
}

/** 读 system_configs 布尔配置（AN-08 storage_cleanup_enabled）：'false'/false 视为关闭 */
async function readConfigBool(key, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT config_value FROM system_configs WHERE config_key = $1 LIMIT 1`,
      [key]
    );
    const raw = rows[0]?.config_value;
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return fallback;
  } catch (err) {
    logger.warn(`[admin/ops] config ${key} read failed`, { error: err.message });
    return fallback;
  }
}

/** 本地时间戳 YYYYMMDD_HHMMSS（备份文件命名，与 scripts/backup-db.sh 口径一致） */
function backupTimestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 执行手动备份（AN-06 trigger_backup）：
 *  - pg_dump（连接参数取 config.db.*，经 PGPASSWORD 环境变量传密码）→ gzip 流式落盘
 *    backups/clipsync_manual_YYYYMMDD_HHMMSS.sql.gz（与 backup-db.sh 命名口径一致）；
 *  - 落盘后按 system_configs.backup_retention_days（默认 7）清理过期备份。
 * pg_dump 缺失（容器未装 postgresql-client）/ 退出码非 0 时抛错，由端点转 500 + 明确 message。
 */
async function runManualBackup() {
  const backupDir = (await resolveBackupDir()) ?? path.resolve(process.cwd(), '../../backups');
  await fs.mkdir(backupDir, { recursive: true });

  const fileName = `clipsync_manual_${backupTimestamp()}.sql.gz`;
  const fullPath = path.join(backupDir, fileName);
  const args = [
    '-h', config.db.host,
    '-p', String(config.db.port),
    '-U', config.db.user,
    '-d', config.db.name,
    '--no-owner',
    '--no-privileges',
  ];
  const env = { ...process.env, PGPASSWORD: config.db.password };

  const child = spawn('pg_dump', args, { env });
  let stderr = '';
  child.stderr.on('data', (d) => {
    if (stderr.length < 4096) stderr += d.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(
        err?.code === 'ENOENT'
          ? new Error('pg_dump 不可用：当前运行环境未安装 PostgreSQL 客户端工具（postgresql-client）')
          : err
      );
    });
    child.on('close', (code) => resolve(code));
  });

  try {
    // stdout → gzip → 文件流式写盘，避免全量 SQL 驻留内存
    await pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(fullPath));
  } catch (err) {
    await fs.rm(fullPath, { force: true }); // 半成品清理
    throw err;
  }
  const code = await exited;
  if (code !== 0) {
    await fs.rm(fullPath, { force: true });
    throw new Error(`pg_dump 失败（退出码 ${code}）：${stderr.trim().slice(0, 300)}`);
  }

  // 保留策略清理（AN-06）：backup_retention_days 默认 7，仅清本命名口径的文件
  const retentionDays = await readConfigNumber('backup_retention_days', 7);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let prunedOld = 0;
  try {
    const entries = await fs.readdir(backupDir);
    for (const name of entries) {
      if (!/^clipsync_(manual|daily|weekly)_\d{8}_\d{6}\.sql(\.gz|\.gpg)?(\.sha256)?$/.test(name)) continue;
      const st = await fs.stat(path.join(backupDir, name)).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(path.join(backupDir, name), { force: true });
        prunedOld += 1;
      }
    }
  } catch (err) {
    logger.warn('[admin/ops] backup retention prune failed (non-fatal)', { error: err.message });
  }

  const st = await fs.stat(fullPath);
  return { file: fileName, sizeBytes: st.size, retentionDays, prunedOld };
}

/** AN-06 运维动作 → 成功文案（响应 message 与前端 toast 口径） */
const ACTION_MESSAGES = {
  clear_cache: '缓存已清理',
  reload_configs: '配置已重载',
  force_logout_all: '已全员下线',
  trigger_backup: '备份已完成',
};

/**
 * POST /api/admin/ops/actions
 * 运维动作区（AN-06，requirePerm('admin.ops.view') + reason 必填审计）：
 *   clear_cache      —— 清 feature_flags / runtime_limits / maintenance 进程缓存
 *   reload_configs   —— 失效缓存后立即回读 DB 验证配置可达
 *   force_logout_all —— 吊销除当前操作者外全部活跃会话（客户端下次请求即被拦截）
 *   trigger_backup   —— pg_dump 手动备份 + 保留策略清理
 * 高危写操作，admin/index.js 已叠加 adminStrictLimiter；reason 必填随审计落库。
 */
router.post('/actions', requirePerm('admin.ops.view'), async (req, res) => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({ code: 4000, message: '原因必填（将写入审计日志）' });
  }
  const allowed = new Set(['clear_cache', 'reload_configs', 'force_logout_all', 'trigger_backup']);
  if (!allowed.has(action)) {
    return res.status(400).json({ code: 4000, message: '未知的运维动作' });
  }

  try {
    let result;
    switch (action) {
      case 'clear_cache':
        invalidateFlagsCache();
        invalidateLimitsCache();
        invalidateMaintenanceCache();
        result = { cleared: ['feature_flags', 'runtime_limits', 'maintenance_mode'] };
        break;
      case 'reload_configs': {
        invalidateFlagsCache();
        invalidateLimitsCache();
        invalidateMaintenanceCache();
        const [flags, limits] = await Promise.all([getFeatureFlags(), getRuntimeLimits()]);
        result = {
          reloaded: true,
          flagCount: Object.keys(flags ?? {}).length,
          limitKeys: Object.keys(limits ?? {}).length,
        };
        break;
      }
      case 'force_logout_all': {
        // 排除当前操作者自身会话，保证动作执行者能看到结果页
        const { rowCount } = await pool.query(
          `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
           WHERE is_active = TRUE AND user_id <> $1`,
          [req.user.userId]
        );
        result = { revokedSessions: rowCount || 0 };
        break;
      }
      case 'trigger_backup':
        result = await runManualBackup();
        break;
      default:
        return res.status(400).json({ code: 4000, message: '未知的运维动作' });
    }

    await logAuditEvent({
      userId: req.user.userId,
      action: 'admin.ops.action',
      resourceType: 'ops',
      resourceId: action,
      details: { action, reason, result },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    logger.info('[admin/ops] action executed', { action, operator: req.user.userId, result });

    return res.json({
      code: 0,
      data: result,
      message: ACTION_MESSAGES[action] ?? '执行成功',
    });
  } catch (err) {
    logger.error('[admin/ops] action failed', { action, error: err.message });
    // 失败同样落审计（status=failed），便于追溯失败的动作与原因
    try {
      await logAuditEvent({
        userId: req.user.userId,
        action: 'admin.ops.action',
        resourceType: 'ops',
        resourceId: action,
        details: { action, reason },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        status: 'failed',
        errorMessage: err.message,
      });
    } catch {
      // 审计失败不吞掉原始错误
    }
    return res.status(500).json({ code: 5000, message: `运维动作执行失败：${err.message}` });
  }
});

/**
 * GET /api/admin/ops/backups/download?file=相对路径
 * 备份文件下载（AN-06，requirePerm('admin.ops.view')）：
 *   - file 必须是备份目录内的相对路径（拒绝绝对路径 / .. 穿越，resolve 后前缀校验）；
 *   - 走 res.download 流式下发；动作记审计 admin.ops.backup.download。
 */
router.get('/backups/download', requirePerm('admin.ops.view'), async (req, res) => {
  try {
    const rel = String(req.query.file ?? '').trim();
    if (!rel || rel.includes('..')) {
      return res.status(400).json({ code: 4000, message: '文件参数不合法' });
    }
    const backupDir = await resolveBackupDir();
    if (!backupDir) {
      return res.status(404).json({ code: 4040, message: '备份目录不可用' });
    }
    const full = path.resolve(backupDir, rel);
    if (full !== backupDir && !full.startsWith(backupDir + path.sep)) {
      return res.status(400).json({ code: 4000, message: '文件参数不合法' });
    }
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) {
      return res.status(404).json({ code: 4040, message: '备份文件不存在' });
    }

    await logAuditEvent({
      userId: req.user.userId,
      action: 'admin.ops.backup.download',
      resourceType: 'backup',
      resourceId: rel,
      details: { file: rel, sizeBytes: st.size },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => undefined); // 审计失败不阻塞下载

    return res.download(full, path.basename(full));
  } catch (err) {
    logger.error('[admin/ops] backup download failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '备份下载失败' });
  }
});

// ───────────────────────── AN-15：活跃告警（只读代理） ─────────────────────────

const PROMETHEUS_TIMEOUT_MS = 3000; // 工单口径：超时 3s 降级

/**
 * GET /api/admin/ops/alerts
 * 活跃告警（AN-15，只读，requirePerm('admin.ops.view')）：
 *   代理 Prometheus /api/v1/alerts（地址走 system_configs.prometheus_url，063 迁移），
 *   超时 3s / 未配置 / 不可达 → { unavailable: true, reason }（前端显示「告警服务不可用」而非报错）。
 *   仅返回 firing / pending 的活跃告警；grafanaUrl 一并下发供「跳转 Grafana」。
 */
router.get('/alerts', requirePerm('admin.ops.view'), async (_req, res) => {
  const [prometheusUrl, grafanaUrl] = await Promise.all([
    readConfigString('prometheus_url'),
    readGrafanaUrl(),
  ]);

  if (!prometheusUrl) {
    return res.json({
      code: 0,
      data: { unavailable: true, reason: 'not_configured', items: [], grafanaUrl },
    });
  }
  if (typeof fetch !== 'function') {
    // 极老 Node 兜底（容器为 node:22，理论不可达）
    return res.json({
      code: 0,
      data: { unavailable: true, reason: 'unreachable', items: [], grafanaUrl },
    });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROMETHEUS_TIMEOUT_MS);
    const resp = await fetch(`${prometheusUrl.replace(/\/+$/, '')}/api/v1/alerts`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`Prometheus 返回 HTTP ${resp.status}`);
    const body = await resp.json();
    const alerts = Array.isArray(body?.data?.alerts) ? body.data.alerts : [];

    const items = alerts
      .map((a) => ({
        id: `${a.labels?.alertname ?? 'alert'}@${a.activeAt ?? ''}`,
        name: a.labels?.alertname ?? '(未命名告警)',
        severity: a.labels?.severity ?? 'info',
        state: a.state ?? 'active',
        description: a.annotations?.description ?? a.annotations?.summary ?? '',
        activeAt: a.activeAt ?? null,
        value: a.value ?? null,
      }))
      .filter((it) => it.state === 'firing' || it.state === 'pending');

    return res.json({ code: 0, data: { unavailable: false, items, grafanaUrl } });
  } catch (err) {
    logger.warn('[admin/ops] prometheus alerts proxy failed', { error: err.message });
    return res.json({
      code: 0,
      data: { unavailable: true, reason: 'unreachable', items: [], grafanaUrl },
    });
  }
});

// ───────────────────────── AN-08：存储用量与清理归档 ─────────────────────────

/** 用量统计覆盖的主要业务表（按表体积展示口径，pg_total_relation_size 含索引/TOAST） */
const STORAGE_TABLES = [
  'users',
  'devices',
  'clipboard_items',
  'file_versions',
  'audit_logs',
  'notification_history',
  'ai_messages',
  'shared_links',
  'payment_orders',
];

/** bigint（pg 驱动返回字符串）→ number，保持 JSON 契约数值化 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/admin/ops/storage
 * 存储用量统计（AN-08，只读，requirePerm('admin.ops.view')）：
 *   totals  —— 剪贴板条目/总体积、文件条目/体积（与 planLimits SUM(content_size) 同口径交叉可对账）、DB 总大小；
 *   tables  —— 主要业务表 pg_total_relation_size 倒序 TOP；
 *   topUsers —— 用户 × 用量 TOP10（条目数 / 体积 / 文件数 / 文件体积）。
 */
router.get('/storage', requirePerm('admin.ops.view'), async (_req, res) => {
  try {
    const [totalsRes, filesRes, topRes, tablesRes, dbSizeRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS items, COALESCE(SUM(content_size), 0)::bigint AS total_bytes
         FROM clipboard_items`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS items, COALESCE(SUM(content_size), 0)::bigint AS total_bytes
         FROM clipboard_items WHERE content_type = 'file'`
      ),
      pool.query(
        `SELECT u.id, u.nickname,
                COUNT(*)::int AS item_count,
                COALESCE(SUM(ci.content_size), 0)::bigint AS total_bytes,
                COUNT(*) FILTER (WHERE ci.content_type = 'file')::int AS file_count,
                COALESCE(SUM(ci.content_size) FILTER (WHERE ci.content_type = 'file'), 0)::bigint AS file_bytes
         FROM clipboard_items ci
         JOIN users u ON u.id = ci.user_id
         GROUP BY u.id, u.nickname
         ORDER BY SUM(ci.content_size) DESC NULLS LAST
         LIMIT 10`
      ),
      pool.query(
        `SELECT c.relname AS table_name, pg_total_relation_size(c.oid)::bigint AS total_bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1)
         ORDER BY pg_total_relation_size(c.oid) DESC`,
        [STORAGE_TABLES]
      ),
      pool.query(`SELECT pg_database_size(current_database())::bigint AS db_bytes`),
    ]);

    return res.json({
      code: 0,
      data: {
        totals: {
          itemCount: totalsRes.rows[0]?.items ?? 0,
          totalBytes: toNum(totalsRes.rows[0]?.total_bytes),
          fileCount: filesRes.rows[0]?.items ?? 0,
          fileBytes: toNum(filesRes.rows[0]?.total_bytes),
          dbBytes: toNum(dbSizeRes.rows[0]?.db_bytes),
        },
        tables: tablesRes.rows.map((r) => ({
          table: r.table_name,
          totalBytes: toNum(r.total_bytes),
        })),
        topUsers: topRes.rows.map((r) => ({
          id: r.id,
          nickname: r.nickname || '',
          itemCount: r.item_count,
          totalBytes: toNum(r.total_bytes),
          fileCount: r.file_count,
          fileBytes: toNum(r.file_bytes),
        })),
      },
    });
  } catch (err) {
    logger.error('[admin/ops] storage stats failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取存储用量失败' });
  }
});

/**
 * POST /api/admin/ops/cleanup
 * 清理归档手动触发（AN-08，requirePerm('admin.ops.view') + reason 必填审计）：
 *   复用 db/cleanup.js（过期条目/验证码/通知/墓碑 + 审计归档）与
 *   services/fileRetentionCleanup.js（文件保留期 + 磁盘遗留物清扫）现有逻辑。
 *   受 system_configs.storage_cleanup_enabled 总开关控制（关闭时 400 拒绝）。
 */
router.post('/cleanup', requirePerm('admin.ops.view'), async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({ code: 4000, message: '原因必填（将写入审计日志）' });
  }

  try {
    const enabled = await readConfigBool('storage_cleanup_enabled', true);
    if (!enabled) {
      return res.status(400).json({
        code: 4000,
        message: '存储清理已被关闭（system_configs.storage_cleanup_enabled = false）',
      });
    }

    const result = await runManualCleanup();
    await logAuditEvent({
      userId: req.user.userId,
      action: 'admin.ops.storage.cleanup',
      resourceType: 'ops',
      resourceId: 'storage_cleanup',
      details: { reason, result },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    logger.info('[admin/ops] manual cleanup executed', { operator: req.user.userId, result });

    return res.json({
      code: 0,
      data: result,
      message: result.expired?.error || result.fileRetentionError
        ? '清理已执行（部分失败，详见结果）'
        : '清理任务已执行',
    });
  } catch (err) {
    logger.error('[admin/ops] manual cleanup failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: `清理执行失败：${err.message}` });
  }
});

export default router;

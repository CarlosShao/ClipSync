// =============================================
// Admin Console · 运维监控 APIs（方案三 CO-40 · ops overview；CO-33 · 备份可视化；CO-42 · 部署形态）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/ops', opsRouter) → GET /api/admin/ops/overview
//                                       GET /api/admin/ops/backups
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
import { getMetricsSnapshot, getMetricsSeries } from '../../middleware/metrics.js';
import { performance } from 'perf_hooks';
import pool from '../../db/pool.js';
import { getRedisClient } from '../../utils/redis-client.js';
import { logger } from '../../utils/logger.js';
import { requirePerm } from '../../middleware/adminAuth.js';

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
 * GET /api/admin/ops/overview
 * 运维概览聚合（requirePerm('admin.ops.view')）：健康探针 + 版本/运行时长 +
 * 进程内存 + 近端请求/错误指标 + 部署形态（CO-42），全部来自既有组件，不新增采集器。
 */
router.get('/overview', requirePerm('admin.ops.view'), async (_req, res) => {
  try {
    const [version, db, redis, metrics, deployment, grafanaUrl] = await Promise.all([
      readVersion(),
      probeDb(),
      probeRedis(),
      readMetricsSnapshot(),
      detectDeployment(),
      readGrafanaUrl(),
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

export default router;

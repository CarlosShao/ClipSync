import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { getFeatureFlags } from '../utils/featureFlags.js';
import { getClientPolicies } from '../utils/clientPolicies.js';
import { logger } from '../utils/logger.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
// GH-01：下载地址解析（发布单 url > RELEASE_DOWNLOAD_BASE_URL > system_configs），
// 取代此前的虚构域名占位回退。
// ⚠️ 合并提示：原 `import { ORIGINS } from '../../../shared/domains.js'`（域名统一子代理所加）
// 在本次改动后已无消费方——本文件唯一用处就是那个被删掉的 example.com 式兜底，
// 故一并移除。若域名统一分支另有需要，按需恢复该 import。
import { resolvePlatformDownload } from '../utils/releaseArtifacts.js';

const router = Router();

// GET /api/app/feature-flags — 面向客户端的功能开关快照（公开只读）。
// 仅暴露面向客户端的 5 个开关键；客户端启动时拉取一次，并监听 WS `feature_flags.updated` 即时刷新。
const CLIENT_FLAG_KEYS = Object.freeze([
  'enable_subscription',
  'enable_ai_agent',
  'enable_public_sharing',
  'enable_2fa',
  'signup_waitlist',
]);

router.get('/feature-flags', async (_req, res) => {
  try {
    const all = await getFeatureFlags();
    const flags = Object.fromEntries(
      CLIENT_FLAG_KEYS.filter((k) => k in all).map((k) => [k, all[k]])
    );
    res.json({ flags, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read feature flags' });
  }
});

// GET /api/app/policies — 面向客户端的策略下发快照（AN-02，公开只读 optionalAuth）。
// 仅暴露 { value, allowUserOverride }，不含运营侧元数据（name/consumer 等只在 /api/admin/policies）。
// 缓存：ETag（快照内容 SHA-256）+ Cache-Control 30s 短缓存；If-None-Match 命中回 304。
// 客户端启动拉取一次 + 监听 WS `policies.updated` 即时刷新（未配置策略 = 目录默认值，零行为变化）。
router.get('/policies', optionalAuth, async (req, res) => {
  try {
    const policies = await getClientPolicies();
    // ETag 只基于策略内容（不掺时间戳，避免分钟漂移造成缓存无谓失效）
    const etag = `"${crypto.createHash('sha256').update(JSON.stringify(policies)).digest('hex').slice(0, 32)}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=30');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.json({ policies, updatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error('[app/policies] snapshot failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to read client policies' });
  }
});

// ───────────────────────── 版本与发布（AN-04） ─────────────────────────

// 已发布版本 60s 进程内缓存：管理台发布/回滚后最多延迟 60s 对客户端生效，
// 避免每次 About/更新检查都打库（app_releases 行数极小，缓存只为削查询频次）。
let releaseCache = { data: null, expiresAt: 0 };

/**
 * 取最新已发布版本（is_published=true 按 published_at 倒序第一条）。
 * 读库失败返回 null（调用方降级为旧硬编码行为，更新检查不可用 ≠ 服务不可用）。
 */
async function getLatestPublishedRelease() {
  if (releaseCache.data !== null && Date.now() < releaseCache.expiresAt) {
    return releaseCache.data;
  }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM app_releases
       WHERE is_published
       ORDER BY published_at DESC
       LIMIT 1`
    );
    releaseCache = { data: rows[0] || null, expiresAt: Date.now() + 60_000 };
  } catch (err) {
    // 表未迁移/库抖动：不写缓存，下次请求重试
    logger.warn('[app/releases] latest release query failed', { error: err.message });
    return null;
  }
  return releaseCache.data;
}

/** 宽松语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0；非法版本返回 null */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? m.slice(1).map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// GET /api/app/version - 返回当前版本信息（AN-04：读最新已发布版本，无发布记录时降级 package.json）
router.get('/version', async (req, res) => {
  try {
    const packagePath = path.resolve('package.json');
    const packageData = JSON.parse(await fs.readFile(packagePath, 'utf-8'));

    let release = null;
    try {
      release = await getLatestPublishedRelease();
    } catch (err) {
      logger.warn('[app/version] release lookup failed', { error: err.message });
    }

    res.json({
      // 有已发布版本 → 返回该版本号；否则维持 package.json 版本
      version: release?.version || packageData.version || '0.1.0',
      name: packageData.name || 'clipsync-server',
      description: packageData.description || '',
      releaseDate:
        release?.release_date?.toISOString?.().slice(0, 10) ??
        release?.release_date ??
        null,
      notes: release?.notes || '',
      forceUpdate: Boolean(release?.force_update),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read version info' });
  }
});

// ───────────────────────── 公告（CO-35） ─────────────────────────

// 当前用户是否命中 pro_plus 受众（有生效中 Pro/Enterprise 订阅）
async function userIsProPlus(userId) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id = $1
       AND sp.name IN ('Pro', 'Enterprise')
       AND us.status IN ('active', 'trialing', 'trial')
     LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

/**
 * GET /api/app/announcements — 客户端公告拉取（optionalAuth，公开可达）。
 * 受众过滤：all 全部可见；pro_plus 仅 Pro/Enterprise（含未登录=false）；free 仅非 Pro+。
 * 未登录只读 audience='all'；响应不含已读标记——已读状态由客户端本地管理，
 * 回执走 POST /announcements/:id/read（登录后）。最新 20 条。
 */
router.get('/announcements', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;

    let isProPlus = false;
    if (userId) {
      try {
        isProPlus = await userIsProPlus(userId);
      } catch (err) {
        logger.warn('[app/announcements] pro_plus probe failed', { error: err.message });
      }
    }

    const { rows } = await pool.query(
      `SELECT id, title, content, audience, display_mode, created_at
       FROM admin_announcements
       ORDER BY created_at DESC
       LIMIT 20`,
    );

    const announcements = rows
      .filter((row) => {
        if (row.audience === 'all') return true;
        if (!userId) return false;
        if (row.audience === 'pro_plus') return isProPlus;
        if (row.audience === 'free') return !isProPlus;
        return false;
      })
      .map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        audience: row.audience,
        displayMode: row.display_mode,
        sentAt: row.created_at?.toISOString?.() ?? row.created_at,
      }));

    // AN-05：登录用户本次拉取到的可见公告 → 记真实触达（057 触达表，channel='pull'，幂等去重）。
    // 离线用户下次上线拉取即被计入送达口径；fire-and-forget，记录失败不影响拉取响应。
    if (userId && announcements.length > 0) {
      pool
        .query(
          `INSERT INTO admin_announcement_deliveries (announcement_id, user_id, first_channel)
           SELECT id, $2, 'pull' FROM admin_announcements WHERE id = ANY($1::uuid[])
           ON CONFLICT (announcement_id, user_id) DO NOTHING`,
          [announcements.map((a) => a.id), userId],
        )
        .catch((err) => {
          logger.warn('[app/announcements] delivery record failed', { userId, error: err.message });
        });
    }

    return res.json({ announcements });
  } catch (err) {
    logger.error('[app/announcements] list failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to load announcements' });
  }
});

/**
 * POST /api/app/announcements/:id/read — 公告已读回执（authenticateToken）。
 * 幂等 upsert（PK 冲突即忽略）；click_count 仅首次回执时 +1（真实触达口径，052）。
 */
router.post('/announcements/:id/read', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid announcement id' });
    }

    const inserted = await pool.query(
      `INSERT INTO admin_announcement_reads (announcement_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`,
      [id, userId],
    );
    if (inserted.rowCount > 0) {
      await pool.query(
        'UPDATE admin_announcements SET click_count = click_count + 1 WHERE id = $1',
        [id],
      );
    }
    return res.json({ code: 0 });
  } catch (err) {
    logger.error('[app/announcements] read receipt failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to record read receipt' });
  }
});

// GET /api/app/updates/latest - Tauri updater 动态更新端点（AN-04，公开只读）。
// 查询参数：target（Tauri {{target}}，如 windows-x86_64）、current_version（{{current_version}}）、
//           cid（可选：客户端匿名桶 id；缺省用 req.ip 做灰度分桶，保证同桶判定稳定）。
// 有更新 → 200 { version, notes, pub_date, platforms: { [target]: {...} }, force_update }；
// 无更新（已是最新 / 未发布 / 灰度未命中 / 该平台无产物）→ 204 No Content（Tauri 视为最新）。
router.get('/updates/latest', async (req, res) => {
  try {
    const target = typeof req.query.target === 'string' ? req.query.target : 'windows-x86_64';
    const currentVersion =
      typeof req.query.current_version === 'string' ? req.query.current_version : '0.1.0';

    const release = await getLatestPublishedRelease();
    if (!release) {
      return res.status(204).end();
    }

    // 版本对比：仅当最新已发布版本 > 客户端当前版本时下发更新
    const cmp = compareVersions(release.version, currentVersion);
    if (cmp === null) {
      logger.warn('[app/updates] invalid release version in DB', { version: release.version });
      return res.status(204).end();
    }
    if (cmp <= 0) {
      return res.status(204).end();
    }

    // 灰度分桶：sha1(cid|version) % 100 < rollout_percent；同桶稳定命中/不命中
    const bucket = (typeof req.query.cid === 'string' && req.query.cid) || req.ip || 'unknown';
    const hash = crypto.createHash('sha1').update(`${bucket}:${release.version}`).digest('hex');
    const bucketPct = parseInt(hash.slice(0, 8), 16) % 100;
    if (bucketPct >= release.rollout_percent) {
      return res.status(204).end();
    }

    // 该平台无下载产物 → 视为对此客户端无更新（避免返回空 url 让 Tauri 报错）
    const platformEntry = release.platforms?.[target];
    if (!platformEntry || typeof platformEntry !== 'object' || !platformEntry.url) {
      return res.status(204).end();
    }

    const pubDate =
      release.published_at?.toISOString?.() ??
      release.release_date?.toISOString?.() ??
      new Date().toISOString();

    // force_update 为附加字段：Tauri 忽略未知键，桌面端可读它做强更交互（AN-04 预留）
    return res.json({
      version: release.version,
      notes: release.notes || '',
      pub_date: pubDate,
      platforms: { [target]: platformEntry },
      force_update: Boolean(release.force_update),
    });
  } catch (err) {
    logger.error('[app/updates] latest failed', { error: err.message });
    // 更新检查故障时按"无更新"降级，不让客户端更新流程硬失败
    return res.status(204).end();
  }
});

// GET /api/app/update.json - 旧版静态格式更新元数据（AN-04：去硬编码，读库降级兼容）
// 新桌面端已切到 /updates/latest；此端点为存量客户端兼容保留，无发布记录时维持旧行为。
router.get('/update.json', async (req, res) => {
  const currentVersion =
    typeof req.query.current_version === 'string' ? req.query.current_version : '0.1.0';

  let release = null;
  try {
    release = await getLatestPublishedRelease();
  } catch (err) {
    logger.warn('[app/update.json] release lookup failed', { error: err.message });
  }

  const cmp = release ? compareVersions(release.version, currentVersion) : null;
  const hasUpdate = cmp === 1;

  if (!hasUpdate) {
    return res.json({
      version: currentVersion,
      notes: 'No update available',
      pubDate: new Date().toISOString(),
    });
  }

  const windowsEntry = release.platforms?.['windows-x86_64'];
  // GH-01：该平台无产物时不再伪造下载链接。
  // /updates/latest 对同场景返回 204（Tauri 视为最新），但本端点契约要求带 platforms.url，
  // 旧实现回退到一个虚构域名——客户端会真去请求并 404/超时，运维侧看不出根因。
  // 现在改为显式表达「服务器未配置下载地址」：410 Gone + 机器可读标记。
  // 下载地址来源优先级见 utils/releaseArtifacts.js（发布单 url > 环境变量 > system_configs）。
  const artifact = await resolvePlatformDownload(
    'windows-x86_64',
    release.version,
    windowsEntry
  );
  if (!artifact.url) {
    logger.warn('[app/update.json] windows-x86_64 artifact url unconfigured', {
      version: release.version,
      reason: artifact.unconfigured,
    });
    return res.status(410).json({
      error: '下载地址未配置',
      unconfigured: artifact.unconfigured,
      version: release.version,
      notes: release.notes || 'New version available',
    });
  }

  res.json({
    version: release.version,
    notes: release.notes || 'New version available',
    pubDate: release.published_at?.toISOString?.() ?? new Date().toISOString(),
    forceUpdate: Boolean(release.force_update),
    platforms: {
      'windows-x86_64': { ...windowsEntry, url: artifact.url },
    },
  });
});

export default router;

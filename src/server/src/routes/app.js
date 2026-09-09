import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { getFeatureFlags } from '../utils/featureFlags.js';
import { getClientPolicies } from '../utils/clientPolicies.js';
import { logger } from '../utils/logger.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';

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

// GET /api/app/version - 返回当前版本信息
router.get('/version', async (req, res) => {
  try {
    const packagePath = path.resolve('package.json');
    const packageData = JSON.parse(await fs.readFile(packagePath, 'utf-8'));

    res.json({
      version: packageData.version || '0.1.0',
      name: packageData.name || 'clipsync-server',
      description: packageData.description || '',
      releaseDate: '2026-06-24',
      notes: 'Bug fixes and performance improvements',
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

// GET /api/app/update.json - Tauri updater 需要的更新元数据
router.get('/update.json', (req, res) => {
  const currentVersion = '0.1.0';
  const latestVersion = '0.1.0'; // 生产环境中从配置或数据库读取
  
  // 当前没有新版本
  const hasUpdate = false;
    
  if (!hasUpdate) {
    return res.json({
      version: currentVersion,
      notes: 'No update available',
      pubDate: new Date().toISOString(),
    });
  }
    
  // 有新版本时返回下载信息
  res.json({
    version: latestVersion,
    notes: 'New version available with bug fixes and performance improvements',
    pubDate: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        url: `https://example.com/downloads/clipsync_${latestVersion}_x64_en-US.msi`,
      },
    },
  });
});

export default router;

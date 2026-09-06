// =============================================
// Admin Console · 公告下发 APIs（Admin Console · T-A5）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/announcements', announcementsRouter)
//     → POST /api/admin/announcements  下发公告（requirePerm('admin.announce.send')）
//     → GET  /api/admin/announcements  发送历史（新记录在前）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
//
// 响应契约（src/admin-console/src/api/types.ts Announcement / SendAnnouncementPayload 逐字段对齐）：
//   Announcement: { id, title, content, audience: 'all'|'pro_plus'|'free',
//                   displayMode: 'once'|'persistent', sentAt, deliveredCount?, clickedCount? }
//   sentAt 形态 'YYYY-MM-DD HH:mm'（前端设置页记录列表按 sentAt.slice(5,10) 展示日期）
//
// 语义契约（src/admin-console/src/mocks/handlers.test.ts 固化）：
//   - title/content 为空（含纯空白）→ 400 { code: 40002, message: '公告标题与内容不能为空' }
//   - 写审计 admin.announcement.send（敏感操作，resourceType=announcement）
//
// 存储与群发接入说明（工单 T-A5）：
//   - 落库 admin_announcements（迁移 044）；delivered_count = 下发时刻命中受众的用户数
//     （all=全部用户；pro_plus=生效中 Pro/Enterprise 订阅用户；free=其余用户）
//   - services/notificationService.js 现仅有 per-user createNotification（单用户写
//     notification_history），无群发 API。故本接口只做受众计数 + 落表，
//     per-user 扇出待通知服务提供批量通道后接入（见下方 TODO）。
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const VALID_AUDIENCES = new Set(['all', 'pro_plus', 'free']);
const VALID_DISPLAY_MODES = new Set(['once', 'persistent']);
const HISTORY_LIMIT = 100;

// ───────────────────────── 通用片段 ─────────────────────────

/** timestamptz → 'YYYY-MM-DD HH:mm'（Announcement.sentAt 契约形态） */
function formatDateTimeMinute(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** DB 公告行 → 前端 Announcement 契约 */
function mapAnnouncementRow(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    audience: row.audience,
    displayMode: row.display_mode,
    sentAt: formatDateTimeMinute(row.created_at),
    deliveredCount: Number(row.delivered_count ?? 0),
    clickedCount: Number(row.click_count ?? 0),
  };
}

/**
 * 统计受众用户数（delivered_count 口径；计数失败不阻塞下发，回 0）。
 * 生效中订阅：status IN ('active','trialing','trial')（'trial' 为历史库值），
 * 套餐以 subscription_plans.name ∈ ('Pro','Enterprise') 为准（004/012 种子词表）。
 */
async function countAudience(audience) {
  try {
    if (audience === 'all') {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM users`);
      return rows[0] ? Number(rows[0].cnt) : 0;
    }
    if (audience === 'pro_plus') {
      const { rows } = await pool.query(`
        SELECT COUNT(DISTINCT us.user_id)::int AS cnt
        FROM user_subscriptions us
        JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE sp.name IN ('Pro', 'Enterprise')
          AND us.status IN ('active', 'trialing', 'trial')`);
      return rows[0] ? Number(rows[0].cnt) : 0;
    }
    // free：全部用户中当前无生效 Pro/Enterprise 订阅者（与 pro_plus 互斥，不重复计数）
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_subscriptions us
        JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE us.user_id = u.id
          AND sp.name IN ('Pro', 'Enterprise')
          AND us.status IN ('active', 'trialing', 'trial')
      )`);
    return rows[0] ? Number(rows[0].cnt) : 0;
  } catch (err) {
    logger.warn('[admin/announcements] audience count failed', { audience, error: err.message });
    return 0;
  }
}

// ───────────────────────── 下发公告 ─────────────────────────

/**
 * POST /api/admin/announcements  body { title, content, audience?, displayMode? }
 * 下发公告（requirePerm('admin.announce.send')）：落表 admin_announcements +
 * 受众计数 + 写审计 admin.announcement.send（敏感操作）。
 */
router.post('/', requirePerm('admin.announce.send'), async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';

    if (!title || !content) {
      return res.status(400).json({ code: 40002, message: '公告标题与内容不能为空' });
    }

    const audience = body.audience === undefined || body.audience === null ? 'all' : body.audience;
    if (!VALID_AUDIENCES.has(audience)) {
      return res.status(400).json({ code: 4000, message: 'audience 取值不合法（all / pro_plus / free）' });
    }
    const displayMode =
      body.displayMode === undefined || body.displayMode === null ? 'once' : body.displayMode;
    if (!VALID_DISPLAY_MODES.has(displayMode)) {
      return res.status(400).json({ code: 4000, message: 'displayMode 取值不合法（once / persistent）' });
    }

    // TODO(群发接入): notificationService 现无批量下发 API，per-user 扇出
    // （createNotification → notification_history / 推送通道）待通知服务提供
    // 批量接口后在此接入；当前 delivered_count 先落受众用户数。
    const deliveredCount = await countAudience(audience);

    const { rows } = await pool.query(
      `INSERT INTO admin_announcements
         (title, content, audience, display_mode, sent_by, delivered_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, content, audience, display_mode, sent_by, delivered_count, click_count, created_at`,
      [title, content, audience, displayMode, req.user?.userId ?? null, deliveredCount]
    );
    const created = rows[0];

    // 审计：admin.announcement.send（敏感操作）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.announcement.send',
      resourceType: 'announcement',
      resourceId: String(created.id),
      details: {
        title,
        audience,
        display: displayMode,
        delivered: deliveredCount,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/announcements] sent', {
      id: created.id,
      audience,
      deliveredCount,
      operator: req.user?.userId,
    });

    return res.status(201).json({
      code: 0,
      data: mapAnnouncementRow(created),
      message: '公告已下发',
    });
  } catch (err) {
    logger.error('[admin/announcements] send failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '公告下发失败' });
  }
});

// ───────────────────────── 发送历史 ─────────────────────────

/**
 * GET /api/admin/announcements
 * 公告发送历史（新记录在前；前端设置页一次性渲染，上限 100 条）。
 */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, content, audience, display_mode, sent_by, delivered_count, click_count, created_at
       FROM admin_announcements
       ORDER BY created_at DESC
       LIMIT $1`,
      [HISTORY_LIMIT]
    );
    return res.json({ code: 0, data: rows.map(mapAnnouncementRow) });
  } catch (err) {
    logger.error('[admin/announcements] history failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取公告历史失败' });
  }
});

export default router;

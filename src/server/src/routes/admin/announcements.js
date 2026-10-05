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
//                   displayMode: 'once'|'persistent', sentAt,
//                   deliveredCount?, reachedCount?, readCount?, clickedCount? }
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
import { broadcastToAllClientsDetailed } from '../../ws/server.js';
import { recordDeliveries } from '../../services/announcementDelivery.js';

const router = Router();

const VALID_AUDIENCES = new Set(['all', 'pro_plus', 'free']);
const VALID_DISPLAY_MODES = new Set(['once', 'persistent']);
const HISTORY_LIMIT = 100;
// 与其它 admin 路由同口径的 UUID 形状校验（撤回路由用）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // AF-22 口径：deliveredCount = 受众人数（非真实触达）；readCount = 真实已读（052 回执表）；
    // reachedCount = 真实送达（057 触达表：WS 推送成功 ∪ 上线拉取）；clickCount = 点击
    deliveredCount: Number(row.delivered_count ?? 0),
    reachedCount: Number(row.reached_count ?? 0),
    readCount: Number(row.read_count ?? 0),
    clickedCount: Number(row.click_count ?? 0),
    // 2026-10-05（迁移 085）：软撤回时间。null = 正常；非 null = 已撤回（客户端拉取侧过滤，
    // 管理台历史里仍可见并打标 —— 撤回后"当初发给了谁、多少人看过"正是最需要的证据）
    withdrawnAt: row.withdrawn_at ? formatDateTimeMinute(row.withdrawn_at) : null,
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

    // AN-05：全端实时推送（此前只落库，在线客户端要等下次拉取才可见——用户感知为"发了没反应"）+
    // 真实触达记录（057 表）：WS 推送成功的用户按受众过滤后写入触达表（channel='ws'）；
    // 失败只 warn，不阻塞下发响应。在线客户端随后会拉取公告 → app.js 以 channel='pull' 幂等兜底。
    try {
      const { userIds } = broadcastToAllClientsDetailed({
        type: 'announcement.new',
        announcementId: created.id,
      });
      if (userIds.length > 0) {
        await recordDeliveries({
          announcementId: created.id,
          audience,
          userIds,
          channel: 'ws',
        });
      }
    } catch (pushErr) {
      logger.warn('[admin/announcements] ws push / delivery record failed', {
        id: created.id,
        error: pushErr.message,
      });
    }

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
router.get('/', requirePerm('admin.announce.view'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.content, a.audience, a.display_mode, a.sent_by,
              a.delivered_count, a.click_count, a.created_at, a.withdrawn_at,
              -- AN-05：真实送达 = 057 触达表去重用户数（WS 推送成功 ∪ 上线拉取）
              (SELECT COUNT(*)::int FROM admin_announcement_deliveries d
                WHERE d.announcement_id = a.id) AS reached_count,
              (SELECT COUNT(*)::int FROM admin_announcement_reads r
                WHERE r.announcement_id = a.id) AS read_count
       FROM admin_announcements a
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [HISTORY_LIMIT]
    );
    return res.json({ code: 0, data: rows.map(mapAnnouncementRow) });
  } catch (err) {
    logger.error('[admin/announcements] history failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取公告历史失败' });
  }
});

// ───────────────────────── 撤回公告 ─────────────────────────

/**
 * POST /api/admin/announcements/:id/withdraw  body { reason }
 * 软撤回公告（2026-10-05 新增，迁移 085）。
 *
 * 为什么之前只能改库：公告**只能发、不能撤**。发错内容（写错价格、发错受众、
 * 把内部草稿发出去）时客户端 `GET /api/app/announcements` 仍会一直返回它，
 * 而表上根本没有表示"撤回"的列 —— 改库连语义都没有。
 *
 * 为什么是**软**撤回（加列）而不是 DELETE：
 *   `admin_announcement_deliveries`（057 触达）与 `admin_announcement_reads`（052 已读）
 *   都是 `ON DELETE CASCADE` —— 硬删会**连带删掉送达/已读/点击统计**，而那正是
 *   "这条公告发给了谁、多少人看过"的唯一证据；发错之后恰恰最需要它。
 *
 * 口径：
 *   - 权限沿用 `admin.announce.send`（撤回是下发的逆操作，能发的才该能撤）；
 *   - 已撤回 → 409（明确告知撤回时间，而不是静默"再撤一次"）；
 *   - 原因必填；审计 `admin.announce.withdraw` 记标题/受众/下发时受众数/点击数/原因；
 *   - 客户端拉取侧从此过滤（`routes/app.js` 的 `WHERE withdrawn_at IS NULL`），
 *     但**已读/送达数据保留**，管理台历史里仍能看到并标记为「已撤回」；
 *   - **不通知用户**：撤回是把它从"看得见"变成"看不见"，再发一条"某公告已撤回"
 *     只会扩大影响面（要说明情况应该再发一条正常公告）。
 */
router.post('/:id/withdraw', requirePerm('admin.announce.send'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '公告 ID 不合法' });
    }
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '撤回必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const { rows } = await pool.query(
      `SELECT id, title, audience, display_mode, delivered_count, click_count, created_at, withdrawn_at
         FROM admin_announcements WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '公告不存在' });
    }
    const existing = rows[0];
    if (existing.withdrawn_at) {
      return res.status(409).json({
        code: 40906,
        reason: 'ALREADY_WITHDRAWN',
        withdrawnAt: formatDateTimeMinute(existing.withdrawn_at),
        message: `该公告已于 ${formatDateTimeMinute(existing.withdrawn_at)} 撤回，无需重复操作`,
      });
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE admin_announcements
          SET withdrawn_at = NOW()
        WHERE id = $1
        RETURNING id, title, content, audience, display_mode, sent_by,
                  delivered_count, click_count, created_at, withdrawn_at`,
      [id]
    );
    const updated = updatedRows[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.announce.withdraw',
      resourceType: 'announcement',
      resourceId: String(existing.id),
      details: {
        title: existing.title,
        audience: existing.audience,
        display: existing.display_mode,
        // 留痕：撤回时这条公告已经发出去了多少、被点了多少（事后追责/复盘靠它）
        delivered: Number(existing.delivered_count ?? 0),
        clicked: Number(existing.click_count ?? 0),
        reason,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/announcements] withdrawn', {
      id: existing.id,
      audience: existing.audience,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: mapAnnouncementRow(updated),
      message: '公告已撤回：客户端不再展示，历史与送达/已读统计保留',
    });
  } catch (err) {
    logger.error('[admin/announcements] withdraw failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '撤回公告失败' });
  }
});

export default router;

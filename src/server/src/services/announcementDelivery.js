// =============================================
// AN-05：公告真实触达（送达）记录服务
//
// 口径（工单 AN-05 + AF-22 第 3 点预留）：送达 = WS 推送成功的用户 ∪ 上线后
// 拉取到公告的用户，按公告受众过滤后写入 057 触达表 admin_announcement_deliveries
// （announcement_id + user_id 唯一，首次触达渠道记 first_channel：ws / pull）。
// 管理台列表 reached_count = 本表去重用户数；已读仍走 052 回执表（AF-22 口径不变）。
//
// 记录失败只 warn 不抛错——触达是统计口径，绝不能阻塞下发主链路。
// =============================================

import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/** 受众过滤片段（与 admin/announcements.js countAudience 同一语义：Pro/Enterprise 生效中订阅） */
function audienceFilterSql(audience) {
  const PRO_PLUS_EXISTS = `EXISTS (
    SELECT 1 FROM user_subscriptions us
    JOIN subscription_plans sp ON sp.id = us.plan_id
    WHERE us.user_id = u.id
      AND sp.name IN ('Pro', 'Enterprise')
      AND us.status IN ('active', 'trialing', 'trial'))`;
  if (audience === 'pro_plus') return PRO_PLUS_EXISTS;
  if (audience === 'free') return `NOT ${PRO_PLUS_EXISTS}`;
  return 'TRUE'; // all
}

/**
 * 记录触达（幂等：ON CONFLICT DO NOTHING，保留首次渠道）。
 * @param {object} p
 * @param {string} p.announcementId 公告 id
 * @param {string} p.audience 受众（all / pro_plus / free）——用于按受众过滤用户
 * @param {string[]} p.userIds 待记录用户 id 列表
 * @param {'ws'|'pull'} p.channel 首次触达渠道
 * @returns {Promise<number>} 实际新增行数（失败回 0）
 */
export async function recordDeliveries({ announcementId, audience, userIds, channel }) {
  if (!announcementId || !Array.isArray(userIds) || userIds.length === 0) return 0;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO admin_announcement_deliveries (announcement_id, user_id, first_channel)
       SELECT $1, u.id, $4
       FROM users u
       WHERE u.id = ANY($2::uuid[]) AND ${audienceFilterSql(audience)}
       ON CONFLICT (announcement_id, user_id) DO NOTHING`,
      [announcementId, userIds, channel]
    );
    return rowCount ?? 0;
  } catch (err) {
    logger.warn('[announcementDelivery] record failed', {
      announcementId,
      audience,
      channel,
      error: err.message,
    });
    return 0;
  }
}

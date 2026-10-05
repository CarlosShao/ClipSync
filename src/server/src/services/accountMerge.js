/**
 * 账号合并（管理员显式指定「把 duplicate 并入 canonical」）。
 *
 * 与 `routes/auth.js` 里那份**登录时自动合并**的关系（务必先读这段）：
 *   - 那份是**自动发现**重复账号的（`email ILIKE` / `nickname ILIKE`），匹配依据是
 *     用户可自由设置的昵称与**未验证**的邮箱，因此被 `IDENTITY_MERGE_ENABLED !== 'true'`
 *     关掉（注释写明：攻击者改个昵称/邮箱就能把别人的剪贴板整体搬进自己账号）。
 *   - 本模块只做**执行**：canonical / duplicate 由调用方显式给定，**不做任何模糊匹配**。
 *   - 两份的关系：登录那份**暂未改为调用本模块**（它是休眠代码、无测试覆盖，
 *     重构它的收益不抵"静默改坏"的风险）；两处注释互相指向，避免后人误改其中一份。
 *
 * 本模块补掉的、登录那份**没有**做的事（都是真实缺口）：
 *   ① `phone_hash` / `email_hash` **没有清**：而登录是按 `phone = $1 OR phone_hash = $2`
 *      查的，`merged_into` 全仓**只写不读** ⇒ 被合并的账号**照样能登录**
 *      （旧实现只把 `phone` 加后缀，hash 列原样留着）。这里清掉三列并置 `is_active=false`。
 *   ② 被合并方的会话没吊销 ⇒ 合并后它还能继续同步。这里一并吊销。
 *   ③ 旧实现是一串裸查询、**没有事务** ⇒ 中途失败会留下"数据搬了一半"的账号。
 *      这里全程一个事务 + 两个用户的 advisory lock（串行化同一对账号的并发合并）。
 *
 * ⚠️ 合并的边界（不要以为"全搬"）：只搬 **clipboard_items** 与**生效中的订阅**。
 *    - `devices` **不搬**：`devices` 有 `UNIQUE(user_id, device_name)`，而两个账号通常都有
 *      同名设备（都叫 "Desktop"），直接改 user_id 会撞唯一键、把整个合并拖失败。
 *      旧实现也不搬。被合并方的设备行会随账号一起失效（is_active=false + 会话吊销）。
 *    - 其余归属该用户的资源（模板/共享链接/通知历史等）留在原账号，不搬。
 *    因此本函数的返回值把这些"没搬走的东西"一并报出来，让运营知道边界在哪。
 */
import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * @param {object} params
 * @param {string} params.canonicalUserId 保留的账号
 * @param {string} params.duplicateUserId 被并入并**退役**的账号
 * @param {number} params.confirmMovedClips 调用方回传的"预期搬走条数"（防手滑/防竞态）
 * @returns {Promise<
 *   | { ok: true, movedClips: number, movedSubscription: boolean, duplicateDeviceCount: number,
 *       canonicalNickname: string, duplicateNickname: string }
 *   | { ok: false, reason: string, [k: string]: unknown }>}
 */
export async function mergeAccountInto({ canonicalUserId, duplicateUserId, confirmMovedClips }) {
  if (!canonicalUserId || !duplicateUserId) {
    return { ok: false, reason: 'MISSING_USER_ID' };
  }
  if (canonicalUserId === duplicateUserId) {
    return { ok: false, reason: 'SAME_USER' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 串行化同一对账号的并发合并（与 markOrderPaid 用 advisory lock 同一套路）
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      `acct-merge:${canonicalUserId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      `acct-merge:${duplicateUserId}`,
    ]);

    const { rows } = await client.query(
      `SELECT u.id, u.phone, u.email, u.nickname, u.merged_into, u.is_active,
              r.level AS role_level
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ANY($1::uuid[])
          FOR UPDATE OF u`,
      [[canonicalUserId, duplicateUserId]]
    );
    const canonical = rows.find((r) => r.id === canonicalUserId);
    const duplicate = rows.find((r) => r.id === duplicateUserId);
    if (!canonical || !duplicate) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'USER_NOT_FOUND' };
    }
    if (canonical.merged_into || duplicate.merged_into) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: 'ALREADY_MERGED',
        canonicalMerged: Boolean(canonical.merged_into),
        duplicateMerged: Boolean(duplicate.merged_into),
      };
    }

    // ★内容计数闸：合并不是删除（数据是搬走），但流程不可逆（旧账号被退役、无"反合并"），
    // 所以要求调用方回传"预期搬走多少条"。对不上就拒 —— 既防手滑选错账号，
    // 也防"预览与执行之间又同步进来几条"的竞态。
    const { rows: clipCountRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM clipboard_items WHERE user_id = $1`,
      [duplicateUserId]
    );
    const clipCount = Number(clipCountRows[0]?.n) || 0;
    const expected =
      confirmMovedClips === undefined || confirmMovedClips === null || confirmMovedClips === ''
        ? null
        : Number(confirmMovedClips);
    if (expected !== clipCount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'CLIP_COUNT_MISMATCH', movedClips: clipCount };
    }

    // 订阅：只搬"生效中"的；两边都有生效订阅时**拒绝**（否则被合并方那段已付费的时间会凭空消失）
    const { rows: dupSubs } = await client.query(
      `SELECT us.id, sp.name AS plan_name
         FROM user_subscriptions us
         JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE us.user_id = $1 AND us.status = 'active'
        ORDER BY us.created_at DESC
        LIMIT 1`,
      [duplicateUserId]
    );
    const { rows: canonicalSubs } = await client.query(
      `SELECT us.id FROM user_subscriptions us WHERE us.user_id = $1 AND us.status = 'active' LIMIT 1`,
      [canonicalUserId]
    );
    if (dupSubs.length > 0 && canonicalSubs.length > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'SUBSCRIPTION_CONFLICT' };
    }

    const { rows: deviceRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM devices WHERE user_id = $1`,
      [duplicateUserId]
    );
    const duplicateDeviceCount = Number(deviceRows[0]?.n) || 0;

    // 1) 剪贴板整体搬走
    const moveResult = await client.query(
      `UPDATE clipboard_items SET user_id = $1 WHERE user_id = $2`,
      [canonicalUserId, duplicateUserId]
    );
    const movedClips = Number(moveResult.rowCount) || 0;

    // 2) 生效中的订阅搬走（前面的闸保证只有一个方向需要处理）
    let movedSubscription = false;
    if (dupSubs.length > 0) {
      const sub = dupSubs[0];
      await client.query(`UPDATE user_subscriptions SET user_id = $1 WHERE id = $2`, [
        canonicalUserId,
        sub.id,
      ]);
      // 快照同步（口径与 admin 的 grant 路由一致：subscription_status = 套餐名小写）
      await client.query(
        `UPDATE users SET subscription_status = $2, current_subscription_id = $3, updated_at = NOW()
          WHERE id = $1`,
        [canonicalUserId, String(sub.plan_name || '').toLowerCase() || 'active', sub.id]
      );
      movedSubscription = true;
    }

    // 3) 退役被合并账号
    //    ★phone_hash / email_hash / *_encrypted 必须清掉：登录按 `phone=$1 OR phone_hash=$2`
    //    查，而 `merged_into` 全仓只写不读 —— 不清 hash 的话这个账号**照样能登录**。
    await client.query(
      `UPDATE users
          SET merged_into = $1,
              phone = CASE WHEN phone IS NOT NULL THEN phone || '_merged' ELSE NULL END,
              phone_hash = NULL,
              phone_encrypted = NULL,
              email = NULL,
              email_hash = NULL,
              email_encrypted = NULL,
              nickname = nickname || '_merged',
              subscription_status = 'free',
              current_subscription_id = NULL,
              is_active = FALSE,
              deactivated_at = NOW(),
              deactivation_reason = 'merged_account',
              updated_at = NOW()
        WHERE id = $2`,
      [canonicalUserId, duplicateUserId]
    );

    // 4) 吊销被合并账号的全部会话（否则合并后它还能继续同步）
    await client.query(
      `UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW()
        WHERE user_id = $1 AND is_active = TRUE`,
      [duplicateUserId]
    );

    await client.query('COMMIT');

    logger.warn('[accountMerge] account merged (admin)', {
      canonicalUserId,
      duplicateUserId,
      movedClips,
      movedSubscription,
      duplicateDeviceCount,
    });

    return {
      ok: true,
      movedClips,
      movedSubscription,
      duplicateDeviceCount,
      canonicalNickname: canonical.nickname || '',
      duplicateNickname: duplicate.nickname || '',
      duplicatePhone: duplicate.phone || '',
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 回滚失败：原始错误更重要，吞掉
    }
    logger.error('[accountMerge] merge failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

export default { mergeAccountInto };

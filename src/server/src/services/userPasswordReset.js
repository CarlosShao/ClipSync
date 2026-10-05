/**
 * 临时密码重置 —— 管理台「代重置密码」与 AI 工具 `reset_user_password` **共用同一实现**。
 *
 * 为什么抽成一个模块：这条路径决定「客服能不能救回一个手机+邮箱双失效的账号」。
 * 两处各写一份必然漂 —— 一处调了 bcrypt cost、另一处忘了；一处吊销了会话、另一处没有
 *（实际上 AI 工具那份此前就**没有**吊销会话：重置了密码，但持有旧会话的人照样能用）。
 *
 * 口径（与注册/改密保持一致，逐条都能在 auth.js 找到对应）：
 *   - 临时密码 = 8 字符 base64url，来自 `crypto.randomBytes`（满足服务端「≥8 位」的最短要求，
 *     且随机性足够；不含 `+`/`/`，便于口头或工单转达）；
 *   - `bcrypt.hash(tempPassword, 12)` —— cost 12 与 `auth.js` 的注册/改密完全一致；
 *   - **审计里绝不出现密码**：调用方只记「谁给谁重置了」，凭据不落任何日志/审计行。
 *
 * 本模块**不做**的事（留给调用方，因为它们与 HTTP/AI 两套入口的语义不同）：
 * 权限校验、越级防护、原因必填、审计写入、把密码交给运营者。
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';

/** bcrypt cost：与 auth.js 的注册/改密一致（改这里等于改全站密码强度口径） */
const BCRYPT_COST = 12;

/** 生成临时密码：8 字符 base64url（`crypto` 随机，非 Math.random） */
export function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

/**
 * 重置某用户的密码为新的临时密码，并**吊销其全部活跃会话**。
 *
 * 吊销会话是刻意内建在这里的：密码被重置后，旧会话仍有效等于"重置了个寂寞"
 * —— 原先持有会话的人照样能用。吊销口径与 `admin/users.js` 的停用路径一致
 *（`is_active = FALSE, revoked_at = NOW()`）。
 *
 * @param {string} userId
 * @returns {Promise<{ tempPassword: string, sessionsRevoked: number }>}
 */
export async function resetUserPassword(userId) {
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);

  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
    passwordHash,
    userId,
  ]);

  const revoked = await pool.query(
    `UPDATE user_sessions
        SET is_active = FALSE, revoked_at = NOW()
      WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );

  return { tempPassword, sessionsRevoked: revoked.rowCount ?? 0 };
}

export default { generateTempPassword, resetUserPassword };

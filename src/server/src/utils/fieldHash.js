/**
 * phone/email 的派生哈希（`users.phone_hash` / `users.email_hash`）。
 *
 * 为什么必须只有一份：这个哈希是**登录查找键**。auth.js 用它在登录时按手机号/邮箱查用户
 *（`WHERE phone = $1 OR phone_hash = $2`），任何一处算法漂了 —— 盐不同、大小写归一不同、
 * 或者漏了某列 —— 都会让**一部分用户查不到自己**，而且现象是"某个人登录失败"这种极难定位的故障。
 *
 * 抽取前这里有**两份完全相同的实现**（`routes/auth.js` 与 `routes/aiTools.js`），
 * 注释都写着"与 auth.js 保持一致"。移动端/管理台新增换绑（2026-10-05）时又要写第三份，
 * 于是收敛到这里，谁也别再抄。
 *
 * ⚠️ 盐的取法**不可静默变更**：`ENCRYPTION_KEY` 前 16 字符，生产缺失即 fail-fast
 *（绝不回退到仓库里公开可知的兜底盐，那等于把哈希变成可离线爆破的）。非生产保留兜底，
 * 否则既有的 dev 数据会全部查不到。
 */
import crypto from 'node:crypto';

const HASH_SALT = (() => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENCRYPTION_KEY is required in production (phone/email hash salt); refusing to start'
      );
    }
    return 'CLIPSYNC_SALT_2026';
  }
  return key.substring(0, 16);
})();

/**
 * 计算字段值的 SHA-256 哈希（用于 O(1) 查询），返回 64 字符 hex。
 * 空值返回 `null`（而不是 hash 空串）——「没有这一列」与「这一列是空串」在库里是两回事。
 */
export function computeFieldHash(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value) + HASH_SALT).digest('hex');
}

export default { computeFieldHash };

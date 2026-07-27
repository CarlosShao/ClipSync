/**
 * 两步验证（2FA / TOTP）路由
 * - 设置页：setup / enable / disable / status（需认证）
 * - 登录挑战：verify-login（消费登录阶段下发的 challengeToken）
 *
 * 密钥以 encryptField 加密落库；备份码以 bcrypt 哈希数组存储。
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../db/pool.js';
import config from '../config.js';
import { authenticateToken } from '../middleware/auth.js';
import { encryptField, decryptField } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { createSessionAndGenerateToken } from './auth.js';
import { generateSecret, verifyToken, buildOtpauthUri } from '../utils/totp.js';

const router = Router();

const CHALLENGE_TTL = '5m';

/** 校验动态码或一次性备份码 */
async function verifyTokenOrBackup(secret, code, backupCodesJson) {
  if (verifyToken(secret, code)) return true;
  if (backupCodesJson) {
    try {
      const hashes = JSON.parse(backupCodesJson);
      for (const h of hashes) {
        if (await bcrypt.compare(String(code).trim(), h)) return true;
      }
    } catch {
      /* 忽略损坏的备份码字段 */
    }
  }
  return false;
}

// 查询 2FA 是否已启用
router.get('/2fa/status', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [req.user.userId]);
    res.json({ enabled: r.rows[0]?.two_factor_enabled || false });
  } catch (err) {
    logger.error('[2FA] status error', { error: err.message });
    res.status(500).json({ error: 'Failed to get 2FA status' });
  }
});

// 开启设置：生成待确认密钥（pending），返回 otpauth URI 供扫码
router.post('/2fa/setup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const secret = generateSecret();
    const otpauthUri = buildOtpauthUri(secret, req.user.userId || userId);
    await pool.query(
      'UPDATE users SET two_factor_pending_secret = $1, two_factor_enabled = FALSE WHERE id = $2',
      [encryptField(secret), userId]
    );
    res.json({ secret, otpauthUri });
  } catch (err) {
    logger.error('[2FA] setup error', { error: err.message });
    res.status(500).json({ error: 'Failed to start 2FA setup' });
  }
});

// 确认开启：校验动态码，落盘正式密钥 + 生成备份码
router.post('/2fa/enable', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required' });

    const r = await pool.query('SELECT two_factor_pending_secret FROM users WHERE id = $1', [userId]);
    const pending = r.rows[0]?.two_factor_pending_secret;
    if (!pending) return res.status(400).json({ error: 'No pending 2FA setup. Start setup first.' });

    const secret = decryptField(pending);
    if (!verifyToken(secret, code)) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // 生成 10 个备份码（8 位 hex 大写），以 bcrypt 哈希数组存储
    const backupCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase()
    );
    const backupHashes = JSON.stringify(backupCodes.map((c) => bcrypt.hashSync(c, 10)));

    await pool.query(
      `UPDATE users
       SET two_factor_secret = $1,
           two_factor_enabled = TRUE,
           two_factor_pending_secret = NULL,
           two_factor_backup_codes = $2
       WHERE id = $3`,
      [encryptField(secret), backupHashes, userId]
    );

    logger.info('[2FA] enabled', { userId });
    res.json({ success: true, backupCodes });
  } catch (err) {
    logger.error('[2FA] enable error', { error: err.message });
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

// 关闭：需提供动态码或备份码
router.post('/2fa/disable', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { code } = req.body;
    const r = await pool.query(
      'SELECT two_factor_secret, two_factor_backup_codes FROM users WHERE id = $1',
      [userId]
    );
    const row = r.rows[0];
    if (row?.two_factor_secret) {
      if (!code) return res.status(400).json({ error: 'Verification code is required to disable 2FA' });
      const secret = decryptField(row.two_factor_secret);
      if (!(await verifyTokenOrBackup(secret, code, row.two_factor_backup_codes))) {
        return res.status(400).json({ error: 'Invalid verification code' });
      }
    }
    await pool.query(
      `UPDATE users
       SET two_factor_enabled = FALSE,
           two_factor_secret = NULL,
           two_factor_pending_secret = NULL,
           two_factor_backup_codes = NULL
       WHERE id = $1`,
      [userId]
    );
    logger.info('[2FA] disabled', { userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('[2FA] disable error', { error: err.message });
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// 登录挑战：消费登录阶段下发的 challengeToken，校验动态码后签发正式会话
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { challengeToken, code } = req.body;
    if (!challengeToken || !code) {
      return res.status(400).json({ error: 'challengeToken and code are required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(challengeToken, config.jwt.secret);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired 2FA challenge' });
    }
    if (!decoded.twoFactorChallenge) {
      return res.status(401).json({ error: 'Invalid challenge token' });
    }

    const userId = decoded.userId;
    const r = await pool.query(
      `SELECT id, phone, email, nickname, avatar_url, phone_encrypted, email_encrypted,
              two_factor_enabled, two_factor_secret, two_factor_backup_codes
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = r.rows[0];
    if (!user || !user.two_factor_enabled) {
      return res.status(401).json({ error: '2FA not enabled for this user' });
    }

    const secret = decryptField(user.two_factor_secret);
    if (!(await verifyTokenOrBackup(secret, code, user.two_factor_backup_codes))) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    // 签发正式会话 + JWT（复用登录逻辑，保证 token 结构一致）
    const { token } = await createSessionAndGenerateToken(user, req);

    const phoneDecrypted = decryptField(user.phone_encrypted) || user.phone;
    const emailDecrypted = decryptField(user.email_encrypted) || user.email;

    res.json({
      token,
      user: {
        id: user.id,
        phone: phoneDecrypted,
        email: emailDecrypted,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (err) {
    logger.error('[2FA] verify-login error', { error: err.message });
    res.status(500).json({ error: 'Failed to verify 2FA' });
  }
});

export default router;

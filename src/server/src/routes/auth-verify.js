import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import config from '../config.js';
import { isValidPhone, isValidCode, sanitizeString } from '../validation/validator.js';
import { sendCodeLimiter, loginFailedLimiter, clearLoginFailed } from '../middleware/rateLimiter.js';
import { sendVerificationCodeEmail } from '../utils/email.js';
import { logger } from '../utils/logger.js';

const router = Router();

// 辅助函数：创建会话并生成JWT
async function createSessionAndGenerateToken(user, req) {
  const sessionId = uuidv4();
  const deviceName = req.body.deviceName || 'Unknown Device';
  const deviceType = req.body.deviceType || 'browser';
  const platform = req.body.platform || 'unknown';
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent') || '';

  await pool.query(
    `INSERT INTO user_sessions (id, user_id, device_name, device_type, platform, ip_address, user_agent, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
    [sessionId, user.id, deviceName, deviceType, platform, ipAddress, userAgent]
  );

  const token = jwt.sign(
    { userId: user.id, phone: user.phone, email: user.email, sessionId, jti: sessionId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  return { token, sessionId };
}

// 发送验证码（手机：MVP 固定 888888）
router.post('/send-code', sendCodeLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    const cleanPhone = sanitizeString(phone);
    const code = '888888'; // MVP: fixed code
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO verification_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)`,
      [cleanPhone, code, expiresAt.toISOString()]
    );

    // Only log verification code in development environment
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`[MVP] Verification code for ${cleanPhone}: ${code}`);
    }
    res.json({ message: 'Verification code sent (MVP: 888888)' });
  } catch (err) {
    logger.error('Send code error:', { error: err.message });
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// 发送邮箱验证码
router.post('/send-email-code', sendCodeLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const cleanEmail = sanitizeString(email.toLowerCase());

    // 生成6位随机验证码
    const code = process.env.NODE_ENV === 'production'
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : '888888'; // MVP: fixed code for development

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO verification_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)`,
      [cleanEmail, code, expiresAt.toISOString()]
    );

    // 发送验证码邮件
    if (process.env.NODE_ENV === 'production') {
      await sendVerificationCodeEmail(cleanEmail, code, 'login');
    } else {
      logger.debug(`[MVP] Email verification code for ${cleanEmail}: ${code}`);
    }

    res.json({ message: 'Email verification code sent' });
  } catch (err) {
    logger.error('Send email code error:', { error: err.message });
    res.status(500).json({ error: 'Failed to send email verification code' });
  }
});

// 验证码登录（手机）
router.post('/verify-code', loginFailedLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: 'Invalid verification code format' });
    }

    const cleanPhone = sanitizeString(phone);

    // 查找验证码
    const codeResult = await pool.query(
      `SELECT * FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanPhone, code]
    );

    if (codeResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    // 删除已使用的验证码
    await pool.query('DELETE FROM verification_codes WHERE phone = $1', [cleanPhone]);

    // 查找或创建用户
    let user;
    const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);

    if (userResult.rows.length === 0) {
      // 创建新用户
      const userId = uuidv4();
      const nickname = `User_${cleanPhone.slice(-4)}`;
      await pool.query(
        `INSERT INTO users (id, phone, nickname, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [userId, cleanPhone, nickname]
      );
      user = { id: userId, phone: cleanPhone, nickname };
    } else {
      user = userResult.rows[0];
    }

    // 创建会话并生成token
    const { token, sessionId } = await createSessionAndGenerateToken(user, req);

    // 清除登录失败计数
    await clearLoginFailed(cleanPhone);

    res.json({
      token,
      sessionId,
      user: { id: user.id, phone: user.phone, nickname: user.nickname }
    });
  } catch (err) {
    logger.error('Verify code error:', { error: err.message });
    res.status(500).json({ error: 'Verification failed' });
  }
});

// 验证码登录（邮箱）
router.post('/verify-email-code', loginFailedLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: 'Invalid verification code format' });
    }

    const cleanEmail = sanitizeString(email.toLowerCase());

    // 查找验证码
    const codeResult = await pool.query(
      `SELECT * FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail, code]
    );

    if (codeResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    // 删除已使用的验证码
    await pool.query('DELETE FROM verification_codes WHERE phone = $1', [cleanEmail]);

    // 查找或创建用户
    let user;
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);

    if (userResult.rows.length === 0) {
      const userId = uuidv4();
      const nickname = `User_${cleanEmail.split('@')[0]}`;
      await pool.query(
        `INSERT INTO users (id, email, nickname, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [userId, cleanEmail, nickname]
      );
      user = { id: userId, email: cleanEmail, nickname };
    } else {
      user = userResult.rows[0];
    }

    const { token, sessionId } = await createSessionAndGenerateToken(user, req);

    res.json({
      token,
      sessionId,
      user: { id: user.id, email: user.email, nickname: user.nickname }
    });
  } catch (err) {
    logger.error('Verify email code error:', { error: err.message });
    res.status(500).json({ error: 'Email verification failed' });
  }
});

// 接受服务条款
router.post('/accept-tos', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const cleanPhone = sanitizeString(phone);

    await pool.query(
      `UPDATE users SET tos_accepted = TRUE, tos_accepted_at = NOW()
       WHERE phone = $1`,
      [cleanPhone]
    );

    res.json({ message: 'Terms of service accepted' });
  } catch (err) {
    logger.error('Accept TOS error:', { error: err.message });
    res.status(500).json({ error: 'Failed to accept terms of service' });
  }
});

export default router;

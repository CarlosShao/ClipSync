import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import config from '../config.js';
import { sanitizeString } from '../validation/validator.js';
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

// 忘记密码
router.post('/forgot-password', sendCodeLimiter, async (req, res) => {
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

    // 检查用户是否存在
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);

    if (userResult.rows.length === 0) {
      // 安全考虑：不透露用户是否存在
      return res.json({ message: 'If the email exists, a reset code has been sent' });
    }

    // 生成重置码
    const code = process.env.NODE_ENV === 'production'
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : '888888'; // MVP: fixed code for development

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await pool.query(
      `INSERT INTO verification_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)`,
      [cleanEmail, code, expiresAt.toISOString()]
    );

    // 发送重置码邮件
    if (process.env.NODE_ENV === 'production') {
      await sendVerificationCodeEmail(cleanEmail, code, 'reset');
    } else {
      logger.debug(`[MVP] Password reset code for ${cleanEmail}: ${code}`);
    }

    res.json({ message: 'If the email exists, a reset code has been sent' });
  } catch (err) {
    logger.error('Forgot password error:', { error: err.message });
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const cleanEmail = sanitizeString(email.toLowerCase());

    // 验证重置码
    const codeResult = await pool.query(
      `SELECT * FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail, code]
    );

    if (codeResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired reset code' });
    }

    // 删除已使用的验证码
    await pool.query('DELETE FROM verification_codes WHERE phone = $1', [cleanEmail]);

    // 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // 更新密码
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2',
      [hashedPassword, cleanEmail]
    );

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    logger.error('Reset password error:', { error: err.message });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// 密码登录
router.post('/login', loginFailedLimiter, async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    const identifier = email || phone;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required' });
    }

    const cleanIdentifier = sanitizeString(identifier.toLowerCase());

    // 查找用户
    let userResult;
    if (email) {
      userResult = await pool.query('SELECT * FROM users WHERE email = $1', [cleanIdentifier]);
    } else {
      userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanIdentifier]);
    }

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // 检查密码
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Password login not enabled for this account' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 创建会话并生成token
    const { token, sessionId } = await createSessionAndGenerateToken(user, req);

    res.json({
      token,
      sessionId,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname
      }
    });
  } catch (err) {
    logger.error('Login error:', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;

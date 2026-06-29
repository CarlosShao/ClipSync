import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import config from '../config.js';
import { authenticateToken } from '../middleware/auth.js';
import { isValidPhone, isValidCode, sanitizeString } from '../validation/validator.js';
import { sendCodeLimiter, loginFailedLimiter, clearLoginFailed, strictLimiter, getRedisClient, createRateLimiter } from '../middleware/rateLimiter.js';
import { encryptField, decryptField } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import crypto from 'crypto';

// 哈希盐（固定值，用于 phone_hash / email_hash 计算）
// 修改此值后需重新计算所有用户的哈希值
const HASH_SALT = process.env.ENCRYPTION_KEY?.substring(0, 16) || 'CLIPSYNC_SALT_2026';

/**
 * 计算字段值的 SHA-256 哈希（用于 O(1) 查询）
 * 返回 hex 字符串（64 字符）
 */
function computeFieldHash(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value + HASH_SALT).digest('hex');
}

const router = Router();

// 辅助函数：创建会话并生成JWT
async function createSessionAndGenerateToken(user, req) {
  // 创建会话记录
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

  // Generate JWT（包含session_id 和 jti）
  const token = jwt.sign(
    { userId: user.id, phone: user.phone, email: user.email, sessionId: sessionId, jti: sessionId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  return { token, sessionId };
}

// 发送验证码（手机：MVP 固定 888888）
router.post('/send-code', sendCodeLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    // 验证手机号格式
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // 清理输入
    const cleanPhone = sanitizeString(phone);

    // MVP: use fixed code 888888
    const code = '888888';
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

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

    // 验证邮箱格式
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // 清理输入
    const cleanEmail = sanitizeString(email.toLowerCase());

    // MVP: use fixed code 888888 (in production, send email)
    const code = '888888';
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // 存储验证码（使用 phone 字段存储 email，因为表结构复用）
    await pool.query(
      `INSERT INTO verification_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)`,
      [cleanEmail, code, expiresAt.toISOString()]
    );

    // Only log verification code in development environment
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`[MVP] Email verification code for ${cleanEmail}: ${code}`);
    }

    res.json({ message: 'Email verification code sent (MVP: 888888)' });
  } catch (err) {
    logger.error('Send email code error:', { error: err.message });
    res.status(500).json({ error: 'Failed to send email verification code' });
  }
});

// 验证码登录（手机）
router.post('/verify-code', loginFailedLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;

    // 验证输入
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone number and verification code are required' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: 'Invalid verification code format' });
    }

    // 清理输入
    const cleanPhone = sanitizeString(phone);
    const cleanCode = sanitizeString(code);

    const result = await pool.query(
      `SELECT id FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanPhone, cleanCode]
    );

    if (result.rows.length === 0) {
      // ========= P1-4: 审计日志（登录失败 - 手机验证码错误）=========
      await logAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent') || '',
        status: 'failure',
        errorMessage: 'Invalid or expired verification code',
        details: { phone: cleanPhone },
      }).catch(() => {});
      
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    // Mark code as used
    await pool.query(
      `UPDATE verification_codes SET used = TRUE WHERE id = $1`,
      [result.rows[0].id]
    );

    // 清除登录失败记录
    clearLoginFailed(cleanPhone);

    // Find or create user
    // 先尝试明文查询
    let userResult = await pool.query(
      'SELECT id, phone, email, nickname, avatar_url, phone_encrypted, email_encrypted FROM users WHERE phone = $1',
      [cleanPhone]
    );
    
    // 如果明文查询失败，通过 phone_hash 查询（O(1)，不加载全表）
    if (userResult.rows.length === 0) {
      const phoneHash = computeFieldHash(cleanPhone);
      if (phoneHash) {
        userResult = await pool.query(
          'SELECT id, phone, email, nickname, avatar_url, phone_encrypted, email_encrypted FROM users WHERE phone_hash = $1',
          [phoneHash]
        );
      }
      // 若哈希查询仍失败（可能旧数据无哈希），才降级到逐行解密（仅限极少数情况）
      if (userResult.rows.length === 0 && phoneHash) {
        // 降级：仅查询有 phone_encrypted 但未计算哈希的用户（应该是 0 或极少数）
        const fallbackUsers = await pool.query(
          'SELECT id, phone, email, nickname, avatar_url, phone_encrypted, email_encrypted FROM users WHERE phone_encrypted IS NOT NULL AND phone_hash IS NULL LIMIT 50'
        );
        for (const user of fallbackUsers.rows) {
          if (user.phone_encrypted) {
            try {
              const decryptedPhone = decryptField(user.phone_encrypted);
              if (decryptedPhone === cleanPhone) {
                userResult = { rows: [user] };
                // 顺便更新哈希值，避免下次再降级
                const hash = computeFieldHash(cleanPhone);
                if (hash) {
                  await pool.query('UPDATE users SET phone_hash = $1 WHERE id = $2', [hash, user.id]);
                }
                break;
              }
            } catch (err) {
              // 解密失败，跳过
            }
          }
        }
      }
    }

    // Check if new registration (ToS acceptance required)
    const isNewUser = userResult.rows.length === 0;
    const { accept_tos, accept_privacy, marketing_consent, birth_date } = req.body;

    if (isNewUser) {
      // New user registration - require ToS and privacy acceptance
      if (!accept_tos || !accept_privacy) {
        return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to register' });
      }

      // Age verification (COPPA compliance)
      if (birth_date) {
        const birthDate = new Date(birth_date);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          age--;
        }

        if (age < 13) {
          return res.status(403).json({ error: 'Users under 13 are not permitted to use this service per COPPA regulations' });
        }
      }
    }

    if (userResult.rows.length === 0) {
      // 加密手机号
      const phoneEncrypted = encryptField(cleanPhone);
      const phoneHash = computeFieldHash(cleanPhone);
      
      userResult = await pool.query(
        `INSERT INTO users (phone, phone_encrypted, phone_hash, tos_accepted_at, privacy_accepted_at, marketing_consent, birth_date, age_verified)
         VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6)
         RETURNING id, phone, email, nickname, avatar_url`,
        [cleanPhone, phoneEncrypted, phoneHash, marketing_consent || false, birth_date || null, birth_date ? true : false]
      );
    }

    const user = userResult.rows[0];

    // 创建会话并生成JWT
    const { token } = await createSessionAndGenerateToken(user, req);

    // ========= P1-4: 审计日志（登录成功）=========
    await logAuditEvent({
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent') || '',
      status: 'success',
      details: { phone: cleanPhone, isNewUser: userResult.rows.length === 0 },
    });

    // 解密敏感字段


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
        tosAcceptedAt: user.tos_accepted_at,
        privacyAcceptedAt: user.privacy_accepted_at,
        marketingConsent: user.marketing_consent,
      },
    });
  } catch (err) {
    logger.error('Verify code error:', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// 邮箱验证码登录/注册
router.post('/verify-email-code', loginFailedLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;

    // 验证输入
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: 'Invalid verification code format' });
    }

    // 清理输入
    const cleanEmail = sanitizeString(email.toLowerCase());
    const cleanCode = sanitizeString(code);

    // 验证验证码（phone字段存储了邮箱）
    // 先尝试明文查询
    let result = await pool.query(
      `SELECT id FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail, cleanCode]
    );
    
    // 如果明文查询失败，尝试解密查询
    if (result.rows.length === 0) {
      const allCodes = await pool.query(
        'SELECT id, phone FROM verification_codes WHERE expires_at > NOW()'
      );
      
      for (const row of allCodes.rows) {
        if (row.phone && row.phone.includes(':')) {  // 可能是加密的
          try {
            const decryptedPhone = decryptField(row.phone);
            if (decryptedPhone === cleanEmail) {
              result = { rows: [row] };
              break;
            }
          } catch (err) {
            // 解密失败，跳过
          }
        }
      }
    }

    if (result.rows.length === 0) {
      // ========= P1-4: 审计日志（登录失败 - 邮箱验证码错误）=========
      await logAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent') || '',
        status: 'failure',
        errorMessage: 'Invalid or expired email verification code',
        details: { email: cleanEmail },
      }).catch(() => {});
      
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    // Mark code as used
    await pool.query(
      `UPDATE verification_codes SET used = TRUE WHERE id = $1`,
      [result.rows[0].id]
    );

    // Check if new registration (ToS acceptance required)
    const isNewUser = userResult.rows.length === 0;
    const { accept_tos, accept_privacy, marketing_consent, birth_date } = req.body;

    if (isNewUser) {
      // New user registration - require ToS and privacy acceptance
      if (!accept_tos || !accept_privacy) {
        return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to register' });
      }

      // Age verification (COPPA compliance)
      if (birth_date) {
        const birthDate = new Date(birth_date);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          age--;
        }

        if (age < 13) {
          return res.status(403).json({ error: 'Users under 13 are not permitted to use this service per COPPA regulations' });
        }
      }
    }

    if (userResult.rows.length === 0) {
      // 加密邮箱
      const emailEncrypted = encryptField(cleanEmail);
      const emailHash = computeFieldHash(cleanEmail);
      
      userResult = await pool.query(
        `INSERT INTO users (email, email_encrypted, email_hash, tos_accepted_at, privacy_accepted_at, marketing_consent, birth_date, age_verified)
         VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6)
         RETURNING id, phone, email, nickname, avatar_url`,
        [cleanEmail, emailEncrypted, emailHash, marketing_consent || false, birth_date || null, birth_date ? true : false]
      );
    }

    const user = userResult.rows[0];

    // 创建会话并生成JWT
    const { token } = await createSessionAndGenerateToken(user, req);

    // 解密敏感字段


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
        tosAcceptedAt: user.tos_accepted_at,
        privacyAcceptedAt: user.privacy_accepted_at,
        marketingConsent: user.marketing_consent,
      },
    });
  } catch (err) {
    logger.error('Verify email code error:', { error: err.message });
    res.status(500).json({ error: 'Email login failed' });
  }
});

// 接受服务条款（现有用户）
router.post('/accept-tos', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { accept_tos, accept_privacy, marketing_consent } = req.body;

    if (!accept_tos || !accept_privacy) {
      return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy' });
    }

    const result = await pool.query(
      `UPDATE users 
       SET tos_accepted_at = NOW(), 
           privacy_accepted_at = NOW(),
           marketing_consent = $2
       WHERE id = $1
       RETURNING tos_accepted_at, privacy_accepted_at, marketing_consent`,
      [userId, marketing_consent || false]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Terms of Service and Privacy Policy accepted',
      tosAcceptedAt: result.rows[0].tos_accepted_at,
      privacyAcceptedAt: result.rows[0].privacy_accepted_at,
      marketingConsent: result.rows[0].marketing_consent,
    });
  } catch (err) {
    logger.error('Accept ToS error:', { error: err.message });
    res.status(500).json({ error: 'Failed to accept Terms of Service' });
  }
});

// 忘记密码（发送重置邮件）
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
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [cleanEmail]
    );

    // 即使用户不存在也返回成功（防止邮箱枚举攻击）
    if (userResult.rows.length === 0) {
      logger.debug(`[Password Reset] Email ${cleanEmail} not found, but returning success`);
      return res.json({ message: 'If this email is registered, you will receive a password reset email' });
    }

    // 生成重置令牌（MVP：使用固定验证码）
    const resetCode = '888888';
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // 存储重置码（复用 verification_codes 表）
    await pool.query(
      `INSERT INTO verification_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)`,
      [cleanEmail, resetCode, expiresAt.toISOString()]
    );

    // Only log reset code in development environment
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`[MVP] Password reset code for ${cleanEmail}: ${resetCode}`);
    }

    res.json({ message: 'If this email is registered, you will receive a password reset email (MVP: reset code 888888)' });
  } catch (err) {
    logger.error('Forgot password error:', { error: err.message });
    res.status(500).json({ error: 'Failed to send password reset email' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    // 验证输入
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, verification code, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const cleanEmail = sanitizeString(email.toLowerCase());
    const cleanCode = sanitizeString(code);

    // 验证重置码
    const result = await pool.query(
      `SELECT id FROM verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail, cleanCode]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired reset code' });
    }

    // 标记重置码为已使用
    await pool.query(
      `UPDATE verification_codes SET used = TRUE WHERE id = $1`,
      [result.rows[0].id]
    );

    // 哈希新密码
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // 更新用户密码
    const updateResult = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id, email',
      [passwordHash, cleanEmail]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info(`[Password Reset] Password reset successfully for ${cleanEmail}`);

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    logger.error('Reset password error:', { error: err.message });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// 密码登录（支持手机号和邮箱）
router.post('/login', loginFailedLimiter, async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    
    // 验证输入：必须提供手机号或邮箱
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: 'Phone number or email is required' });
    }

    // 确定登录方式
    let cleanIdentifier;
    let identifierField;
    
    if (email) {
      // 邮箱登录
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      cleanIdentifier = sanitizeString(email.toLowerCase());
      identifierField = 'email';
    } else {
      // 手机号登录
      if (!isValidPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number format' });
      }
      cleanIdentifier = sanitizeString(phone);
      identifierField = 'phone';
    }

    // 查询用户
    const result = await pool.query(
      `SELECT id, phone, email, nickname, avatar_url, password_hash FROM users WHERE ${identifierField} = $1`,
      [cleanIdentifier]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Account has no password set. Please log in with a verification code.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 清除登录失败记录
    clearLoginFailed(cleanIdentifier);

    // 创建会话并生成JWT
    const { token } = await createSessionAndGenerateToken(user, req);

    // 解密敏感字段
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
    logger.error('Login error:', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// 获取用户信息（需要认证）
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      'SELECT id, phone, nickname, avatar_url FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
    });
  } catch (err) {
    logger.error('Get profile error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// 更新用户信息（需要认证）
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { nickname, avatarUrl } = req.body;

    // 验证昵称
    if (nickname !== undefined) {
      const trimmedNickname = nickname.trim();
      if (trimmedNickname.length > 50) {
        return res.status(400).json({ error: 'Nickname cannot exceed 50 characters' });
      }
      if (/[<>"'&]/.test(trimmedNickname)) {
        return res.status(400).json({ error: 'Nickname contains invalid characters' });
      }
    }

    const result = await pool.query(
      `UPDATE users SET
        nickname = COALESCE($1, nickname),
        avatar_url = COALESCE($2, avatar_url),
        updated_at = NOW()
       WHERE id = $3
       RETURNING id, phone, nickname, avatar_url`,
      [nickname ? sanitizeString(nickname.trim()) : null, avatarUrl, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
    });
  } catch (err) {
    logger.error('Update profile error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update user info' });
  }
});

// 删除账户（GDPR 被遗忘权）
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { password, confirmation } = req.body;

    // 验证确认文本
    if (confirmation !== 'DELETE') {
      return res.status(400).json({ error: 'Please type DELETE to confirm' });
    }

    // 如果账户有密码，验证密码
    if (password) {
      const userResult = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length > 0 && userResult.rows[0].password_hash) {
        const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
        if (!valid) {
          return res.status(401).json({ error: 'Incorrect password' });
        }
      }
    }

    // 记录删除日志（GDPR 审计要求）
    logger.info(`[GDPR] User ${userId} account deletion requested at ${new Date().toISOString()}`);

    // 删除用户（级联删除所有关联数据）
    // 由于外键约束配置了 ON DELETE CASCADE，以下数据会自动删除：
    // - devices（设备）
    // - clipboard_items（剪贴板条目）
    // - file_versions（文件版本）
    // - device_sync_state（同步状态）
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, phone, email',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // TODO: 使所有活跃会话失效（需要在 Redis 中实现）
    // TODO: 发送账户删除确认邮件

    logger.info(`[GDPR] User ${userId} account deleted successfully`);

    res.json({
      message: 'Account has been permanently deleted',
      deletedUser: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
      }
    });
  } catch (err) {
    logger.error('Delete account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// 导出数据（GDPR 数据可移植性）
// ✅ Red Team P1 修复：添加速率限制（每小时 1 次）
const exportDataLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 小时
  max: 1,                     // 1 次
  message: 'Data export rate limit exceeded, please try again in 1 hour',
  keyGenerator: (req) => `export:${req.user.userId}`,
  storeName: 'api',
});

router.get('/export-data', authenticateToken, exportDataLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 记录导出日志（GDPR 审计要求）
    logger.info(`[GDPR] User ${userId} data export requested at ${new Date().toISOString()}`);

    // 获取用户基本信息
    const userResult = await pool.query(
      'SELECT id, phone, email, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // 获取用户设备
    const devicesResult = await pool.query(
      'SELECT id, device_name, device_type, platform, platform_version, app_version, is_online, last_seen_at, created_at FROM devices WHERE user_id = $1',
      [userId]
    );

    // 获取剪贴板条目（分批获取，避免内存溢出）
    const clipboardResult = await pool.query(
      `SELECT id, content_type, content_preview, content_size, metadata, is_favorite, expires_at, created_at, updated_at 
       FROM clipboard_items 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1000`,
      [userId]
    );

    // 获取文件版本
    const fileVersionsResult = await pool.query(
      `SELECT fv.id, fv.clipboard_item_id, fv.version_number, fv.content_preview, fv.content_size, fv.change_description, fv.created_at
       FROM file_versions fv
       JOIN clipboard_items ci ON fv.clipboard_item_id = ci.id
       WHERE fv.user_id = $1
       ORDER BY fv.created_at DESC`,
      [userId]
    );

    // 组装导出数据
    const exportData = {
      exportDate: new Date().toISOString(),
      gdprNotice: 'Under GDPR Article 20 (Right to Data Portability), you have the right to obtain your personal data. This file contains all data from your ClipSync account.',
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
      devices: devicesResult.rows.map(d => ({
        id: d.id,
        deviceName: d.device_name,
        deviceType: d.device_type,
        platform: d.platform,
        platformVersion: d.platform_version,
        appVersion: d.app_version,
        isOnline: d.is_online,
        lastSeenAt: d.last_seen_at,
        createdAt: d.created_at,
      })),
      clipboardItems: clipboardResult.rows.map(c => ({
        id: c.id,
        contentType: c.content_type,
        contentPreview: c.content_preview,
        contentSize: c.content_size,
        metadata: c.metadata,
        isFavorite: c.is_favorite,
        expiresAt: c.expires_at,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      fileVersions: fileVersionsResult.rows.map(f => ({
        id: f.id,
        clipboardItemId: f.clipboard_item_id,
        versionNumber: f.version_number,
        contentPreview: f.content_preview,
        contentSize: f.content_size,
        changeDescription: f.change_description,
        createdAt: f.created_at,
      })),
      summary: {
        totalDevices: devicesResult.rows.length,
        totalClipboardItems: clipboardResult.rows.length,
        totalFileVersions: fileVersionsResult.rows.length,
      },
    };

    // 设置响应头，触发文件下载
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="clipsync-data-export-${userId}-${Date.now()}.json"`);
    
    logger.info(`[GDPR] User ${userId} data export completed successfully`);
    
    // ========= P1-4: 审计日志 =========
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.EXPORT_DATA,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent') || '',
      status: 'success',
      details: {
        dataType: 'GDPR_export',
        itemCount: clipboardResult.rows.length,
      },
    });
    
    res.json(exportData);
  } catch (err) {
    logger.error('Export data error:', { error: err.message });
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// 停用账户（临时禁用，可重新激活）
router.put('/deactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { reason } = req.body;

    // 检查账户是否已停用
    const checkResult = await pool.query(
      'SELECT is_active FROM users WHERE id = $1',
      [userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!checkResult.rows[0].is_active) {
      return res.status(400).json({ error: 'Account is already deactivated' });
    }

    // 停用账户
    const result = await pool.query(
      `UPDATE users 
       SET is_active = FALSE, 
           deactivated_at = NOW(),
           deactivation_reason = $2
       WHERE id = $1
       RETURNING id, phone, email, is_active, deactivated_at, deactivation_reason`,
      [userId, reason || 'User-initiated deactivation']
    );

    // 撤销所有活跃会话
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW() WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    logger.info(`[Account] User ${userId} deactivated. Reason: ${reason || 'User-initiated deactivation'}`);
    
    // ========= P1-4: 审计日志 =========
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.DEACTIVATE_ACCOUNT,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent') || '',
      status: 'success',
      details: {
        reason: reason || 'User-initiated deactivation',
      },
    });
    
    res.json({
      message: 'Account has been deactivated',
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        email: result.rows[0].email,
        isActive: result.rows[0].is_active,
        deactivatedAt: result.rows[0].deactivated_at,
        deactivationReason: result.rows[0].deactivation_reason,
      },
      reactivationInfo: {
        message: 'To reactivate your account, please contact the support team',
        contactEmail: 'support@clipsync.example.com',
      },
    });
  } catch (err) {
    logger.error('Deactivate account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to deactivate account' });
  }
});

// 重新激活账户（需要身份验证 - Red Team P0-5 修复）
// 方案：要求用户提供 JWT 令牌（必须是已登录状态）
// 若账户已停用，用户无法通过 authenticateToken，因此需使用特殊路径：
// 1. 用户发送重新激活请求 → 系统发送确认邮件
// 2. 用户点击邮件链接 → 重新激活
// 当前实现：要求身份验证（仅允许已登录用户重新激活，适用于误操作停用）
router.put('/reactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 查找用户
    const userResult = await pool.query(
      'SELECT id, email, is_active, deactivated_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    if (user.is_active) {
      return res.status(400).json({ error: 'Account is already active' });
    }

    // 重新激活账户
    const result = await pool.query(
      `UPDATE users 
       SET is_active = TRUE, 
           deactivated_at = NULL,
           deactivation_reason = NULL
       WHERE id = $1
       RETURNING id, phone, email, is_active`,
      [userId]
    );

    logger.info(`[Account] User ${user.id} reactivated`);

    res.json({
      message: 'Account has been reactivated. You can now log in.',
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        email: result.rows[0].email,
        isActive: result.rows[0].is_active,
      },
    });
  } catch (err) {
    logger.error('Reactivate account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to reactivate account' });
  }
});

// 更新同意偏好（Cookie 和营销）
router.put('/consent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { analytics_consent, functional_consent, marketing_consent } = req.body;

    // 验证参数（必须是布尔值或 null）
    const updates = [];
    const values = [userId];
    let paramCount = 2;

    if (analytics_consent !== undefined) {
      updates.push(`analytics_consent = $${paramCount}`);
      values.push(analytics_consent);
      paramCount++;
    }

    if (functional_consent !== undefined) {
      updates.push(`functional_consent = $${paramCount}`);
      values.push(functional_consent);
      paramCount++;
    }

    if (marketing_consent !== undefined) {
      updates.push(`marketing_consent = $${paramCount}`);
      values.push(marketing_consent);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No consent preferences provided for update' });
    }

    updates.push(`consent_updated_at = NOW()`);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $1 RETURNING 
        id, 
        analytics_consent, 
        functional_consent, 
        marketing_consent,
        consent_updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info(`[Consent] User ${userId} updated consent preferences`);

    res.json({
      message: 'Consent preferences updated',
      consent: {
        analyticsConsent: result.rows[0].analytics_consent,
        functionalConsent: result.rows[0].functional_consent,
        marketingConsent: result.rows[0].marketing_consent,
        updatedAt: result.rows[0].consent_updated_at,
      },
    });
  } catch (err) {
    logger.error('Update consent error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update consent preferences' });
  }
});

// 注销
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const token = req.headers['authorization'].split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // 将 jti 加入 Redis 黑名单（TTL = token 剩余有效期）
    if (decoded.jti) {
      const redis = await getRedisClient();
      if (redis) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redis.setEx(`bl:${decoded.jti}`, ttl, '1');
        }
      }
    }
    
    // 标记会话为不活跃
    if (decoded.sessionId) {
      await pool.query(
        'UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW() WHERE id = $1',
        [decoded.sessionId]
      );
    }

    // ========= P1-4: 审计日志 =========
    await logAuditEvent({
      userId: decoded.userId,
      action: AUDIT_ACTIONS.LOGOUT,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent') || '',
      status: 'success',
    });
    
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error:', { error: err.message });
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;

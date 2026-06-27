import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import config from '../config.js';
import { authenticateToken } from '../middleware/auth.js';
import { isValidPhone, isValidCode, sanitizeString } from '../validation/validator.js';
import { sendCodeLimiter, loginFailedLimiter, clearLoginFailed, strictLimiter, getRedisClient } from '../middleware/rateLimiter.js';
import { encryptField, decryptField } from '../utils/encryption.js';

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
      return res.status(400).json({ error: '手机号不能为空' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: '手机号格式无效' });
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

    console.log(`[MVP] Verification code for ${cleanPhone}: ${code}`);

    res.json({ message: '验证码已发送（MVP: 888888）' });
  } catch (err) {
    console.error('Send code error:', err);
    res.status(500).json({ error: '发送验证码失败' });
  }
});

// 发送邮箱验证码
router.post('/send-email-code', sendCodeLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    // 验证邮箱格式
    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
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

    console.log(`[MVP] Email verification code for ${cleanEmail}: ${code}`);
    // TODO: 生产环境发送邮件

    res.json({ message: '邮箱验证码已发送（MVP: 888888）' });
  } catch (err) {
    console.error('Send email code error:', err);
    res.status(500).json({ error: '发送邮箱验证码失败' });
  }
});

// 验证码登录（手机）
router.post('/verify-code', loginFailedLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;

    // 验证输入
    if (!phone || !code) {
      return res.status(400).json({ error: '手机号和验证码不能为空' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: '手机号格式无效' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: '验证码格式无效' });
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
      return res.status(401).json({ error: '验证码无效或已过期' });
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
    
    // 如果明文查询失败，尝试解密查询
    if (userResult.rows.length === 0) {
      const allUsers = await pool.query('SELECT id, phone, email, nickname, avatar_url, phone_encrypted, email_encrypted FROM users');
      for (const user of allUsers.rows) {
        if (user.phone_encrypted) {
          try {
            const decryptedPhone = decryptField(user.phone_encrypted);
            if (decryptedPhone === cleanPhone) {
              userResult = { rows: [user] };
              break;
            }
          } catch (err) {
            // 解密失败，跳过
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
        return res.status(400).json({ error: '注册必须接受服务条款和隐私政策' });
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
          return res.status(403).json({ error: '根据COPPA规定，13岁以下儿童不能使用本服务' });
        }
      }
    }

    if (userResult.rows.length === 0) {
      // 加密手机号
      const phoneEncrypted = encryptField(cleanPhone);
      
      userResult = await pool.query(
        `INSERT INTO users (phone, phone_encrypted, tos_accepted_at, privacy_accepted_at, marketing_consent, birth_date, age_verified)
         VALUES ($1, $2, NOW(), NOW(), $3, $4, $5)
         RETURNING id, phone, email, nickname, avatar_url`,
        [cleanPhone, phoneEncrypted, marketing_consent || false, birth_date || null, birth_date ? true : false]
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
    console.error('Verify code error:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// 邮箱验证码登录/注册
router.post('/verify-email-code', loginFailedLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;

    // 验证输入
    if (!email || !code) {
      return res.status(400).json({ error: '邮箱和验证码不能为空' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
    }

    if (!isValidCode(code)) {
      return res.status(400).json({ error: '验证码格式无效' });
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
      return res.status(401).json({ error: '验证码无效或已过期' });
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
        return res.status(400).json({ error: '注册必须接受服务条款和隐私政策' });
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
          return res.status(403).json({ error: '根据COPPA规定，13岁以下儿童不能使用本服务' });
        }
      }
    }

    if (userResult.rows.length === 0) {
      // 加密邮箱
      const emailEncrypted = encryptField(cleanEmail);
      
      userResult = await pool.query(
        `INSERT INTO users (email, email_encrypted, tos_accepted_at, privacy_accepted_at, marketing_consent, birth_date, age_verified)
         VALUES ($1, $2, NOW(), NOW(), $3, $4, $5)
         RETURNING id, phone, email, nickname, avatar_url`,
        [cleanEmail, emailEncrypted, marketing_consent || false, birth_date || null, birth_date ? true : false]
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
    console.error('Verify email code error:', err);
    res.status(500).json({ error: '邮箱登录失败' });
  }
});

// 接受服务条款（现有用户）
router.post('/accept-tos', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { accept_tos, accept_privacy, marketing_consent } = req.body;

    if (!accept_tos || !accept_privacy) {
      return res.status(400).json({ error: '必须接受服务条款和隐私政策' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({
      message: '已接受服务条款和隐私政策',
      tosAcceptedAt: result.rows[0].tos_accepted_at,
      privacyAcceptedAt: result.rows[0].privacy_accepted_at,
      marketingConsent: result.rows[0].marketing_consent,
    });
  } catch (err) {
    console.error('Accept ToS error:', err);
    res.status(500).json({ error: '接受服务条款失败' });
  }
});

// 忘记密码（发送重置邮件）
router.post('/forgot-password', sendCodeLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
    }

    const cleanEmail = sanitizeString(email.toLowerCase());

    // 检查用户是否存在
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [cleanEmail]
    );

    // 即使用户不存在也返回成功（防止邮箱枚举攻击）
    if (userResult.rows.length === 0) {
      console.log(`[Password Reset] Email ${cleanEmail} not found, but returning success`);
      return res.json({ message: '如果该邮箱已注册，您将收到密码重置邮件' });
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

    console.log(`[MVP] Password reset code for ${cleanEmail}: ${resetCode}`);
    // TODO: 生产环境发送邮件

    res.json({ message: '如果该邮箱已注册，您将收到密码重置邮件（MVP：重置码 888888）' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: '发送密码重置邮件失败' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    // 验证输入
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: '邮箱、验证码和新密码不能为空' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少6位' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
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
      return res.status(401).json({ error: '重置码无效或已过期' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    console.log(`[Password Reset] Password reset successfully for ${cleanEmail}`);

    res.json({ message: '密码已重置成功，请使用新密码登录' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: '重置密码失败' });
  }
});

// 密码登录（支持手机号和邮箱）
router.post('/login', loginFailedLimiter, async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    
    // 验证输入：必须提供手机号或邮箱
    if (!password) {
      return res.status(400).json({ error: '密码不能为空' });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: '手机号或邮箱不能为空' });
    }

    // 确定登录方式
    let cleanIdentifier;
    let identifierField;
    
    if (email) {
      // 邮箱登录
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: '邮箱格式无效' });
      }
      cleanIdentifier = sanitizeString(email.toLowerCase());
      identifierField = 'email';
    } else {
      // 手机号登录
      if (!isValidPhone(phone)) {
        return res.status(400).json({ error: '手机号格式无效' });
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
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: '账户未设置密码，请使用验证码登录' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
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
    console.error('Login error:', err);
    res.status(500).json({ error: '登录失败' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: '获取用户信息失败' });
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
        return res.status(400).json({ error: '昵称不能超过50个字符' });
      }
      if (/[<>"'&]/.test(trimmedNickname)) {
        return res.status(400).json({ error: '昵称包含非法字符' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: '更新用户信息失败' });
  }
});

// 删除账户（GDPR 被遗忘权）
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { password, confirmation } = req.body;

    // 验证确认文本
    if (confirmation !== 'DELETE') {
      return res.status(400).json({ error: '请输入 DELETE 以确认删除' });
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
          return res.status(401).json({ error: '密码错误' });
        }
      }
    }

    // 记录删除日志（GDPR 审计要求）
    console.log(`[GDPR] User ${userId} account deletion requested at ${new Date().toISOString()}`);

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
      return res.status(404).json({ error: '用户不存在' });
    }

    // TODO: 使所有活跃会话失效（需要在 Redis 中实现）
    // TODO: 发送账户删除确认邮件

    console.log(`[GDPR] User ${userId} account deleted successfully`);

    res.json({
      message: '账户已永久删除',
      deletedUser: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
      }
    });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: '删除账户失败' });
  }
});

// 导出数据（GDPR 数据可移植性）
router.get('/export-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 记录导出日志（GDPR 审计要求）
    console.log(`[GDPR] User ${userId} data export requested at ${new Date().toISOString()}`);

    // 获取用户基本信息
    const userResult = await pool.query(
      'SELECT id, phone, email, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
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
      gdprNotice: '根据GDPR第20条（数据可移植性），您有权获得您的个人数据。此文件包含您的ClipSync账户中的所有数据。',
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
    
    console.log(`[GDPR] User ${userId} data export completed successfully`);
    
    res.json(exportData);
  } catch (err) {
    console.error('Export data error:', err);
    res.status(500).json({ error: '导出数据失败' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    if (!checkResult.rows[0].is_active) {
      return res.status(400).json({ error: '账户已停用' });
    }

    // 停用账户
    const result = await pool.query(
      `UPDATE users 
       SET is_active = FALSE, 
           deactivated_at = NOW(),
           deactivation_reason = $2
       WHERE id = $1
       RETURNING id, phone, email, is_active, deactivated_at, deactivation_reason`,
      [userId, reason || '用户主动停用']
    );

    // 撤销所有活跃会话
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE, revoked_at = NOW() WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    console.log(`[Account] User ${userId} deactivated. Reason: ${reason || '用户主动停用'}`);

    res.json({
      message: '账户已停用',
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        email: result.rows[0].email,
        isActive: result.rows[0].is_active,
        deactivatedAt: result.rows[0].deactivated_at,
        deactivationReason: result.rows[0].deactivation_reason,
      },
      reactivationInfo: {
        message: '如需重新激活账户，请联系支持团队',
        contactEmail: 'support@clipsync.example.com',
      },
    });
  } catch (err) {
    console.error('Deactivate account error:', err);
    res.status(500).json({ error: '停用账户失败' });
  }
});

// 重新激活账户（需要联系支持）
router.put('/reactivate', async (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ error: '请提供邮箱或手机号' });
    }

    // 查找用户
    let userResult;
    if (email) {
      userResult = await pool.query(
        'SELECT id, email, is_active, deactivated_at FROM users WHERE email = $1',
        [sanitizeString(email.toLowerCase())]
      );
    } else {
      userResult = await pool.query(
        'SELECT id, phone, is_active, deactivated_at FROM users WHERE phone = $1',
        [sanitizeString(phone)]
      );
    }

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];

    if (user.is_active) {
      return res.status(400).json({ error: '账户已激活' });
    }

    // 注意：生产环境需要支持团队审批
    // MVP：直接重新激活
    const result = await pool.query(
      `UPDATE users 
       SET is_active = TRUE, 
           deactivated_at = NULL,
           deactivation_reason = NULL
       WHERE id = $1
       RETURNING id, phone, email, is_active`,
      [user.id]
    );

    console.log(`[Account] User ${user.id} reactivated`);

    res.json({
      message: '账户已重新激活，您现在可以登录',
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        email: result.rows[0].email,
        isActive: result.rows[0].is_active,
      },
    });
  } catch (err) {
    console.error('Reactivate account error:', err);
    res.status(500).json({ error: '重新激活账户失败' });
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
      return res.status(400).json({ error: '没有提供要更新的同意偏好' });
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
      return res.status(404).json({ error: '用户不存在' });
    }

    console.log(`[Consent] User ${userId} updated consent preferences`);

    res.json({
      message: '同意偏好已更新',
      consent: {
        analyticsConsent: result.rows[0].analytics_consent,
        functionalConsent: result.rows[0].functional_consent,
        marketingConsent: result.rows[0].marketing_consent,
        updatedAt: result.rows[0].consent_updated_at,
      },
    });
  } catch (err) {
    console.error('Update consent error:', err);
    res.status(500).json({ error: '更新同意偏好失败' });
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
    
    res.json({ message: '已注销' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: '注销失败' });
  }
});

export default router;

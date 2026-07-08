import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import pool from '../db/pool.js';
import { broadcastToUser, sendNotification } from '../ws/server.js';
import { isValidUUID, isValidDeviceType, isValidPlatform, sanitizeString, validateDeviceName } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { getRedisClient } from '../utils/redis-client.js';
import { authenticateToken } from '../middleware/auth.js';
import { createSessionAndGenerateToken } from './auth.js';
import { decryptField } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

const router = Router();
const pairingRouter = Router();

// 二维码扫码配对：生成一次性配对令牌（本机已登录设备调用）
// 返回 { token, expiresAt }，token 编码进二维码 clipsync://pair?token=...
pairingRouter.post('/pairing/init', apiLimiter, authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 分钟有效期

    const redis = await getRedisClient();
    if (!redis) {
      return res.status(503).json({ error: 'Redis unavailable, cannot create pairing token' });
    }

    // 存储配对令牌，TTL 300s（与 expiresAt 一致）
    await redis.setEx(`pairing:${token}`, 300, JSON.stringify({ userId, createdAt: Date.now() }));

    logger.info('[Pairing] init token created', { userId });
    res.json({ token, expiresAt });
  } catch (err) {
    logger.error('Pairing init error:', { error: err.message });
    res.status(500).json({ error: 'Failed to create pairing token' });
  }
});

// 二维码扫码配对：兑换令牌（扫码设备调用，无需登录 → 等价于登录到令牌所属账号）
// 这是「自动同步不可用时的手动兜底方案」：扫码即把本设备登录到对方账号，从而共享剪贴板
pairingRouter.post('/pairing/redeem', apiLimiter, async (req, res) => {
  try {
    const { token, deviceName, deviceType, platform, platformVersion } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Pairing token is required' });
    }

    const redis = await getRedisClient();
    if (!redis) {
      return res.status(503).json({ error: 'Redis unavailable, cannot redeem pairing token' });
    }

    const raw = await redis.get(`pairing:${token}`);
    if (!raw) {
      return res.status(404).json({ error: 'Invalid or expired pairing token' });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'Corrupted pairing token' });
    }
    const userId = payload.userId;
    // 一次性使用：立即删除
    await redis.del(`pairing:${token}`);

    // 查询令牌所属用户
    const userResult = await pool.query(
      `SELECT id, phone, email, nickname, avatar_url, tos_accepted_at, privacy_accepted_at,
              marketing_consent, phone_encrypted, email_encrypted
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const u = userResult.rows[0];

    const phoneDecrypted = decryptField(u.phone_encrypted) || u.phone;
    const emailDecrypted = decryptField(u.email_encrypted) || u.email;

    // 复用登录的会话+JWT 生成逻辑，保证 token 结构与 /api/auth/* 完全一致
    const { token: jwtToken } = await createSessionAndGenerateToken(
      { id: u.id, phone: u.phone, email: u.email, nickname: u.nickname, avatar_url: u.avatar_url },
      req
    );

    // 注册扫码设备到目标账号（使用正确字段名，避免前后端不匹配）
    const cleanDeviceName = deviceName ? sanitizeString(String(deviceName).trim()) : 'Desktop';
    const cleanDeviceType = isValidDeviceType(deviceType) ? deviceType : 'desktop';
    const cleanPlatform = isValidPlatform(platform) ? platform : 'unknown';
    if (cleanPlatform === 'unknown') {
      return res.status(400).json({ error: 'Invalid platform. Valid values: windows, macos, linux, ios, android, browser' });
    }
    const cleanPlatformVersion = platformVersion ? sanitizeString(String(platformVersion)) : '';
    await pool.query(
      `INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, app_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, cleanDeviceName, cleanDeviceType, cleanPlatform, cleanPlatformVersion, '0.1.0']
    );

    logger.info('[Pairing] redeem success', { userId, deviceType: cleanDeviceType, platform: cleanPlatform });

    // 新设备接入同步组 → 推送「设备上线」通知
    try {
      await sendNotification(userId, {
        notificationType: 'device_online',
        title: 'New device connected',
        body: `${cleanDeviceName} (${cleanPlatform}) joined your sync group.`,
        data: { deviceName: cleanDeviceName, platform: cleanPlatform },
      });
    } catch (notifErr) {
      logger.error('[Pairing] 设备上线通知失败（已忽略）:', { error: notifErr?.message, userId });
    }

    res.json({
      token: jwtToken,
      user: {
        id: u.id,
        phone: phoneDecrypted,
        email: emailDecrypted,
        nickname: u.nickname,
        avatarUrl: u.avatar_url,
        tosAcceptedAt: u.tos_accepted_at,
        privacyAcceptedAt: u.privacy_accepted_at,
        marketingConsent: u.marketing_consent,
      },
    });
  } catch (err) {
    logger.error('Pairing redeem error:', { error: err.message });
    res.status(500).json({ error: 'Failed to redeem pairing token' });
  }
});

// 获取用户所有设备
router.get('/', apiLimiter, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT id, device_name, device_type, platform, platform_version,
              app_version, is_online, last_seen_at, created_at
       FROM devices
       WHERE user_id = $1
       ORDER BY last_seen_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('Get devices error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get device list' });
  }
});

// 注册新设备
router.post('/', apiLimiter, async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceName, deviceType, platform, platformVersion, appVersion } = req.body;

    // 验证必填字段
    if (!deviceName || !deviceType || !platform) {
      return res.status(400).json({ error: 'deviceName, deviceType, and platform are required' });
    }

    // 验证设备名称
    const nameValidation = validateDeviceName(deviceName);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // 验证设备类型
    if (!isValidDeviceType(deviceType)) {
      return res.status(400).json({ error: 'Invalid deviceType. Valid values: desktop, mobile, tablet' });
    }

    // 验证平台
    if (!isValidPlatform(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Valid values: windows, macos, linux, ios, android, browser' });
    }

    // 清理输入
    const cleanDeviceName = sanitizeString(deviceName.trim());
    const cleanPlatformVersion = platformVersion ? sanitizeString(platformVersion) : '';
    const cleanAppVersion = appVersion ? sanitizeString(appVersion) : '0.1.0';

    // Check if device name already exists for this user
    const existing = await pool.query(
      'SELECT id FROM devices WHERE user_id = $1 AND device_name = $2',
      [userId, cleanDeviceName]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Device name already exists',
        deviceId: existing.rows[0].id,
      });
    }

    const result = await pool.query(
      `INSERT INTO devices (user_id, device_name, device_type, platform, platform_version, app_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, device_name, device_type, platform, platform_version, app_version, is_online, created_at`,
      [userId, cleanDeviceName, deviceType, platform, cleanPlatformVersion, cleanAppVersion]
    );

    const device = result.rows[0];

    // Create sync state
    await pool.query(
      'INSERT INTO device_sync_state (device_id) VALUES ($1)',
      [device.id]
    );

    res.status(201).json(device);
  } catch (err) {
    logger.error('Register device error:', { error: err.message });
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// 更新设备信息
router.put('/:deviceId', apiLimiter, async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceId } = req.params;
    const { deviceName, platformVersion, appVersion } = req.body;

    // 验证 deviceId
    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: 'Invalid device ID format' });
    }

    // 验证设备名称
    if (deviceName) {
      const nameValidation = validateDeviceName(deviceName);
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
    }

    // 清理输入
    const cleanDeviceName = deviceName ? sanitizeString(deviceName.trim()) : null;
    const cleanPlatformVersion = platformVersion ? sanitizeString(platformVersion) : null;
    const cleanAppVersion = appVersion ? sanitizeString(appVersion) : null;

    const result = await pool.query(
      `UPDATE devices SET
        device_name = COALESCE($1, device_name),
        platform_version = COALESCE($2, platform_version),
        app_version = COALESCE($3, app_version),
        last_seen_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, device_name, device_type, platform, platform_version, app_version, is_online, created_at`,
      [cleanDeviceName, cleanPlatformVersion, cleanAppVersion, deviceId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('Update device error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// 删除设备
router.delete('/:deviceId', apiLimiter, async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceId } = req.params;

    // 验证 deviceId
    if (!isValidUUID(deviceId)) {
      return res.status(400).json({ error: 'Invalid device ID format' });
    }

    const result = await pool.query(
      'DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id',
      [deviceId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Broadcast device removal to other devices
    broadcastToUser(userId, {
      type: 'device_removed',
      deviceId: result.rows[0].id,
    });

    res.json({ message: 'Device deleted' });
  } catch (err) {
    logger.error('Delete device error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

export default router;
export { pairingRouter };

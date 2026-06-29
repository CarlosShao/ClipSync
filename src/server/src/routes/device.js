import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import { broadcastToUser } from '../ws/server.js';
import { isValidUUID, isValidDeviceType, isValidPlatform, sanitizeString, validateDeviceName } from '../validation/validator.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

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

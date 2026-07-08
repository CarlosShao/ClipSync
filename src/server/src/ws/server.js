import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { getRedisClient } from '../middleware/rateLimiter.js';
import { createNotification } from '../services/notificationService.js';
import {
  initWsRedisPubSub,
  publishToUser,
  closeWsRedisPubSub,
  isWsRedisEnabled,
} from '../utils/ws-redis-pubsub.js';

// Map<userId, Map<deviceId, WebSocket>>
const connections = new Map();

// 防止同一 server 实例被多次调用（测试环境会导致内存泄漏）
const _setupServers = new WeakMap();

// 未注册连接的超时时间（毫秒）
const UNREGISTERED_TIMEOUT = 10000; // 10秒

// WebSocket消息速率限制
const WS_RATE_LIMIT = 50; // 每秒最多50条消息
const WS_RATE_WINDOW = 1000; // 1秒窗口

export function setupWebSocket(server) {
  // 幂等性检查：同一个 server 只创建一次 WebSocket 服务
  if (_setupServers.has(server)) {
    return _setupServers.get(server);
  }

  // WebSocket 服务（限制消息大小为 1MB，防止内存耗尽）
  const wss = new WebSocketServer({ 
    server, 
    path: '/ws',
    maxPayload: 1024 * 1024 // 1MB
  });
  _setupServers.set(server, wss);

  // 测试环境大幅提升 listener 上限，避免 MaxListenersExceededWarning
  const maxListeners = process.env.NODE_ENV === 'test' ? 500 : 100;
  wss.setMaxListeners(maxListeners);
  if (server.setMaxListeners) server.setMaxListeners(maxListeners);

  // 初始化 WebSocket Redis Pub/Sub（如果 Redis 已配置）
  initWsRedisPubSub(connections).then((enabled) => {
    if (enabled) {
      logger.info('[WebSocket] Redis Pub/Sub enabled for multi-instance deployment');
    } else {
      logger.info('[WebSocket] Redis Pub/Sub disabled, using local broadcast only');
    }
  });

  wss.on('connection', async (ws, req) => {
    logger.info('WebSocket connection attempt');

    // ========== 安全增强 #1: Origin 验证 ==========
    const origin = req.headers.origin;
    if (config.nodeEnv === 'production' && origin) {
      const allowedOrigins = config.cors?.origins || [];
      if (!allowedOrigins.includes(origin)) {
        logger.warn('WebSocket connection rejected: Invalid origin', { origin });
        ws.close(4003, 'Invalid origin');
        return;
      }
    }

    // ========== 安全增强 #2: 解析并验证 Token ==========
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || req.headers['authorization']?.split(' ')[1];

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      ws.close(4002, 'Invalid token');
      return;
    }

    // ========== 安全增强 #2.5: WebSocket CSRF 保护 ==========
    const csrfToken = url.searchParams.get('csrf_token');
    if (config.nodeEnv === 'production' || csrfToken) {
      // 生产环境必须验证CSRF token
      if (!csrfToken) {
        logger.warn('WebSocket connection rejected: Missing CSRF token', { userId: decoded.userId });
        ws.close(4006, 'CSRF token required');
        return;
      }
      
      // 格式检查
      if (!/^[a-f0-9]{64}$/.test(csrfToken)) {
        logger.warn('WebSocket connection rejected: Invalid CSRF token format', { userId: decoded.userId });
        ws.close(4006, 'Invalid CSRF token');
        return;
      }
      
      // Redis验证：检查token是否存在且属于该用户
      if (redis) {
        try {
          const tokenData = await redis.get(`csrf:${csrfToken}`);
          if (!tokenData) {
            logger.warn('WebSocket connection rejected: CSRF token not found in Redis', { userId: decoded.userId });
            ws.close(4006, 'Invalid CSRF token');
            return;
          }
          
          const parsed = JSON.parse(tokenData);
          if (parsed.userId !== decoded.userId) {
            logger.warn('WebSocket connection rejected: CSRF token user mismatch', { 
              userId: decoded.userId,
              tokenUserId: parsed.userId 
            });
            ws.close(4006, 'Invalid CSRF token');
            return;
          }
          
          // 验证通过，使用后删除token（单次使用）
          await redis.del(`csrf:${csrfToken}`);
        } catch (err) {
          logger.error('CSRF token validation error', { error: err.message });
          // Redis错误时拒绝连接（ fail-closed）
          ws.close(4006, 'CSRF validation error');
          return;
        }
      } else {
        // Redis不可用时，如果是最佳环境则拒绝连接
        if (config.nodeEnv === 'production') {
          logger.error('WebSocket CSRF validation failed: Redis unavailable in production');
          ws.close(4006, 'Service temporarily unavailable');
          return;
        }
      }
    }

    // ========== 安全增强 #3: 检查 Token 是否在黑名单中 ==========
    const redis = await getRedisClient();
    if (redis && decoded.jti) {
      const blacklisted = await redis.get(`bl:${decoded.jti}`);
      if (blacklisted) {
        logger.warn('WebSocket connection rejected: Token revoked', { userId: decoded.userId });
        ws.close(4004, 'Token revoked');
        return;
      }
    }

    const userId = decoded.userId;
    let deviceId = null;
    let isRegistered = false;
    let messageCount = 0;
    let lastMessageTime = Date.now();

    // ========== 安全增强 #4: 未注册连接超时 ==========
    const unregisteredTimeout = setTimeout(() => {
      if (!isRegistered) {
        logger.warn('WebSocket connection timeout: Not registered', { userId });
        ws.close(4005, 'Registration timeout');
      }
    }, UNREGISTERED_TIMEOUT);

    // ========== 安全增强 #5: 消息速率限制 ==========
    function checkRateLimit() {
      const now = Date.now();
      if (now - lastMessageTime > WS_RATE_WINDOW) {
        // 新窗口
        messageCount = 1;
        lastMessageTime = now;
        return true;
      }
      
      if (messageCount >= WS_RATE_LIMIT) {
        logger.warn('WebSocket rate limit exceeded', { userId, deviceId });
        return false;
      }
      
      messageCount++;
      return true;
    }

    ws.on('message', async (data) => {
      // 速率限制检查
      if (!checkRateLimit()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }

      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'register':
            deviceId = message.deviceId;
            if (!deviceId) {
              ws.send(JSON.stringify({ type: 'error', message: 'deviceId required' }));
              return;
            }

            // Verify device belongs to user
            const deviceCheck = await pool.query(
              'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
              [deviceId, userId]
            );

            if (deviceCheck.rows.length === 0) {
              ws.send(JSON.stringify({ type: 'error', message: 'Device not found' }));
              return;
            }

            // Store connection
            if (!connections.has(userId)) {
              connections.set(userId, new Map());
            }
            connections.get(userId).set(deviceId, ws);

            // 标记已注册并清除超时计时器
            isRegistered = true;
            clearTimeout(unregisteredTimeout);

            // Update device online status
            await pool.query(
              'UPDATE devices SET is_online = TRUE, last_seen_at = NOW() WHERE id = $1',
              [deviceId]
            );

            ws.send(JSON.stringify({ type: 'registered', deviceId }));
            logger.info(`Device ${deviceId} registered for user ${userId}`);
            break;

          case 'clipboard':
            // Broadcast clipboard content to other devices of the same user
            if (!deviceId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Register device first' }));
              return;
            }

            const clipboardMessage = {
              type: 'clipboard',
              sourceDeviceId: deviceId,
              content: message.content,
              contentType: message.contentType,
              timestamp: Date.now(),
            };

            // 本地广播（同一实例内的其他设备）
            const userDevices = connections.get(userId);
            if (userDevices) {
              for (const [otherDeviceId, otherWs] of userDevices) {
                if (otherDeviceId !== deviceId && otherWs.readyState === 1) {
                  otherWs.send(JSON.stringify(clipboardMessage));
                }
              }
            }

            // Redis Pub/Sub 广播（其他实例的设备）
            if (isWsRedisEnabled()) {
              await publishToUser(userId, clipboardMessage);
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));

            // Update heartbeat
            if (deviceId) {
              await pool.query(
                'UPDATE devices SET last_seen_at = NOW() WHERE id = $1',
                [deviceId]
              );
            }
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${message.type}` }));
        }
      } catch (err) {
        logger.error('WebSocket message error:', { error: err.message });
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', async () => {
      // 清除未注册超时计时器
      clearTimeout(unregisteredTimeout);

      if (deviceId) {
        // Remove from connections
        const userDevices = connections.get(userId);
        if (userDevices) {
          userDevices.delete(deviceId);
          if (userDevices.size === 0) {
            connections.delete(userId);
          }
        }

        // Update device offline status
        try {
          await pool.query(
            'UPDATE devices SET is_online = FALSE WHERE id = $1',
            [deviceId]
          );
        } catch (err) {
          logger.error('Failed to update device offline status:', { error: err.message });
        }

        logger.info(`Device ${deviceId} disconnected`);
      }
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error:', { error: err.message });
    });

    // Start heartbeat check
    startHeartbeatCheck(ws, deviceId);
  });

  // Heartbeat check: close connections that haven't sent ping
  function startHeartbeatCheck(ws, deviceId) {
    const interval = setInterval(() => {
      if (ws.readyState !== 1) {
        clearInterval(interval);
        return;
      }

      ws.isAlive = false;
      ws.ping();

      const timeout = setTimeout(() => {
        if (!ws.isAlive) {
          ws.terminate();
        }
      }, config.ws.heartbeatTimeout);

      ws.once('pong', () => {
        ws.isAlive = true;
        clearTimeout(timeout);
      });
    }, config.ws.heartbeatInterval);

    ws.on('close', () => clearInterval(interval));
  }

  return wss;
}

// Broadcast to all devices of a user
export function broadcastToUser(userId, message) {
  // 本地广播（当前实例内的设备）
  const userDevices = connections.get(userId);
  if (userDevices) {
    for (const [deviceId, ws] of userDevices) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(message));
      }
    }
  }

  // Redis Pub/Sub 广播（其他实例的设备）
  if (isWsRedisEnabled()) {
    publishToUser(userId, message).catch((err) => {
      logger.error('[WebSocket] Redis Pub/Sub broadcast failed:', { error: err.message });
    });
  }
}

// Send notification to all devices of a user
// 同时持久化到 notification_history（此前只推 WS 不落库，导致 GET /history 永远为空）
export async function sendNotification(userId, notification) {
  const notificationType = notification.notificationType || 'sync_complete';

  // 1) 落库（UPSERT 风格：createNotification 已处理写入）
  let persistedId = null;
  try {
    const saved = await createNotification({
      userId,
      notificationType,
      title: notification.title,
      content: notification.body,
      metadata: notification.data || {},
    });
    persistedId = saved?.id ?? null;
  } catch (err) {
    logger.error('[WS] 通知落库失败（仍继续推送）:', { error: err?.message, userId });
  }

  // 2) 推送 WS（携带真实 id + type，供前端映射分类与去重）
  const message = {
    type: 'notification',
    id: persistedId != null ? String(persistedId) : `notif_${Date.now()}`,
    notificationType,
    title: notification.title,
    body: notification.body,
    data: notification.data || {},
    timestamp: new Date().toISOString(),
  };

  broadcastToUser(userId, message);

  logger.info('Notification sent', {
    userId,
    notificationType,
    title: notification.title,
    onlineDevices: getOnlineDeviceCount(userId),
  });
}

/**
 * 登录时检测是否为「新设备 / 新登录地点」登录；若是则推送 security_alert。
 * 必须在 createSessionAndGenerateToken 之前调用（此时本次会话尚未入库，历史会话数不含本次）。
 * @param {string} userId
 * @param {{ deviceName?: string, platform?: string, ip?: string }} ctx
 */
export async function detectAndNotifyNewLogin(userId, ctx = {}) {
  const deviceName = (ctx.deviceName || 'Unknown Device').toString();
  const platform = (ctx.platform || 'unknown').toString();
  const ip = ctx.ip || '';
  try {
    const prior = await pool.query('SELECT COUNT(*)::bigint AS cnt FROM user_sessions WHERE user_id = $1', [userId]);
    const priorCount = Number(prior.rows[0]?.cnt || 0);
    if (priorCount === 0) return; // 首次登录（新注册）不报警
    const seen = await pool.query(
      'SELECT 1 FROM user_sessions WHERE user_id = $1 AND device_name = $2 AND platform = $3 LIMIT 1',
      [userId, deviceName, platform]
    );
    if (seen.rows.length > 0) return; // 已知设备，不报警
    await sendNotification(userId, {
      notificationType: 'security_alert',
      title: 'New login detected',
      body: `A new device (${deviceName} · ${platform})${ip ? ` from ${ip}` : ''} just signed in to your account.`,
      data: { deviceName, platform, ip },
    });
  } catch (err) {
    logger.error('[WS] 新登录安全警报检测失败（已忽略）:', { error: err?.message, userId });
  }
}

// Get online device count for a user
export function getOnlineDeviceCount(userId) {
  const userDevices = connections.get(userId);
  return userDevices ? userDevices.size : 0;
}

// Check if a user has any online devices
export function hasOnlineDevices(userId) {
  return getOnlineDeviceCount(userId) > 0;
}

// Get all online users (for admin/monitoring)
export function getOnlineUsers() {
  const onlineUsers = [];
  for (const [userId, devices] of connections) {
    if (devices.size > 0) {
      onlineUsers.push({
        userId,
        deviceCount: devices.size,
        devices: Array.from(devices.keys()),
      });
    }
  }
  return onlineUsers;
}

export { connections };

/**
 * 优雅关闭 WebSocket 服务器
 * 1. 通知所有连接的客户端准备重启（发送 reconnect 消息）
 * 2. 等待客户端断开连接（设置超时）
 * 3. 返回 Promise，关闭完成后 resolve
 * @param {number} timeout - 等待客户端断开的超时时间（毫秒），默认 10 秒
 * @returns {Promise<void>}
 */
export async function gracefulShutdown(timeout = 10000) {
  logger.info('[WebSocket] Starting graceful shutdown...');
  
  // 1. 通知所有客户端重连
  const reconnectMessage = JSON.stringify({
    type: 'server_shutdown',
    message: 'Server is restarting, please reconnect in 5 seconds',
    reconnectAfter: 5000,
    timestamp: Date.now(),
  });

  let clientCount = 0;
  for (const [userId, devices] of connections) {
    for (const [deviceId, ws] of devices) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        try {
          ws.send(reconnectMessage);
          clientCount++;
        } catch (err) {
          // 忽略发送失败
        }
      }
    }
  }

  logger.info(`[WebSocket] Notified ${clientCount} clients to reconnect`);

  // 2. 等待客户端断开（设置超时）
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const checkInterval = setInterval(() => {
      let remainingClients = 0;
      for (const [userId, devices] of connections) {
        for (const [deviceId, ws] of devices) {
          if (ws.readyState === 1) { // WebSocket.OPEN
            remainingClients++;
          }
        }
      }

      if (remainingClients === 0) {
        clearInterval(checkInterval);
        logger.info('[WebSocket] All clients disconnected, shutdown complete');
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        logger.warn(`[WebSocket] Graceful shutdown timeout, ${remainingClients} clients still connected`);
        resolve(); // 超时后强制退出
      }
    }, 500);

    // 3. 同时设置超时保护
    setTimeout(() => {
      clearInterval(checkInterval);
      logger.warn('[WebSocket] Graceful shutdown forced timeout');
      resolve();
    }, timeout);
  });
}

// 进程退出时清理 Redis Pub/Sub 连接
process.on('exit', () => {
  closeWsRedisPubSub();
});

process.on('SIGINT', () => {
  closeWsRedisPubSub();
  process.exit(0);
});

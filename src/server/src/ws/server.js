import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';
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

  wss.on('connection', (ws, req) => {
    console.log('WebSocket connection attempt');

    // Parse token from query string or headers
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

    const userId = decoded.userId;
    let deviceId = null;

    // Register device ID on first message
    ws.on('message', async (data) => {
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

            // Update device online status
            await pool.query(
              'UPDATE devices SET is_online = TRUE, last_seen_at = NOW() WHERE id = $1',
              [deviceId]
            );

            ws.send(JSON.stringify({ type: 'registered', deviceId }));
            console.log(`Device ${deviceId} registered for user ${userId}`);
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
        console.error('WebSocket message error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', async () => {
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
          console.error('Failed to update device offline status:', err);
        }

        console.log(`Device ${deviceId} disconnected`);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
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
      console.error('[WebSocket] Redis Pub/Sub broadcast failed:', err.message);
    });
  }
}

// Send notification to all devices of a user
export function sendNotification(userId, notification) {
  const message = {
    type: 'notification',
    id: `notif_${Date.now()}`,
    title: notification.title,
    body: notification.body,
    data: notification.data || {},
    timestamp: new Date().toISOString(),
  };

  broadcastToUser(userId, message);

  logger.info('Notification sent', {
    userId,
    title: notification.title,
    onlineDevices: getOnlineDeviceCount(userId),
  });
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

// 进程退出时清理 Redis Pub/Sub 连接
process.on('exit', () => {
  closeWsRedisPubSub();
});

process.on('SIGINT', () => {
  closeWsRedisPubSub();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeWsRedisPubSub();
  process.exit(0);
});

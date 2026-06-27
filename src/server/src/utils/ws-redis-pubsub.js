/**
 * WebSocket Redis Pub/Sub 工具
 * 用于多实例部署时，通过 Redis 频道在实例间广播 WebSocket 消息
 *
 * 架构：
 * - 每个实例保留本地 connections Map（存储实际 WebSocket 连接）
 * - 当需要向用户广播消息时，发布到 Redis 频道 `ws:user:{userId}`
 * - 所有实例订阅 `ws:user:*` 通配符，收到消息后转发给本地连接的设备
 * - 实例 ID 用于避免自己发给自己（虽然无害，但浪费）
 */

import redis from 'redis';
import config from '../config.js';

let subscriberClient = null; // Redis Pub/Sub 订阅客户端（独立连接）
let publisherClient = null;  // Redis 发布客户端（复用主连接或独立）
let isRedisEnabled = false;
let instanceId = null;       // 当前实例唯一 ID
let localConnections = null; // 引用本地 connections Map

/**
 * 初始化 WebSocket Redis Pub/Sub
 * @param {Map} connections - 本地 connections Map 的引用
 * @returns {Promise<boolean>} 是否成功初始化
 */
export async function initWsRedisPubSub(connections) {
  // 检查 Redis 是否配置
  if (!config.redis?.host) {
    console.log('[WS Redis Pub/Sub] Redis not configured, using local broadcast only');
    return false;
  }

  try {
    localConnections = connections;
    instanceId = `instance:${process.pid}:${Date.now()}`;

    // 创建独立的订阅客户端（Redis Pub/Sub 需要专用连接）
    subscriberClient = redis.createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
      },
      password: config.redis.password || undefined,
      database: config.redis.database || 0,
    });

    subscriberClient.on('error', (err) => {
      console.error('[WS Redis Pub/Sub] Subscriber error:', err.message);
    });

    subscriberClient.on('connect', () => {
      console.log('[WS Redis Pub/Sub] Subscriber connected');
    });

    await subscriberClient.connect();

    // 订阅通配符频道：接收所有用户的消息
    await subscriberClient.pSubscribe('ws:user:*', (message, channel) => {
      handleRedisMessage(message, channel);
    });

    isRedisEnabled = true;
    console.log(`[WS Redis Pub/Sub] Initialized, instanceId=${instanceId}`);
    return true;
  } catch (err) {
    console.error('[WS Redis Pub/Sub] Failed to initialize:', err.message);
    isRedisEnabled = false;
    return false;
  }
}

/**
 * 处理从 Redis 收到的消息
 * @param {string} message - JSON 字符串消息
 * @param {string} channel - 频道名，格式：ws:user:{userId}
 */
function handleRedisMessage(message, channel) {
  try {
    const parsed = JSON.parse(message);
    const { userId, data, sourceInstanceId } = parsed;

    // 跳过自己发出的消息（避免重复发送）
    if (sourceInstanceId === instanceId) {
      return;
    }

    // 转发给本地连接的该用户设备
    const userDevices = localConnections.get(userId);
    if (!userDevices) {
      return;
    }

    for (const [deviceId, ws] of userDevices) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(data));
      }
    }
  } catch (err) {
    console.error('[WS Redis Pub/Sub] Error handling message:', err.message);
  }
}

/**
 * 向指定用户发布消息（通过 Redis Pub/Sub）
 * @param {string} userId - 用户 ID
 * @param {object} data - 要广播的消息对象
 * @returns {Promise<void>}
 */
export async function publishToUser(userId, data) {
  if (!isRedisEnabled) {
    return; // Redis 未启用，调用方会本地广播
  }

  try {
    // 复用主 Redis 客户端进行发布
    const { getRedisClient } = await import('./redis-client.js');
    const client = await getRedisClient();

    const message = {
      userId,
      data,
      sourceInstanceId: instanceId,
      timestamp: Date.now(),
    };

    const channel = `ws:user:${userId}`;
    await client.publish(channel, JSON.stringify(message));
  } catch (err) {
    console.error('[WS Redis Pub/Sub] Failed to publish:', err.message);
  }
}

/**
 * 向所有在线用户发布系统通知（通过 Redis Pub/Sub）
 * @param {object} notification - 通知对象
 * @returns {Promise<void>}
 */
export async function publishSystemNotification(notification) {
  if (!isRedisEnabled) {
    return;
  }

  try {
    const { getRedisClient } = await import('./redis-client.js');
    const client = await getRedisClient();

    const message = {
      type: 'system_notification',
      notification,
      sourceInstanceId: instanceId,
      timestamp: Date.now(),
    };

    // 发布到系统通知频道
    await client.publish('ws:system', JSON.stringify(message));
  } catch (err) {
    console.error('[WS Redis Pub/Sub] Failed to publish system notification:', err.message);
  }
}

/**
 * 初始化系统通知订阅
 * @param {Function} onSystemNotification - 系统通知回调
 */
export async function initSystemNotificationSubscriber(onSystemNotification) {
  if (!subscriberClient) {
    return false;
  }

  try {
    await subscriberClient.subscribe('ws:system', (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.sourceInstanceId !== instanceId) {
          onSystemNotification(parsed.notification);
        }
      } catch (err) {
        console.error('[WS Redis Pub/Sub] Error handling system notification:', err.message);
      }
    });
    return true;
  } catch (err) {
    console.error('[WS Redis Pub/Sub] Failed to subscribe to system notifications:', err.message);
    return false;
  }
}

/**
 * 关闭 WebSocket Redis Pub/Sub 连接
 */
export async function closeWsRedisPubSub() {
  if (subscriberClient) {
    try {
      await subscriberClient.quit();
      subscriberClient = null;
      isRedisEnabled = false;
      console.log('[WS Redis Pub/Sub] Closed');
    } catch (err) {
      console.error('[WS Redis Pub/Sub] Error closing:', err.message);
    }
  }
}

/**
 * 检查 Redis Pub/Sub 是否启用
 */
export function isWsRedisEnabled() {
  return isRedisEnabled;
}

/**
 * 获取当前实例 ID
 */
export function getInstanceId() {
  return instanceId;
}

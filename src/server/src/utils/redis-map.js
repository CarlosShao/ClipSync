/**
 * RedisMap - Redis-based Map 实现
 * 提供与 Map 相同的接口，但数据存储在 Redis 中
 * 用于多实例部署时共享数据
 */

import Redis from 'redis';
import { logger } from './logger.js';

let redisClient = null;

/**
 * 获取 Redis 客户端（单例）
 */
export function getRedisClient() {
  if (!redisClient) {
    redisClient = Redis.createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
      password: process.env.REDIS_PASSWORD || undefined,
    });
    redisClient.on('error', (err) => logger.error('Redis Client Error', { error: err.message }));
  }
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
}

/**
 * RedisMap 类 - 实现 Map 接口但使用 Redis 存储
 * 注意：不是所有 Map 方法都实现，只实现常用的
 */
export class RedisMap {
  /**
   * @param {string} prefix - Redis key 前缀，用于区分不同 Map
   */
  constructor(prefix) {
    this.prefix = prefix;
  }

  /**
   * 获取完整的 Redis key
   */
  _key(key) {
    return `${this.prefix}:${key}`;
  }

  /**
   * 设置值
   * @param {string} key
   * @param {any} value - 会被 JSON.stringify
   */
  async set(key, value) {
    const client = await getRedisClient();
    await client.set(this._key(key), JSON.stringify(value));
    return this;
  }

  /**
   * 获取值
   * @param {string} key
   * @returns {any|undefined}
   */
  async get(key) {
    const client = await getRedisClient();
    const val = await client.get(this._key(key));
    return val ? JSON.parse(val) : undefined;
  }

  /**
   * 删除键
   * @param {string} key
   * @returns {boolean}
   */
  async delete(key) {
    const client = await getRedisClient();
    const result = await client.del(this._key(key));
    return result > 0;
  }

  /**
   * 检查键是否存在
   * @param {string} key
   * @returns {boolean}
   */
  async has(key) {
    const client = await getRedisClient();
    const result = await client.exists(this._key(key));
    return result === 1;
  }

  /**
   * 清空所有键（只清空当前 prefix）
   */
  async clear() {
    const client = await getRedisClient();
    const keys = await client.keys(`${this.prefix}:*`);
    if (keys.length > 0) {
      await client.del(keys);
    }
  }

  /**
   * 获取所有键
   * @returns {Array<string>}
   */
  async keys() {
    const client = await getRedisClient();
    const keys = await client.keys(`${this.prefix}:*`);
    return keys.map(k => k.replace(`${this.prefix}:`, ''));
  }

  /**
   * 获取所有值
   * @returns {Array<any>}
   */
  async values() {
    const keys = await this.keys();
    const client = await getRedisClient();
    const values = [];
    for (const key of keys) {
      const val = await client.get(this._key(key));
      if (val) values.push(JSON.parse(val));
    }
    return values;
  }

  /**
   * 获取大小
   * @returns {number}
   */
  async size() {
    const keys = await this.keys();
    return keys.length;
  }
}

/**
 * 内存 Map 实现（单实例开发环境用）
 * 保持与原 Map 完全相同的接口
 */
export class MemoryMap {
  constructor() {
    this._map = new Map();
  }

  set(key, value) {
    this._map.set(key, value);
    return this;
  }

  get(key) {
    return this._map.get(key);
  }

  delete(key) {
    return this._map.delete(key);
  }

  has(key) {
    return this._map.has(key);
  }

  clear() {
    this._map.clear();
  }

  keys() {
    return Array.from(this._map.keys());
  }

  values() {
    return Array.from(this._map.values());
  }

  get size() {
    return this._map.size;
  }
}

/**
 * 根据环境创建合适的 Map 实现
 * 生产环境（REDIS_HOST 存在）使用 RedisMap
 * 开发/测试环境使用 MemoryMap
 */
export function createSharedMap(prefix) {
  const useRedis = process.env.NODE_ENV === 'production' && process.env.REDIS_HOST;
  if (useRedis) {
    return new RedisMap(prefix);
  }
  return new MemoryMap();
}

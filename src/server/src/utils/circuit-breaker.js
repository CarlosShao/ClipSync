/**
 * 断路器（Circuit Breaker）工具
 * 
 * 功能：
 * 1. 监控外部服务调用失败率
 * 2. 失败率达到阈值时"跳闸"，快速失败（不穿透到外部服务）
 * 3. 跳闸后进入"半开"状态，尝试恢复
 * 4. 支持降级函数（fallback）
 * 
 * 状态机：
 * CLOSED（关闭） → OPEN（打开/跳闸） → HALF_OPEN（半开） → CLOSED（关闭）
 *                ↓ 失败率达标          ↓ 试探请求成功
 */

import { logger } from './logger.js';

/**
 * 断路器状态
 */
const CircuitState = {
  CLOSED: 'CLOSED',     // 正常关闭（请求可通过）
  OPEN: 'OPEN',           // 打开（请求快速失败）
  HALF_OPEN: 'HALF_OPEN', // 半开（允许一个试探请求）
};

/**
 * 创建断路器实例
 * @param {Object} options - 配置选项
 * @param {string} options.name - 断路器名称（用于日志）
 * @param {number} options.failureThreshold - 失败率阈值（0-1，如 0.5 表示 50%）
 * @param {number} options.minRequests - 最小请求数（达到此数量才开始计算失败率）
 * @param {number} options.timeout - 跳闸后等待时间（毫秒，之后进入半开状态）
 * @param {number} options.successThreshold - 半开状态成功次数（达到此次数则关闭断路器）
 */
export function createCircuitBreaker(options = {}) {
  const {
    name = 'default',
    failureThreshold = 0.5,  // 50% 失败率
    minRequests = 10,         // 最少 10 个请求
    timeout = 30000,          // 30 秒后重试
    successThreshold = 2,      // 连续 2 次成功则关闭
  } = options;

  // 状态
  let state = CircuitState.CLOSED;
  let failureCount = 0;
  let successCount = 0;
  let totalRequests = 0;
  let lastFailureTime = null;
  let nextAttemptTime = null;

  // 统计窗口（滑动窗口，避免内存泄漏）
  const windowSize = 100; // 最多保留 100 个记录
  let recentResults = [];  // Array<{ timestamp: number, success: boolean }>

  /**
   * 记录请求结果
   */
  function recordResult(success) {
    const now = Date.now();
    recentResults.push({ timestamp: now, success });

    // 保持窗口大小
    if (recentResults.length > windowSize) {
      recentResults = recentResults.slice(-windowSize);
    }

    // 清理过期记录（超过 1 分钟的记录）
    const oneMinuteAgo = now - 60000;
    recentResults = recentResults.filter(r => r.timestamp > oneMinuteAgo);
  }

  /**
   * 计算当前失败率
   */
  function getFailureRate() {
    if (recentResults.length === 0) return 0;
    const failures = recentResults.filter(r => !r.success).length;
    return failures / recentResults.length;
  }

  /**
   * 执行函数（带断路器保护）
   * @param {Function} fn - 要执行的函数
   * @param {...any} args - 函数参数
   * @returns {Promise<any>} 执行结果
   */
  async function execute(fn, ...args) {
    // 检查断路器状态
    if (state === CircuitState.OPEN) {
      if (Date.now() >= nextAttemptTime) {
        // 进入半开状态
        state = CircuitState.HALF_OPEN;
        successCount = 0;
        logger.info(`[CircuitBreaker:${name}] Entering HALF_OPEN state`);
      } else {
        // 仍在 OPEN 状态，快速失败
        const err = new Error(`Circuit breaker is OPEN: ${name}`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    try {
      // 执行函数
      const result = await fn(...args);

      // 记录成功
      recordResult(true);
      totalRequests++;
      successCount++;

      // 半开状态：连续成功达到阈值，关闭断路器
      if (state === CircuitState.HALF_OPEN && successCount >= successThreshold) {
        state = CircuitState.CLOSED;
        failureCount = 0;
        successCount = 0;
        totalRequests = 0;
        logger.info(`[CircuitBreaker:${name}] Circuit CLOSED (recovered)`);
      }

      return result;
    } catch (err) {
      // 记录失败
      recordResult(false);
      totalRequests++;
      failureCount++;
      lastFailureTime = Date.now();

      // 检查是否需要跳闸
      if (state === CircuitState.CLOSED && totalRequests >= minRequests) {
        const failureRate = getFailureRate();
        if (failureRate >= failureThreshold) {
          state = CircuitState.OPEN;
          nextAttemptTime = Date.now() + timeout;
          logger.warn(`[CircuitBreaker:${name}] Circuit OPENED (failure rate: ${(failureRate * 100).toFixed(1)}%)`);
        }
      }

      // 半开状态：失败则重新打开
      if (state === CircuitState.HALF_OPEN) {
        state = CircuitState.OPEN;
        nextAttemptTime = Date.now() + timeout;
        successCount = 0;
        logger.warn(`[CircuitBreaker:${name}] Circuit RE-OPENED (test request failed)`);
      }

      throw err;
    }
  }

  /**
   * 获取断路器状态（用于监控）
   */
  function getState() {
    return {
      name,
      state,
      failureCount,
      successCount,
      totalRequests,
      failureRate: getFailureRate(),
      lastFailureTime,
      nextAttemptTime: state === CircuitState.OPEN ? nextAttemptTime : null,
    };
  }

  /**
   * 手动重置断路器（用于管理接口）
   */
  function reset() {
    state = CircuitState.CLOSED;
    failureCount = 0;
    successCount = 0;
    totalRequests = 0;
    recentResults = [];
    logger.info(`[CircuitBreaker:${name}] Circuit manually reset`);
  }

  return {
    execute,
    getState,
    reset,
  };
}

/**
 * 预配置的断路器实例
 */
export const circuitBreakers = {
  // 邮件发送断路器
  email: createCircuitBreaker({
    name: 'email',
    failureThreshold: 0.3,  // 30% 失败率
    minRequests: 5,
    timeout: 60000,          // 1 分钟后重试
    successThreshold: 2,
  }),

  // 支付服务断路器
  payment: createCircuitBreaker({
    name: 'payment',
    failureThreshold: 0.2,  // 20% 失败率（支付更敏感）
    minRequests: 3,
    timeout: 120000,         // 2 分钟后重试
    successThreshold: 3,
  }),

  // SMS 服务断路器
  sms: createCircuitBreaker({
    name: 'sms',
    failureThreshold: 0.4,  // 40% 失败率
    minRequests: 5,
    timeout: 60000,
    successThreshold: 2,
  }),
};

/**
 * 获取所有断路器状态（用于监控接口）
 */
export function getAllCircuitStates() {
  const states = {};
  for (const [name, breaker] of Object.entries(circuitBreakers)) {
    states[name] = breaker.getState();
  }
  return states;
}

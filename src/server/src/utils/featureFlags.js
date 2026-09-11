import fs from 'node:fs';
import path from 'node:path';
import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 功能开关读取层（feature_flags 表）——客户端行为强制生效的唯一事实来源。
 *
 * 生效链路与优先级（对设置页说明文案同样适用）：
 *   1. 管理台 PATCH /api/admin/flags/:key 写库（持久化）→ 本进程缓存失效 + WS 全端广播
 *      `feature_flags.updated`；
 *   2. 服务端各端点经 isFlagEnabled/requireFlag 强制拦截（~5s 内全进程生效，跨进程靠短 TTL）；
 *   3. 客户端可 GET /api/app/feature-flags 主动拉取，或接收 WS 推送即时感知；
 *      未适配的客户端在下次请求时被服务端 403 拒绝（兜底）。
 *
 * 缓存策略：进程内 5s TTL。读库失败时按 fallback 放行并告警——开关系统故障不阻塞主业务。
 */

const FLAG_TTL_MS = 5000;
let cache = { map: null, at: 0 };

/** 返回 `{ [flagKey]: enabled }` 全量快照（带 5s 进程内缓存） */
export async function getFeatureFlags() {
  const now = Date.now();
  if (cache.map && now - cache.at < FLAG_TTL_MS) return cache.map;
  const { rows } = await pool.query('SELECT flag_key, enabled FROM feature_flags');
  const map = Object.fromEntries(rows.map((r) => [r.flag_key, Boolean(r.enabled)]));
  cache = { map, at: now };
  return map;
}

/** 管理台写库后调用：立刻失效本进程缓存，下次读取直连库 */
export function invalidateFlagsCache() {
  cache = { map: null, at: 0 };
}

/**
 * 读取单个开关。缺表/查库失败时返回 fallback（默认 true=放行）：
 * 开关基础设施故障不应导致全体用户功能不可用。
 */
export async function isFlagEnabled(key, fallback = true) {
  try {
    const flags = await getFeatureFlags();
    return flags[key] ?? fallback;
  } catch (err) {
    logger.warn('[featureFlags] read failed, fallback enabled', { key, error: err.message });
    return fallback;
  }
}

/**
 * 端点守卫中间件工厂：开关关闭时返回 403 JSON（带 flagDisabled 标识，客户端可据此提示）。
 * @param {string} key feature_flags.flag_key
 * @param {string} message 关闭时的用户可见提示
 */
export function requireFlag(key, message) {
  return async (req, res, next) => {
    if (await isFlagEnabled(key)) return next();
    res.status(403).json({ error: message, flagDisabled: key });
  };
}

// ───────────────────────── AN-10：强制点自检 ─────────────────────────
// 目标：防 AF-04「UI 有开关、后端无强制点」复发——GET /api/admin/flags 的
// enforced 字段必须反映**事实**，而非一份靠人肉纪律维护的清单。
//
// 历史：曾用手写 ENFORCED_FLAG_KEYS 数组，要求新增开关时手动 grep 同步，
// 漏登则 enforced 静默失真（审计发现的结构性隐患）。现改为**启动时扫描
// 已加载模块的源码**，自动发现 requireFlag('<key>') / isFlagEnabled('<key>')
// 调用点，人工同步环节归零。
//
// 口径说明：扫描的是磁盘源码而非运行时栈，因此：
//   - 能发现所有「写了字面量键名」的强制点（本项目全部如此，无动态拼接键）
//   - 测试文件（tests/）不计入——它们不构成生产强制点
export const ENFORCED_FLAG_KEYS = scanEnforcedFlagKeys();

function scanEnforcedFlagKeys() {
  try {
    // 本文件位于 src/server/src/utils/，源码根为其上一级
    const srcRoot = path.resolve(import.meta.dirname, '..');
    const found = new Set();
    const pattern = /(?:requireFlag|isFlagEnabled)\(\s*'([a-z0-9_]+)'/g;

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // node_modules / 测试不构成生产强制点
          if (e.name === 'node_modules' || e.name === 'tests' || e.name === '__tests__') continue;
          walk(full);
        } else if (e.name.endsWith('.js')) {
          let code;
          try {
            code = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          for (const m of code.matchAll(pattern)) found.add(m[1]);
        }
      }
    };

    walk(srcRoot);
    const keys = [...found].sort();
    logger.info('[featureFlags] enforced keys scanned at startup', { keys });
    return keys;
  } catch (err) {
    // 扫描失败不阻断启动：退回空清单，flags 接口会如实返回 enforced:false
    // （宁可信其无，不可谎报有——这正是本机制要防的）
    logger.warn('[featureFlags] enforced scan failed, enforced will report false', {
      error: err.message,
    });
    return [];
  }
}

/** 该开关是否存在服务端强制点（启动时源码扫描所得，清单外键一律 false） */
export function isFlagEnforced(key) {
  return ENFORCED_FLAG_KEYS.includes(key);
}

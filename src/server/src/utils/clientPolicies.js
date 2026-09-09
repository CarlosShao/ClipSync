import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 客户端策略下发读取层（client_policies 表）——AN-02。
 *
 * 生效链路与 featureFlags.js 同款（复用既有下发通道模式，不重复造轮子）：
 *   1. 管理台 PATCH /api/admin/policies 写库 → 本进程缓存失效 + WS 全端广播
 *      `policies.updated`；
 *   2. 客户端 GET /api/app/policies 主动拉取（公开只读，ETag/短缓存），或接收 WS
 *      推送即时感知；
 *   3. 未适配的客户端下次启动拉取时生效（最终一致）。
 *
 * 容错策略：表缺失 / 查库失败 → 返回目录默认值（fail-open），策略系统故障
 * 不阻塞客户端主流程；与 featureFlags 的 fallback 哲学一致。
 *
 * 目录 default 语义 = 「不干预」：未配置策略时与历史行为完全一致（零破坏），
 * 运营显式配置后才产生约束（如 sync_interval_min_minutes=15 → 客户端同步间隔下限 15 分钟）。
 *
 * consumer（对齐 AN-09 治理机制）：每键登记真实消费方文件，禁止臆造——
 * 新增键必须先 grep 查证客户端消费点再登记；查无消费点一律 null（管理台
 * /policies 页可据此打「未接入」角标）。注意：本目录键存于 client_policies 表，
 * 不在 system_configs 的 CONFIG_CATALOG（两者是不同的键空间，勿混登记）。
 */

const POLICY_TTL_MS = 5000;
let cache = { snapshot: null, at: 0 };

// ───────────────────────── 策略键目录（唯一真相源） ─────────────────────────
export const POLICY_CATALOG = [
  {
    key: 'pin_min_length',
    name: 'PIN 最小长度',
    description: '客户端设置/修改隐私 PIN 的最小位数（4-6，默认 4）',
    group: 'privacy',
    type: 'number',
    defaultValue: 4,
    min: 4,
    max: 6,
    // AN-02 查证：src/desktop/src/composables/usePrivacy.ts setPin + PrivacySettings.vue handleSetPin
    consumer: 'src/desktop/src/composables/usePrivacy.ts（setPin 最小位数校验）',
  },
  {
    key: 'sync_interval_min_minutes',
    name: '同步间隔下限（分钟）',
    description: '客户端自动同步间隔不得低于该值（0/5/15，0 = 不干预；用于企业强制降频省流量）',
    group: 'sync',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 15,
    // AN-02 查证：HomeView.vue syncInterval watcher → clip.setPollInterval；GeneralSettings.vue 选项置灰
    consumer: 'src/desktop/src/views/HomeView.vue（setPollInterval 下限钳制）+ GeneralSettings.vue',
  },
  {
    key: 'max_history_items',
    name: '剪贴板历史上限（条）',
    description: '客户端本地历史保留条数不得高于该值（0 = 不干预；100/500/1000）',
    group: 'sync',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100000,
    // AN-02 查证：HomeView.vue maxHistory watcher → clip.setMaxHistory → clipboardLoad.trimToMaxHistory
    consumer: 'src/desktop/src/views/HomeView.vue（setMaxHistory 上限钳制）+ GeneralSettings.vue',
  },
];

const POLICY_MAP = new Map(POLICY_CATALOG.map((p) => [p.key, p]));

/**
 * 归一化单键补丁值：类型/边界校验（数字键转整数并夹取 min/max）。
 * @returns {{ ok: true, value: number|boolean, allowUserOverride: boolean }
 *          | { ok: false, error: string }}
 */
function normalizePolicyEntry(meta, entry) {
  if (entry === null || typeof entry !== 'object') {
    return { ok: false, error: `策略 ${meta.key} 的值格式非法` };
  }
  const allowUserOverride =
    entry.allowUserOverride === undefined ? true : Boolean(entry.allowUserOverride);
  if (meta.type === 'number') {
    const n = Number(entry.value);
    if (!Number.isFinite(n)) return { ok: false, error: `策略 ${meta.key} 必须为数字` };
    const clamped = Math.min(meta.max, Math.max(meta.min, Math.round(n)));
    return { ok: true, value: clamped, allowUserOverride };
  }
  return { ok: false, error: `策略 ${meta.key} 类型未知` };
}

/**
 * 读取全局策略快照（带 5s 进程内缓存）。
 * 返回 { [key]: { value, allowUserOverride } }——仅含目录内键，未配置键用 default。
 * 表缺失/查询失败 → 全 default（fail-open）。
 */
export async function getClientPolicies() {
  const now = Date.now();
  if (cache.snapshot && now - cache.at < POLICY_TTL_MS) return cache.snapshot;

  const fallback = Object.fromEntries(
    POLICY_CATALOG.map((meta) => [meta.key, { value: meta.defaultValue, allowUserOverride: true }])
  );
  try {
    const { rows } = await pool.query(
      'SELECT payload, updated_at FROM client_policies WHERE scope = $1 LIMIT 1',
      ['global']
    );
    const stored = rows[0]?.payload && typeof rows[0].payload === 'object' ? rows[0].payload : {};
    const snapshot = { ...fallback };
    for (const meta of POLICY_CATALOG) {
      const entry = stored[meta.key];
      if (entry === undefined) continue;
      const norm = normalizePolicyEntry(meta, entry);
      if (norm.ok) {
        snapshot[meta.key] = { value: norm.value, allowUserOverride: norm.allowUserOverride };
      } else {
        logger.warn('[clientPolicies] invalid stored entry ignored', { key: meta.key });
      }
    }
    cache = { snapshot, at: now };
    return snapshot;
  } catch (err) {
    // 表未迁移 / DB 抖动：返回目录默认值（等价未配置策略），不抛错
    logger.warn('[clientPolicies] read failed, falling back to defaults', { error: err.message });
    return fallback;
  }
}

/** 快照的 updated_at（展示/调试用；快照缓存不含它，单独查）。失败返回 null。 */
export async function getClientPoliciesUpdatedAt() {
  try {
    const { rows } = await pool.query(
      'SELECT updated_at FROM client_policies WHERE scope = $1 LIMIT 1',
      ['global']
    );
    return rows[0]?.updated_at?.toISOString?.() ?? null;
  } catch {
    return null;
  }
}

/** 管理台写库后调用：立刻失效本进程缓存 */
export function invalidatePoliciesCache() {
  cache = { snapshot: null, at: 0 };
}

/**
 * 校验并归一化管理台 PATCH body.policies（部分更新，未知键拒绝 404 语义由路由层处理）。
 * @param {Record<string, {value: any, allowUserOverride?: boolean}>} patch
 * @returns {{ ok: true, normalized: object } | { ok: false, error: string, unknownKey?: string }}
 */
export function normalizePolicyPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'policies 必须为对象' };
  }
  const normalized = {};
  for (const [key, entry] of Object.entries(patch)) {
    const meta = POLICY_MAP.get(key);
    if (!meta) return { ok: false, error: `策略键不存在：${key}`, unknownKey: key };
    const norm = normalizePolicyEntry(meta, entry);
    if (!norm.ok) return { ok: false, error: norm.error };
    normalized[key] = { value: norm.value, allowUserOverride: norm.allowUserOverride };
  }
  return { ok: true, normalized };
}

/**
 * 写入全局策略（部分合并：jsonb_merge 保持未提及键不变），返回合并后的完整 payload。
 * 调用方负责 invalidatePoliciesCache + 广播 + 审计。
 */
export async function mergeClientPolicies(normalizedPatch, updatedBy) {
  const { rows } = await pool.query(
    `UPDATE client_policies
        SET payload = payload || $2::jsonb,
            updated_by = $3,
            updated_at = NOW()
      WHERE scope = $1
      RETURNING payload, updated_at`,
    ['global', JSON.stringify(normalizedPatch), updatedBy ?? null]
  );
  return rows[0] ?? null;
}

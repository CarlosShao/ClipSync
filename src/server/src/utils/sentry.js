import pool from '../db/pool.js';
import { logger } from './logger.js';
import { decryptField } from './encryption.js';

/**
 * 错误追踪（Sentry）—— **运行时可配置，未配置则全程 no-op**。
 *
 * 为什么要有这个文件：`SENTRY_DSN` 此前只出现在 `.env.example`，代码零读取 ——
 * 注册了 Sentry 也不会有任何事件上报（v1 全量审计 §06 记为"文档漂移"）。
 *
 * 设计三条，与 `utils/sms.js`（A4 短信）、`utils/email.js`（邮件通道）完全对称：
 *   1. **配置来自 `system_configs`**（迁移 086 种入 `sentry_dsn`），管理台可填，
 *      不进 env、不必重启容器；5s 进程内缓存 + 管理台保存即失效。
 *   2. **SDK 动态 import**（`@sentry/node`）：未配置 DSN 时不加载、零开销；
 *      与 `storage.js` 的 S3 分支、`sms.js` 的阿里云 SDK 同一套"可选依赖"策略。
 *   3. **fail-open**：追踪是辅助能力，任何一步失败（读库失败/DSN 格式错/SDK 未装）
 *      都只记 warn，**绝不影响主链路**，也绝不抛错给调用方。
 *
 * 隐私口径（硬性）：
 *   - `sendDefaultPii: false`
 *   - `beforeSend: scrubEvent` —— 剔除请求体、Cookie、Authorization/X-CSRF 头、
 *     含 phone|token|code 的 query、extra 里的手机号/邮箱/密钥/剪贴板内容、整个 user 段。
 *   - 只上报服务端错误（未捕获异常、unhandledRejection、5xx），不上报业务埋点/性能数据
 *     （`tracesSampleRate: 0`）。
 *
 * 自托管替代：GlitchTip 同 DSN 协议，改填即可。
 */

const SENTRY_TTL_MS = 5000;
const SENTRY_KEYS = ['sentry_dsn'];

/** { dsn: string|undefined, at: number }；dsn=undefined 表示"还没读过" */
let cfgCache = { dsn: undefined, at: 0 };

/** 已初始化的 SDK 模块（null = 未启用，captureError 直接 no-op） */
let sdk = null;
/** 上次初始化使用的 DSN（变更时 close + 重新 init） */
let initializedWith = '';

function toTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * DSN 形状校验：`http(s)://<publicKey>@<host>/<projectId>`，**允许 project 前带子路径**
 * （自托管 Sentry / GlitchTip 常挂在反代的 `/sentry/42` 下）。
 *
 * 为什么要校验而不是"非空即用"：这是运营手填的自由文本字段，填错（比如把说明文字、
 * 带空格的地址贴进来）会让 SDK init 抛错。宁可判为"未配置"（no-op），也不要让追踪模块
 * 变成启动期的不稳定因素。projectId 不要求纯数字——自托管 GlitchTip 的 id 可能是短串。
 */
export function isValidDsn(value) {
  return /^https?:\/\/[^\s/@]+@[^\s/]+\/\S+$/.test(toTrimmedString(value));
}

/**
 * 读取 DSN：DB 优先，env (`SENTRY_DSN`) 兜底（兼容老部署已写进 env 的情况）。
 * 返回 '' 表示未配置/不可用。
 */
export async function getSentryDsn() {
  const now = Date.now();
  if (cfgCache.dsn !== undefined && now - cfgCache.at < SENTRY_TTL_MS) {
    return cfgCache.dsn;
  }
  let value = '';
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [SENTRY_KEYS]
    );
    for (const r of rows) {
      if (r.config_key !== 'sentry_dsn') continue;
      let v = r.config_value;
      // JSONB 列：pg 返回已解析的 JS 值（字符串存的是带引号的 JSON）
      if (v && typeof v === 'object') v = v.value ?? '';
      value = toTrimmedString(v);
    }
  } catch (err) {
    // 读库失败不覆写缓存（保住最近一次成功快照语义），并按"当前状态"继续
    logger.warn('[sentry] 读取 sentry_dsn 失败，按当前状态处理', { error: err.message });
    return cfgCache.dsn === undefined ? '' : cfgCache.dsn;
  }
  if (!value) value = toTrimmedString(process.env.SENTRY_DSN);
  const dsn = isValidDsn(value) ? value : '';
  cfgCache = { dsn, at: now };
  return dsn;
}

/** 管理台保存 `sentry_dsn` 后调用：下次读取必回源 */
export function invalidateSentryConfigCache() {
  cfgCache = { dsn: undefined, at: 0 };
}

/**
 * PII 清洗（beforeSend）。导出是为了可直接单测：这条链路一旦漏，
 * 就是把用户手机号/剪贴板内容送进第三方，必须有测试钉住。
 */
export function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  try {
    // 请求体与 Cookie 一律不送（体里可能是剪贴板内容、AI 密钥、密码）
    if (event.request) {
      delete event.request.data;
      delete event.request.cookies;
      delete event.request.env;
      const headers = event.request.headers;
      if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (/authorization|cookie|csrf|token|secret/i.test(k)) delete headers[k];
        }
      }
      if (typeof event.request.query_string === 'string' && /phone|token|code|secret/i.test(event.request.query_string)) {
        event.request.query_string = '[Filtered]';
      }
    }
    // extra 里的敏感字段
    if (event.extra && typeof event.extra === 'object') {
      for (const k of Object.keys(event.extra)) {
        if (/phone|mobile|email|token|secret|password|content|clipboard|payload/i.test(k)) {
          event.extra[k] = '[Filtered]';
        }
      }
    }
    // 不报用户身份（手机号/邮箱/内部 id 都不给第三方）
    if (event.user) delete event.user;
  } catch {
    // 清洗失败也绝不能影响上报；最坏情况是 SDK 默认口径（sendDefaultPii=false）
  }
  return event;
}

/**
 * 初始化 / 重初始化。
 *
 * @returns {Promise<boolean>} 是否处于"已启用"状态
 */
export async function initSentry() {
  let dsn = '';
  try {
    dsn = await getSentryDsn();
  } catch {
    return false;
  }
  if (!dsn) {
    return false; // 未配置 ⇒ 全程 no-op（captureError 会直接返回 false）
  }
  if (sdk && initializedWith === dsn) return true;

  try {
    const mod = await import('@sentry/node');
    // DSN 变更：先关掉旧的，避免双份上报
    if (sdk && initializedWith && initializedWith !== dsn) {
      try {
        await sdk.close(1000);
      } catch {
        /* 关旧实例失败不影响新实例 */
      }
    }
    mod.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.APP_VERSION || undefined,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
    });
    sdk = mod;
    initializedWith = dsn;
    logger.info('[sentry] 错误追踪已启用（DSN 已配置，已关闭 PII 采集）');
    return true;
  } catch (err) {
    // 最常见原因：`@sentry/node` 未安装（可选依赖），或 DSN 被服务端拒绝
    logger.warn('[sentry] 初始化失败，错误追踪保持关闭（不影响服务）', { error: err.message });
    sdk = null;
    initializedWith = '';
    return false;
  }
}

/** 是否已发起过惰性初始化（避免每次上报都重复 import） */
let lazyInitStarted = false;/**
 * 上报异常。未启用 / SDK 出错时一律静默返回 false，绝不抛错。
 *
 * 惰性初始化：若尚未启用，这里**顺手发起一次 `initSentry()`**（不 await）。这样调用方
 * 只需要在错误现场调一下本函数，无需关心"启动期有没有 init 过"——生产 worktree 与分支
 * 的启动块结构不一致时，这个设计能避免"接线漏了就不生效"。
 * 代价：配置好 DSN 后**第一条**错误可能在 init 完成前丢失（第二条起正常），可接受。
 */
export function captureError(err, context) {
  if (!sdk) {
    if (!lazyInitStarted) {
      lazyInitStarted = true;
      // fire-and-forget：失败只 warn（initSentry 内部已处理）
      void initSentry().catch(() => {});
    }
    return false;
  }
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    sdk.captureException(e, context && typeof context === 'object' ? { extra: context } : undefined);
    return true;
  } catch {
    return false;
  }
}

/** 退出前冲刷（uncaughtException 用），带超时，绝不阻塞关停。 */
export async function flushSentry(timeoutMs = 2000) {
  if (!sdk) return;
  try {
    await sdk.flush(timeoutMs);
  } catch {
    /* 冲刷失败就直接退出 */
  }
}

export function isSentryEnabled() {
  return Boolean(sdk);
}

// ============================================================================
// 管理台集成：读**错误列表**（迁移 087 的 sentry_api_token）
//
// 为什么要单独一个 token：DSN 是**只写**凭据（Sentry 设计如此，只够上报）；
// 读 issue 必须用 API Token（scope `project:read` + `event:read`）。
// 运营只需填两个值：`sentry_dsn`（机构/项目从 DSN 推导）+ `sentry_api_token`。
// ============================================================================

const SENTRY_API_KEYS = ['sentry_api_token'];
let apiTokenCache = { token: undefined, at: 0 };

/** 读 API Token（加密落库，读取解密；5s 缓存，管理台保存即失效） */
export async function getSentryApiToken() {
  const now = Date.now();
  if (apiTokenCache.token !== undefined && now - apiTokenCache.at < SENTRY_TTL_MS) {
    return apiTokenCache.token;
  }
  let raw = '';
  try {
    const { rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [SENTRY_API_KEYS]
    );
    for (const r of rows) {
      if (r.config_key !== 'sentry_api_token') continue;
      let v = r.config_value;
      if (v && typeof v === 'object') v = v.value ?? '';
      raw = toTrimmedString(v);
    }
  } catch (err) {
    logger.warn('[sentry] 读取 sentry_api_token 失败', { error: err.message });
    return apiTokenCache.token === undefined ? '' : apiTokenCache.token;
  }
  // 与 smtp_pass / sms_access_key_secret 同口径：密文落库 → 读取解密
  const token = raw ? toTrimmedString(decryptField(raw)) : '';
  apiTokenCache = { token, at: now };
  return token;
}

export function invalidateSentryApiTokenCache() {
  apiTokenCache = { token: undefined, at: 0 };
}

/**
 * 从 sentry.io 的 DSN 推导 `{orgId, projectId, apiBase}`。
 *
 * DSN 形如 `https://<key>@o4507123456.ingest.sentry.io/4507123456`：
 * 机构 id 就是 `o` 后面那段，项目 id 是末段 ⇒ **不必再让运营填 org/project**。
 * 自托管（GlitchTip 等）的 DSN 形状不同 ⇒ 返回 null，由调用方明确报"不支持"，
 * 不猜、不假装能查。
 */
export function parseSentryDsn(dsn) {
  const m = toTrimmedString(dsn).match(/^(https?):\/\/[^@/\s]+@o(\d+)\.ingest\.([^/\s]+)\/(\d+)/);
  if (!m) return null;
  return { scheme: m[1], orgId: m[2], ingestHost: m[3], projectId: m[4], apiBase: `${m[1]}://sentry.io` };
}

/** 小工具：带超时的 fetch（Sentry 挂了也不能把管理台拖死） */
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取未解决 issue 列表（管理台「最近错误」卡）。
 *
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string, records?:Array}>}
 *   records 每项：{ id, shortId, title, culprit, level, count, userCount,
 *                  firstSeen, lastSeen, permalink, status }
 *   permalink 直接用于"点进去看详情"（省得我们自己拼 URL）。
 */
export async function fetchSentryIssues({ limit = 20, query = 'is:unresolved' } = {}) {
  const dsn = await getSentryDsn();
  if (!dsn) return { ok: false, reason: 'not_configured' };
  const token = await getSentryApiToken();
  if (!token) return { ok: false, reason: 'no_api_token' };
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    return {
      ok: false,
      reason: 'unsupported_dsn',
      detail: '当前 DSN 不是 sentry.io 形状（自托管需另配 org/project），暂不支持在后台内查询',
    };
  }

  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const url =
    `${parsed.apiBase}/api/0/organizations/${parsed.orgId}/issues/` +
    `?project=${parsed.projectId}&query=${encodeURIComponent(query)}&limit=${n}&sort=date`;

  try {
    const resp = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      8000
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        ok: false,
        reason: resp.status === 401 || resp.status === 403 ? 'token_rejected' : 'api_error',
        detail: `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }
    const body = await resp.json();
    const list = Array.isArray(body) ? body : [];
    return {
      ok: true,
      orgId: parsed.orgId,
      projectId: parsed.projectId,
      records: list.map((it) => ({
        id: it?.id ?? null,
        shortId: it?.shortId ?? null,
        title: it?.title ?? null,
        culprit: it?.culprit ?? null,
        level: it?.level ?? null,
        count: Number(it?.count ?? 0),
        userCount: Number(it?.userCount ?? 0),
        firstSeen: it?.firstSeen ?? null,
        lastSeen: it?.lastSeen ?? null,
        permalink: it?.permalink ?? null,
        status: it?.status ?? null,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      detail: err?.message || String(err),
    };
  }
}

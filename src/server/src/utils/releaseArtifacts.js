import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 发布产物下载地址解析层（GH-01）。
 *
 * 背景：`routes/app.js` 的 `/update.json` 曾对「平台无产物」分支硬编码回退
 * `https://example.com/downloads/...`——一个虚构域名。客户端拿到它会真的去请求，
 * 表现为下载 404/超时而非「服务器没配下载地址」，运维侧完全看不出根因。
 *
 * 本模块把下载地址的「来源」收敛为一处，按以下优先级解析：
 *   1. app_releases.platforms[target].url —— 发布单里的显式地址（最高优先级，逐版本覆盖）
 *   2. RELEASE_DOWNLOAD_BASE_URL 环境变量 —— 部署级覆盖（自建镜像站/对象存储）
 *   3. system_configs.release_download_base_url —— 管理台可改（迁移 067 种子）
 *   4. 都没有 → 返回 `undefined`，由调用方输出明确的「未配置」状态
 *
 * ⚠️ 本模块**绝不**返回占位/示例域名。未配置就是未配置——见 resolvePlatformDownload()。
 *
 * 托管方案：GitHub Releases（仓库 CarlosShao/ClipSync）。
 * 产物 URL 形态：https://github.com/<owner>/<repo>/releases/download/v<version>/<filename>
 * 若 system_configs 里配的是裸 base（如 https://github.com/CarlosShao/ClipSync），
 * 则按上述形态自动拼出下载地址（见 buildGitHubReleaseUrl）。
 */

/** 默认发布仓库（GitHub Releases 托管，用户已确认方案） */
export const DEFAULT_RELEASE_REPO = 'CarlosShao/ClipSync';

/** GitHub Releases 域名前缀 → [owner, repo]，用于识别「base 是 GitHub 仓库地址」这一形态 */
const GITHUB_REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

const BASE_URL_CONFIG_KEY = 'release_download_base_url';

const TTL_MS = 60_000;
let cache = { value: null, at: 0 };

/**
 * 读 system_configs.release_download_base_url（JSONB 字符串）。
 * 缺行/查库失败 → 空串（不抛，调用方继续走下一优先级）。
 */
async function readConfiguredBaseUrl() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) return cache.value;

  let value = '';
  try {
    const { rows } = await pool.query(
      'SELECT config_value FROM system_configs WHERE config_key = $1 LIMIT 1',
      [BASE_URL_CONFIG_KEY]
    );
    const raw = rows[0]?.config_value;
    if (typeof raw === 'string') value = raw.trim();
    else if (typeof raw === 'number') value = String(raw);
  } catch (err) {
    // 表未迁移/库抖动：不写缓存（下次重试），按未配置处理
    logger.warn('[releaseArtifacts] release_download_base_url read failed', { error: err.message });
    return value;
  }
  cache = { value, at: now };
  return value;
}

/** 管理台写库后调用（configs.js PATCH 路径）：立刻失效进程内缓存 */
export function invalidateReleaseArtifactCache() {
  cache = { value: null, at: 0 };
}

/** 去掉尾部斜杠（拼接前统一） */
function trimTrailingSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

/**
 * 产物文件名。
 * 优先用 platforms[target].filename（发布单显式声明）；
 * 缺省按 Tauri 默认打包命名推一个（NSIS 目标 → <product>_<version>_x64-setup.exe）。
 */
export function resolveArtifactFilename(target, version, platformEntry) {
  const declared = platformEntry?.filename;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();

  // 兜底命名：仅在 base 已知时使用，且必须与 tauri build 的真实产物名对齐后才发布。
  const v = String(version || '').trim();
  if (target === 'windows-x86_64') return `ClipSync_${v}_x64-setup.exe`;
  if (target === 'darwin-aarch64') return `ClipSync_${v}_aarch64.app.tar.gz`;
  if (target === 'darwin-x86_64') return `ClipSync_${v}_x64.app.tar.gz`;
  if (target === 'linux-x86_64') return `ClipSync_${v}_amd64.AppImage.tar.gz`;
  return `ClipSync_${v}_${target}`;
}

/**
 * base 是 GitHub 仓库地址 → 按 GitHub Releases 形态拼下载 URL；
 * base 是普通 CDN/镜像前缀 → 直接 base + '/' + filename。
 */
export function buildArtifactUrl(base, version, filename) {
  const cleaned = trimTrailingSlash(base);
  if (!cleaned) return undefined;

  const gh = GITHUB_REPO_RE.exec(cleaned);
  if (gh) {
    const [, owner, repo] = gh;
    // tag 形态固定为 v<version>（发布流程要求打 v* tag）
    return `https://github.com/${owner}/${repo}/releases/download/v${version}/${filename}`;
  }
  return `${cleaned}/${filename}`;
}

/**
 * 解析某平台产物的下载地址。
 *
 * @returns {Promise<{ url?: string, source?: string, unconfigured?: string }>}
 *   - 命中：{ url, source }，source ∈ 'release' | 'env' | 'config'
 *   - 未配置：{ unconfigured: '<机器可读原因>' }，**不含 url 字段**
 */
export async function resolvePlatformDownload(target, version, platformEntry) {
  // 1. 发布单显式地址优先（运维逐版本可控制）
  const declaredUrl = platformEntry?.url;
  if (typeof declaredUrl === 'string' && /^https?:\/\//.test(declaredUrl.trim())) {
    return { url: declaredUrl.trim(), source: 'release' };
  }

  const filename = resolveArtifactFilename(target, version, platformEntry);

  // 2. 环境变量覆盖（部署级；自建镜像站/内网对象存储）
  const envBase = trimTrailingSlash(process.env.RELEASE_DOWNLOAD_BASE_URL);
  if (envBase) {
    return { url: buildArtifactUrl(envBase, version, filename), source: 'env' };
  }

  // 3. 管理台配置（system_configs.release_download_base_url）
  const configBase = trimTrailingSlash(await readConfiguredBaseUrl());
  if (configBase) {
    return { url: buildArtifactUrl(configBase, version, filename), source: 'config' };
  }

  // 4. 未配置：明确告知，绝不伪造 example.com
  return { unconfigured: 'RELEASE_DOWNLOAD_URL_NOT_CONFIGURED' };
}

/**
 * GitHub Releases 托管下的「人可读」默认地址（仅用于文档/管理台提示，
 * **不参与运行时解析**——未配置就返回未配置，不用默认值偷偷兜底）。
 */
export function describeGitHubReleaseUrl(version, filename, repo = DEFAULT_RELEASE_REPO) {
  return `https://github.com/${repo}/releases/download/v${version}/${filename}`;
}

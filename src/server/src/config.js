import 'dotenv/config';
import developmentConfig from './config/development.js';
import testConfig from './config/test.js';
import productionConfig from './config/production.js';

// Select config based on NODE_ENV
const envConfigs = {
  development: developmentConfig,
  test: testConfig,
  production: productionConfig,
};

const nodeEnv = process.env.NODE_ENV || 'development';
const envConfig = envConfigs[nodeEnv] || developmentConfig;

// Deep merge: env vars override config files
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key]) &&
      typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else if (override[key] !== undefined) {
      result[key] = override[key];
    }
  }
  return result;
}

// Environment variable overrides (highest priority)
// NOTE: only include keys when the env var is actually set,
// otherwise leave them out so deepMerge doesn't overwrite with undefined.
const envOverrides = {};

if (process.env.PORT) envOverrides.port = parseInt(process.env.PORT, 10);
if (process.env.HOST) envOverrides.host = process.env.HOST;
if (process.env.LOG_LEVEL) envOverrides.logLevel = process.env.LOG_LEVEL;

// 测试环境强制使用 testConfig 的独立测试库（clipsync_test），
// 避免 .env 中的 DB_NAME=clipsync_dev 等覆盖把整套测试拉到共享 dev 库，
// 造成用例间数据污染与随机失败。其余环境保持原有 env 覆盖行为。
if (nodeEnv !== 'test' && (process.env.DB_HOST || process.env.DB_PORT || process.env.DB_NAME || process.env.DB_USER || process.env.DB_PASSWORD)) {
  envOverrides.db = {};
  if (process.env.DB_HOST) envOverrides.db.host = process.env.DB_HOST;
  if (process.env.DB_PORT) envOverrides.db.port = parseInt(process.env.DB_PORT, 10);
  if (process.env.DB_NAME) envOverrides.db.name = process.env.DB_NAME;
  if (process.env.DB_USER) envOverrides.db.user = process.env.DB_USER;
  if (process.env.DB_PASSWORD) envOverrides.db.password = process.env.DB_PASSWORD;
}

if (process.env.REDIS_HOST || process.env.REDIS_PORT || process.env.REDIS_PASSWORD) {
  envOverrides.redis = {};
  if (process.env.REDIS_HOST) envOverrides.redis.host = process.env.REDIS_HOST;
  if (process.env.REDIS_PORT) envOverrides.redis.port = parseInt(process.env.REDIS_PORT, 10);
  if (process.env.REDIS_PASSWORD) envOverrides.redis.password = process.env.REDIS_PASSWORD;
}

if (process.env.JWT_SECRET) {
  envOverrides.jwt = { ...(envOverrides.jwt || {}), secret: process.env.JWT_SECRET };
}
if (process.env.JWT_EXPIRES_IN) {
  envOverrides.jwt = { ...(envOverrides.jwt || {}), expiresIn: process.env.JWT_EXPIRES_IN };
}

if (process.env.CORS_ORIGINS) {
  envOverrides.cors = { origins: process.env.CORS_ORIGINS.split(',') };
}

if (process.env.WS_HEARTBEAT_INTERVAL || process.env.WS_HEARTBEAT_TIMEOUT) {
  envOverrides.ws = {};
  if (process.env.WS_HEARTBEAT_INTERVAL) envOverrides.ws.heartbeatInterval = parseInt(process.env.WS_HEARTBEAT_INTERVAL, 10);
  if (process.env.WS_HEARTBEAT_TIMEOUT) envOverrides.ws.heartbeatTimeout = parseInt(process.env.WS_HEARTBEAT_TIMEOUT, 10);
}

if (process.env.ENCRYPTION_ALGORITHM) {
  envOverrides.encryption = { algorithm: process.env.ENCRYPTION_ALGORITHM };
}

// Final config: envConfig (base) ← envOverrides (highest priority)
const config = Object.keys(envOverrides).length > 0 ? deepMerge(envConfig, envOverrides) : envConfig;

// Known-insecure placeholder secrets that must never run in production. Covers the
// dev/test config defaults AND the docker-compose dev defaults (`${JWT_SECRET:-...}`),
// all of which are public in the repo. Values are compared, never logged.
const INSECURE_JWT_SECRETS = [
  'clipsync-dev-secret',                     // src/config/development.js
  'clipsync-test-secret',                    // src/config/test.js
  'dev_jwt_secret_change_me_in_production',  // docker-compose.dev.yml + .env.test
];
const INSECURE_ENCRYPTION_KEYS = [
  'default_master_key_32b',                      // src/utils/encryption.js fallback
  'dev_encryption_key_32chars_min!!',            // docker-compose.dev.yml
  'dev_encryption_key_32_bytes_long_1234567890',  // .env.test
];

// Collect security-critical config problems. Messages name the variable and how to fix
// it, but never include any secret value. Non-production only surfaces outright-missing
// credentials (dev/test configs hardcode these, so it stays silent in practice).
function collectConfigIssues(isProduction) {
  const issues = [];

  const jwtSecret = config.jwt && config.jwt.secret;
  if (!jwtSecret) {
    issues.push('JWT_SECRET is required — set a unique signing secret of at least 32 characters');
  } else if (isProduction && INSECURE_JWT_SECRETS.includes(jwtSecret)) {
    issues.push('JWT_SECRET is a known dev/default value — set a unique production secret (>=32 chars)');
  }

  if (!config.db || !config.db.password) {
    issues.push('DB_PASSWORD is required — set the database password');
  }

  if (isProduction) {
    if (!config.redis || !config.redis.password) {
      issues.push('REDIS_PASSWORD is required — set the production Redis password');
    }

    const encryptionKey = process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY;
    if (!encryptionKey) {
      issues.push('ENCRYPTION_KEY is required — set a unique key of at least 32 characters');
    } else if (INSECURE_ENCRYPTION_KEYS.includes(encryptionKey)) {
      issues.push('ENCRYPTION_KEY is a known dev/default value — set a unique production key (>=32 chars)');
    } else if (encryptionKey.length < 32) {
      issues.push('ENCRYPTION_KEY must be at least 32 characters in production');
    }

    if (!config.cors || !config.cors.origins || config.cors.origins === '*') {
      issues.push('CORS_ORIGINS must be an explicit comma-separated whitelist in production (not empty, not "*")');
    }
  }

  return issues;
}

// Production fails fast on any security-critical gap; other environments only warn so
// local development and the test suite are never blocked.
if (nodeEnv === 'production') {
  const issues = collectConfigIssues(true);
  if (issues.length > 0) {
    /* eslint-disable no-console */
    console.error('❌ Production configuration validation failed — refusing to start:');
    issues.forEach(i => console.error(`  - ${i}`));
    console.error('Set the above via environment variables / .env.production, then restart the service.');
    /* eslint-enable no-console */
    throw new Error(`Production configuration invalid: ${issues.length} security-critical issue(s); refusing to start`);
  }
} else {
  const issues = collectConfigIssues(false);
  if (issues.length > 0) {
    /* eslint-disable no-console */
    console.warn(`⚠️  Configuration warnings (${nodeEnv}):`);
    issues.forEach(i => console.warn(`  - ${i}`));
    /* eslint-enable no-console */
  }
}

// 默认 JSON / urlencoded body 解析上限（P1 修复：原 50mb 单请求可吃光内存）
// 文件上传走 multer（diskStorage），不经由 express.json，故不受此限制。
if (!config.jsonBodyLimit) {
  config.jsonBodyLimit = process.env.JSON_BODY_LIMIT || '10mb';
}

export default config;

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

if (process.env.DB_HOST || process.env.DB_PORT || process.env.DB_NAME || process.env.DB_USER || process.env.DB_PASSWORD) {
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

// Validate critical production settings
if (nodeEnv === 'production') {
  const warnings = [];
  if (!config.jwt.secret || config.jwt.secret === 'clipsync-dev-secret') {
    warnings.push('JWT_SECRET must be set in production (not using dev default)');
  }
  if (!config.db.password) {
    warnings.push('DB_PASSWORD must be set in production');
  }
  if (!config.redis || !config.redis.password) {
    warnings.push('REDIS_PASSWORD should be set in production');
  }
  if (!config.cors || !config.cors.origins || config.cors.origins === '*') {
    warnings.push('CORS_ORIGINS must be explicitly whitelisted in production');
  }
  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  Production configuration warnings:');
    // eslint-disable-next-line no-console
    warnings.forEach(w => console.warn(`  - ${w}`));
  }
}

export default config;

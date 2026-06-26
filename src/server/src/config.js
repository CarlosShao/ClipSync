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
const envOverrides = {
  port: parseInt(process.env.PORT || '', 10) || undefined,
  host: process.env.HOST || undefined,
  logLevel: process.env.LOG_LEVEL || undefined,
  db: {
    host: process.env.DB_HOST || undefined,
    port: parseInt(process.env.DB_PORT || '', 10) || undefined,
    name: process.env.DB_NAME || undefined,
    user: process.env.DB_USER || undefined,
    password: process.env.DB_PASSWORD || undefined,
  },
  redis: {
    host: process.env.REDIS_HOST || undefined,
    port: parseInt(process.env.REDIS_PORT || '', 10) || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwt: {
    secret: process.env.JWT_SECRET || undefined,
    expiresIn: process.env.JWT_EXPIRES_IN || undefined,
  },
  cors: {
    origins: process.env.CORS_ORIGINS || undefined,
  },
  ws: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '', 10) || undefined,
    heartbeatTimeout: parseInt(process.env.WS_HEARTBEAT_TIMEOUT || '', 10) || undefined,
  },
  encryption: {
    algorithm: process.env.ENCRYPTION_ALGORITHM || undefined,
  },
};

// Final config: envConfig (base) ← envOverrides (highest priority)
const config = deepMerge(envConfig, envOverrides);

// Validate critical production settings
if (nodeEnv === 'production') {
  const warnings = [];
  if (!config.jwt.secret || config.jwt.secret === 'clipsync-dev-secret') {
    warnings.push('JWT_SECRET must be set in production (not using dev default)');
  }
  if (!config.db.password) {
    warnings.push('DB_PASSWORD must be set in production');
  }
  if (!config.redis.password) {
    warnings.push('REDIS_PASSWORD should be set in production');
  }
  if (config.cors.origins === '*' || !config.cors.origins) {
    warnings.push('CORS_ORIGINS must be explicitly whitelisted in production');
  }
  if (warnings.length > 0) {
    console.warn('⚠️  Production configuration warnings:');
    warnings.forEach(w => console.warn(`  - ${w}`));
  }
}

export default config;

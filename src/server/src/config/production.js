// Production environment configuration
// All sensitive values should come from environment variables (.env.production)
// This file only provides defaults and production-specific overrides

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: 'production',
  logLevel: process.env.LOG_LEVEL || 'info',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'clipsync',
    user: process.env.DB_USER || 'clipsync_app',
    password: process.env.DB_PASSWORD, // NO default - must be set in .env.production
    poolMin: 5,
    poolMax: 20,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD, // NO default - must be set
  },

  jwt: {
    secret: process.env.JWT_SECRET, // NO default - must be set
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  cors: {
    origins: process.env.CORS_ORIGINS || '', // Must whitelist specific origins
  },

  ws: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000', 10),
    heartbeatTimeout: parseInt(process.env.WS_HEARTBEAT_TIMEOUT || '5000', 10),
  },

  rateLimit: {
    api: { windowMs: 15 * 60 * 1000, max: 100 },
    sendCode: { windowMs: 60 * 60 * 1000, max: 5 },
    loginFailed: { windowMs: 15 * 60 * 1000, max: 5 },
  },

  encryption: {
    algorithm: process.env.ENCRYPTION_ALGORITHM || 'aes-256-gcm',
  },

  upload: {
    maxImageSize: 20 * 1024 * 1024,
    maxFileSize: 50 * 1024 * 1024,
  },
};

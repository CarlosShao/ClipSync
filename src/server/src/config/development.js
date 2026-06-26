// Development environment configuration
// Overrides base config for local development

export default {
  port: 3000,
  host: '0.0.0.0',
  nodeEnv: 'development',
  logLevel: 'debug',

  db: {
    host: 'localhost',
    port: 5433,
    name: 'clipsync_dev',
    user: 'clipsync',
    password: 'dev_password_change_me',
    poolMin: 2,
    poolMax: 10,
  },

  redis: {
    host: 'localhost',
    port: 6380,
    password: undefined,
  },

  jwt: {
    secret: 'clipsync-dev-secret',
    expiresIn: '7d',
  },

  cors: {
    origins: '*',
  },

  ws: {
    heartbeatInterval: 30000,
    heartbeatTimeout: 5000,
  },

  rateLimit: {
    api: { windowMs: 15 * 60 * 1000, max: 200 },
    sendCode: { windowMs: 60 * 60 * 1000, max: 10 },
    loginFailed: { windowMs: 15 * 60 * 1000, max: 20 },
  },

  encryption: {
    algorithm: 'aes-256-gcm',
  },

  upload: {
    maxImageSize: 20 * 1024 * 1024,
    maxFileSize: 50 * 1024 * 1024,
  },
};

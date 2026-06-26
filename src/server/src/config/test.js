// Test environment configuration
// Used for automated testing (vitest, e2e tests)

export default {
  port: 3001, // Different port to avoid conflict with dev server
  host: '0.0.0.0',
  nodeEnv: 'test',
  logLevel: 'warn', // Less verbose during tests

  db: {
    host: 'localhost',
    port: 5433,
    name: 'clipsync_test',
    user: 'clipsync',
    password: 'dev_password_change_me',
    poolMin: 1,
    poolMax: 5,
  },

  redis: {
    host: 'localhost',
    port: 6380, // Different Redis port for test isolation
    password: 'dev_redis_password',
  },

  jwt: {
    secret: 'clipsync-test-secret',
    expiresIn: '1h',
  },

  cors: {
    origins: '*',
  },

  ws: {
    heartbeatInterval: 5000, // Faster for test speed
    heartbeatTimeout: 2000,
  },

  rateLimit: {
    api: { windowMs: 15 * 60 * 1000, max: 500 }, // More lenient for tests
    sendCode: { windowMs: 60 * 60 * 1000, max: 50 },
    loginFailed: { windowMs: 15 * 60 * 1000, max: 50 },
  },

  encryption: {
    algorithm: 'aes-256-gcm',
  },

  upload: {
    maxImageSize: 20 * 1024 * 1024,
    maxFileSize: 50 * 1024 * 1024,
  },
};

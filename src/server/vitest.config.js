import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // 强制顺序执行，避免并行导致数据库干扰
    pool: 'threads',
    minThreads: 1,
    maxThreads: 1,
    // 在模块加载前设置 NODE_ENV=test，确保 index.js 中的监听守卫生效
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
      ],
    },
    setupFiles: ['tests/setup.js'],
  },
});
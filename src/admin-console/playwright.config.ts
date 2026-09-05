import { defineConfig } from '@playwright/test';

// E2E 冒烟配置：默认以 MSW 模式启动 dev server（npm run dev 即开启 MSW）
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5273',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

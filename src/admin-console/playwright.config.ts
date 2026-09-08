import { defineConfig } from '@playwright/test';

// E2E 冒烟配置：默认以 MSW 模式启动 dev server（npm run dev 即开启 MSW）
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // 写操作（设置页保存/开关切换）串行执行，避免用例间开关状态互相污染
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5273',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    launchOptions: {
      // 本机已安装 chromium-1234（npx playwright --version = 1.63），免 npx playwright install
      executablePath:
        'C:\\Users\\swq\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

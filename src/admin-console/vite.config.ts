/// <reference types="vitest/config" />
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 联调时可经 .env.development.local 覆盖：VITE_PROXY_TARGET=http://localhost:3003
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), stripMswWorkerFromBuild()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5273,
      // 双栈监听：vite 默认只绑 ::1，桌面端 SSO 外链拼的是 127.0.0.1:5273（IPv4）会连接拒绝
      host: true,
      proxy: {
        // 后端 admin API（dev 环境默认 3001）；MSW 开启时请求不会到达 proxy
        '/api': {
          // ⚠️ 127.0.0.1 而非 localhost：wslrelay 抢占 [::1]:3001，localhost 会挂起
          target: env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});

/**
 * 生产构建必须剔除 MSW 的 Service Worker 脚本。
 *
 * `public/mockServiceWorker.js` 会被 Vite **原样复制**到 dist（它在 public/ 下，
 * 不进 JS 打包管线），因此 `VITE_ENABLE_MSW=false` 只能阻止 MSW **启动**
 * （main.tsx 的 `!import.meta.env.DEV` 提前 return），拦不住这个文件被发布。
 *
 * 后果：生产站点根目录会存在 `/mockServiceWorker.js`，一旦被访问/被扫描到，
 * 既像「管理台带假数据」的痕迹，也是无谓的对外暴露。此前靠部署脚本手工
 * `rm -f` 兜底，漏一步就复发——改为在构建期自动删除，从根上消除。
 */
function stripMswWorkerFromBuild() {
  return {
    name: 'clipsync-strip-msw-worker',
    apply: 'build' as const,
    closeBundle() {
      rmSync(new URL('./dist/mockServiceWorker.js', import.meta.url), { force: true });
    },
  };
}

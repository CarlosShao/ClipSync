/// <reference types="vitest/config" />
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 联调时可经 .env.development.local 覆盖：VITE_PROXY_TARGET=http://localhost:3003
  // 本地 dev 直连生产后端：
  //   VITE_PROXY_TARGET=https://api.clipchain.top
  //   VITE_PROXY_ORIGIN=https://admin.clipchain.top
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001';
  const proxyOrigin = env.VITE_PROXY_ORIGIN || '';
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
          target: proxyTarget,
          changeOrigin: true,
          // 上游按 Origin 白名单放行（生产 CORS_ORIGINS 里是前端域名，不含 api 自己）。
          // 浏览器发出的 Origin 是 http://localhost:5273，直连生产会被判非法源 403 ——
          // 登录接口不带 Bearer，走的正是这条检查。设了 VITE_PROXY_ORIGIN 就把转发的
          // Origin 换成它（等价于「部署版管理台在调它」），这样本地 dev 能直连联调/生产
          // 后端，而不必把 localhost 加进生产白名单。不设则完全不重写，本地后端照旧。
          // 用 proxyReq 钩子而非 http-proxy 的 headers 选项：后者在 web 代理路径上不生效。
          ...(proxyOrigin
            ? {
                configure(proxy) {
                  proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', proxyOrigin));
                },
              }
            : {}),
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

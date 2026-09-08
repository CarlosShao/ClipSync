/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 联调时可经 .env.development.local 覆盖：VITE_PROXY_TARGET=http://localhost:3003
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
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

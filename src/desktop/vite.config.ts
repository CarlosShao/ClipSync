import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 监听所有 IPv4 接口（0.0.0.0），否则 Vite 在部分环境下只绑定 IPv6 ::1，
    // 而浏览器/WebView2 解析 localhost 走 IPv4 127.0.0.1，会连不上 → 黑屏/转圈。
    host: host || true,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // 后端重启窗口期（hy4/部署）proxy 会刷 socket hang up 错误——
        // 降噪：仅打印一行简短提示，不打全堆栈
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('backend temporarily unavailable');
            } else {
              console.warn('[proxy] backend unreachable:', err.code);
            }
          });
        },
      },
      '/ws': {
        target: 'http://localhost:3001',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', () => {
            console.warn('[proxy] ws connection dropped (backend restarting?)');
          });
        },
      },
    },
  },
})

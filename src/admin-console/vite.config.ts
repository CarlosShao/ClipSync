/// <reference types="vitest/config" />
import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/** 与 src/api/upstream.ts 的 UPSTREAM_HEADER 一致（配置文件不方便 import 应用源码，改一处要改两处） */
const UPSTREAM_HEADER = 'x-clipsync-upstream';

/** 运行时地址只接受纯 origin：挡掉路径/查询/凭据，避免 dev server 被当通用跳板 */
const ORIGIN_ONLY = /^https?:\/\/[^\s/?#@]+$/i;

/**
 * 后端 CORS 白名单登记的是**前端**源，所以转发时的 Origin 必须是它认得的那一个。
 * 新增联调环境就在下面补一行（生产 api 只认部署版管理台这个源）。
 */
const UPSTREAM_FRONTEND_ORIGIN: Record<string, string> = {
  'https://api.clipchain.top': 'https://admin.clipchain.top',
};

/** http-proxy 会把 target 解析成对象，这里统一还原成 origin 字符串再查表 */
function targetOrigin(target: unknown): string {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return '';
  const t = target as { protocol?: string; host?: string; hostname?: string; port?: string };
  const host = t.host || (t.hostname ? `${t.hostname}${t.port ? `:${t.port}` : ''}` : '');
  if (!t.protocol || !host) return '';
  return `${t.protocol.replace(/\/?$/, '//')}${host}`;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 默认转发目标；联调时优先用页面上的「联调后端」面板（免改文件、免重启）。
  // 这两个 env 仍保留，作为 CI/无面板场景的兜底：
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
          // 请求**必须**继续走同源 /api：浏览器的 Origin 头脚本改不了，直连生产必被 CORS 拒。
          // 所以「换后端」只能在 dev server 上做——页面带 X-ClipSync-Upstream 头，这里按头
          // 改转发目标，并在 proxyReq 上把 Origin 换成目标后端认得的前端源。
          // 只有 dev server 有这段逻辑：线上是 nginx 反代，不存在改指向的入口。
          // 残余风险：server.host=true 时同网段可向本 dev server 发这个头当跳板——
          // 故地址形态先过 ORIGIN_ONLY，且每次改写都打日志。
          configure(proxy) {
            const send = proxy.web.bind(proxy);
            const announced = new Set<string>();
            proxy.web = (
              req: IncomingMessage,
              res: ServerResponse,
              options?: Parameters<typeof send>[2]
            ) => {
              const raw = Array.isArray(req.headers[UPSTREAM_HEADER])
                ? req.headers[UPSTREAM_HEADER]?.[0]
                : req.headers[UPSTREAM_HEADER];
              const upstream = raw && ORIGIN_ONLY.test(raw.trim()) ? raw.trim() : '';
              if (!upstream) return send(req, res, options);
              if (!announced.has(upstream)) {
                announced.add(upstream);
                console.warn(`[proxy] /api 转发目标改为运行时指定地址：${upstream}`);
              }
              return send(req, res, { ...options, target: upstream });
            };
            proxy.on('proxyReq', (proxyReq, _req, _res, options) => {
              const origin =
                UPSTREAM_FRONTEND_ORIGIN[targetOrigin(options?.target)] ?? (proxyOrigin || '');
              // 查不到映射的（本地后端等）不重写：它们本来就接受任意源
              if (origin) proxyReq.setHeader('origin', origin);
            });
          },
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

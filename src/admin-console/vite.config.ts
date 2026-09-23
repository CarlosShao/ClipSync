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
 * 生产域名（含子域）：dev proxy 绝不允许把本地页面接到生产后端，也绝不为它重写 Origin。
 * S0：一个 `?api=<生产>` 的链接此前就能让本地页面对生产下真实指令（含退款打款），
 * 因为 proxy 会把 Origin 改成生产 CORS 白名单认得的部署版管理台源。这里从根上拒绝。
 */
const PRODUCTION_HOSTS = ['clipchain.top'];

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

function isProductionOrigin(origin: string): boolean {
  const h = hostOf(origin);
  if (!h) return false;
  return PRODUCTION_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

/**
 * 运行时 header 通道（X-ClipSync-Upstream）目标白名单：仅本地/环回联调地址。
 * 不在名单内一律拒绝——含生产、内网(10./192.168./172.16-31.)、链路本地(169.254. 云元数据)、
 * 任意公网主机，堵死「dev server(host:true) 被同网段当无鉴权 SSRF 跳板」。
 * 新增联调环境：设 VITE_PROXY_UPSTREAM_ALLOWLIST（逗号分隔 origin）。生产域名即使登记也拒绝。
 */
const DEFAULT_RUNTIME_ALLOWLIST = ['http://127.0.0.1:3001', 'http://localhost:3001'];

/** header 通道仅限本机客户端使用：同网段主机即便猜到 header 也不能借道转发 */
function isLoopbackClient(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress || '';
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/**
 * 后端 CORS 白名单登记的是**前端**源，所以转发时的 Origin 必须是它认得的那一个。
 * ⚠️ 生产映射已删除：dev 绝不为生产目标重写 Origin（拿不到生产 CORS 放行身份）。
 * 仅在下面登记**非生产**联调环境（target origin → 该环境认得的前端源）。
 */
const UPSTREAM_FRONTEND_ORIGIN: Record<string, string> = {
  // 例：'https://staging-api.example.com': 'https://staging-admin.example.com',
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
  //   VITE_PROXY_TARGET=http://127.0.0.1:3001
  //   VITE_PROXY_ORIGIN=（仅非生产联调环境需要）
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001';
  const proxyOrigin = env.VITE_PROXY_ORIGIN || '';

  // env 默认目标可以是生产——但它只可能来自操作者自己写的、未入库的 .env.*.local，
  // 那是本人意图，不是攻击面（仓库/镜像/compose 里没有任何一处设置它）。被拦的是
  // 「别人发一条链接或塞一个请求头就能把这台机器指到生产」，那三条通道（?api=、
  // X-ClipSync-Upstream、localStorage）在上面和 upstream.ts 里仍然硬拒生产，与本开关无关。
  // 之所以仍要一个显式开关：这条 env 一旦成立，本机 dev server 就成了「带生产可信
  // Origin 的转发器」，同网段任何人都能借道——所以批准的同时把监听收成仅环回。
  const allowProdTarget = env.VITE_ALLOW_PROD_TARGET_IN_DEV === 'true';
  const prodTarget = isProductionOrigin(proxyTarget);

  if (prodTarget && !allowProdTarget) {
    throw new Error(
      `[vite] VITE_PROXY_TARGET 指向生产域名（${proxyTarget}），需本人显式确认后才允许启动。\n` +
        `  · 确实要拿本地管理台连生产联调：在同目录 .env.development.local 追加一行\n` +
        `      VITE_ALLOW_PROD_TARGET_IN_DEV=true\n` +
        `    （追加后本 dev server 只监听 127.0.0.1，且运行时改地址的通道仍不含生产）\n` +
        `  · 只是要一个联调后端：改成 http://127.0.0.1:3001 之类的地址\n` +
        `  · 要长期操作生产：用部署版管理台，别用本地 dev`
    );
  }
  // 指向生产时 Origin 必须保留：它是生产侧 CSRF/Origin 校验认得的那个源，抹掉就打不开。
  // 目标不是生产时，仍不得给转发请求盖上生产 CORS 放行身份。
  const safeProxyOrigin = prodTarget
    ? proxyOrigin
    : isProductionOrigin(proxyOrigin)
      ? ''
      : proxyOrigin;

  if (prodTarget) {
    console.warn(
      `[vite] ⚠ 本地 dev 管理台正在直连**生产**后端（${proxyTarget}）：页面上的每一次退款/改配置/发通知都是真实操作。\n` +
        `[vite] ⚠ 已自动把监听收紧为 127.0.0.1（不再对同网段开放）；?api= 与「联调后端」面板仍不接受生产地址。`
    );
  }

  // 运行时 header 通道白名单（默认环回 + env 追加）；生产域名即使被追加也剔除
  const runtimeAllowlist = new Set(
    [
      ...DEFAULT_RUNTIME_ALLOWLIST,
      ...(env.VITE_PROXY_UPSTREAM_ALLOWLIST || '')
        .split(',')
        .map((s) => normalizeOrigin(s))
        .filter(Boolean),
    ]
      .map(normalizeOrigin)
      .filter((o) => o && !isProductionOrigin(o))
  );

  return {
    plugins: [react(), stripMswWorkerFromBuild()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5273,
      // 双栈监听：vite 默认只绑 ::1，桌面端 SSO 外链拼的是 127.0.0.1:5273（IPv4）会连接拒绝。
      // 但 env 目标一旦是生产，这台 dev server 就成了带生产可信 Origin 的转发器，必须只留环回。
      host: prodTarget ? '127.0.0.1' : true,
      proxy: {
        // 后端 admin API（dev 环境默认 3001）；MSW 开启时请求不会到达 proxy
        '/api': {
          // ⚠️ 127.0.0.1 而非 localhost：wslrelay 抢占 [::1]:3001，localhost 会挂起
          target: proxyTarget,
          changeOrigin: true,
          // 请求**必须**继续走同源 /api：浏览器的 Origin 头脚本改不了，直连生产必被 CORS 拒。
          // 所以「换后端」只能在 dev server 上做——页面带 X-ClipSync-Upstream 头，这里按头
          // 改转发目标。但 header 通道受严格约束（S0 修复）：
          //   1) 仅本机（环回）客户端可用；2) 目标必须在白名单内；3) 生产/内网/链路本地一律 403 拒绝。
          // 且绝不为非白名单/生产目标重写 Origin。线上是 nginx 反代，不存在改指向的入口。
          configure(proxy) {
            const send = proxy.web.bind(proxy);
            const announced = new Set<string>();
            const deny = (res: ServerResponse, upstream: string, reason: string) => {
              const key = `deny:${reason}:${upstream}`;
              if (!announced.has(key)) {
                announced.add(key);
                console.warn(`[proxy] 拒绝运行时转发到 ${upstream}（${reason}）`);
              }
              if (!res.headersSent) {
                res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(
                  JSON.stringify({
                    code: 403,
                    message: `dev proxy 拒绝转发到该地址（${reason}）：仅允许本机客户端指向白名单内的本地/联调后端`,
                  })
                );
              }
            };
            proxy.web = (
              req: IncomingMessage,
              res: ServerResponse,
              options?: Parameters<typeof send>[2]
            ) => {
              const raw = Array.isArray(req.headers[UPSTREAM_HEADER])
                ? req.headers[UPSTREAM_HEADER]?.[0]
                : req.headers[UPSTREAM_HEADER];
              const upstream = raw && ORIGIN_ONLY.test(raw.trim()) ? raw.trim() : '';
              // 无 header：走 env 默认 target（已在上面拒绝生产）
              if (!upstream) return send(req, res, options);
              // header 通道仅限本机客户端
              if (!isLoopbackClient(req)) return deny(res, upstream, '非本机客户端');
              const norm = normalizeOrigin(upstream);
              // 生产域名硬拒绝；非白名单（含内网/链路本地/公网）硬拒绝
              if (isProductionOrigin(upstream)) return deny(res, upstream, '生产域名');
              if (!runtimeAllowlist.has(norm)) return deny(res, upstream, '非白名单地址');
              if (!announced.has(norm)) {
                announced.add(norm);
                console.warn(`[proxy] /api 转发目标改为运行时指定地址：${upstream}`);
              }
              return send(req, res, { ...options, target: upstream });
            };
            proxy.on('proxyReq', (proxyReq, _req, _res, options) => {
              const target = targetOrigin(options?.target);
              if (!target) return;
              // 走到这里的生产目标只可能来自本人 env 里显式批准的默认地址——运行时 header 通道
              // 已在上面把生产 403 掉。此时 Origin 必须换成生产侧 Origin/CSRF 校验认得的那个源，
              // 否则本地管理台连生产时所有写操作都打不通（这条路径第三方走不到）。
              if (isProductionOrigin(target)) {
                if (prodTarget && proxyOrigin) proxyReq.setHeader('origin', proxyOrigin);
                return;
              }
              const origin =
                UPSTREAM_FRONTEND_ORIGIN[normalizeOrigin(target)] || safeProxyOrigin || '';
              // 查不到映射的（本地后端等）不重写：它们本来就接受任意源
              if (origin && !isProductionOrigin(origin)) proxyReq.setHeader('origin', origin);
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

/**
 * 联调后端地址的运行时入口（仅 dev 构建存在）。
 *
 * 为什么需要它：管理台 dev server 的 `/api` 由 vite proxy 转发，转发目标此前只能写在
 * `.env.development.local` 里——改一次要重启、还要在三个项目各配一份。桌面端早就有
 * 「设置 → 服务器地址」这唯一入口，所以这里把它读进来的地址当作唯一真相源：
 * 桌面端打开管理台时用 `?api=` 带上，或在本面板里直接填一次，落 localStorage 即刻生效。
 *
 * 生效路径：请求仍走同源 `/api`（浏览器无法伪造 Origin，直连生产必被 CORS 拒），
 * 只多带一个 `X-ClipSync-Upstream` 头，由 vite proxy 按头改写转发目标 + Origin。
 *
 * 生产构建 `import.meta.env.DEV === false` → 本模块所有对外函数退化为空操作，
 * 面板不进 bundle，请求也不带头：线上页面不可能被改指向别的后端。
 */

const STORAGE_KEY = 'clipsync.admin.upstream';

export const UPSTREAM_HEADER = 'X-ClipSync-Upstream';

/** 入口是否可见/可用：只有 dev 构建允许改后端地址 */
export const upstreamEditable = import.meta.env.DEV;

/** 只接受纯源地址（协议+主机+端口）：带路径/查询/凭据的一律拒——转发目标只能是 origin */
const ORIGIN_ONLY = /^https?:\/\/[^\s/?#@]+$/i;

/**
 * 生产域名（含子域）：本地 dev 页面绝不允许被静默指向生产后端（S0）。
 * 与 vite.config.ts 的 PRODUCTION_HOSTS 同源；两处都要改。
 */
const PRODUCTION_HOSTS = ['clipchain.top'];

export function isProductionOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return PRODUCTION_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
  } catch {
    return false;
  }
}

export function normalizeUpstream(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!ORIGIN_ONLY.test(value)) {
    throw new Error('请填写 http(s)://主机[:端口] 形式的后端地址，不要带路径');
  }
  if (isProductionOrigin(value)) {
    throw new Error('已拒绝：本地 dev 页面不允许指向生产后端，请用部署版管理台操作生产');
  }
  return value;
}

export function getUpstream(): string {
  if (!upstreamEditable || typeof localStorage === 'undefined') return '';
  const value = (localStorage.getItem(STORAGE_KEY) || '').trim();
  // 历史遗留：本修复之前落盘的生产地址直接作废，防止旧 localStorage 继续把请求指向生产
  if (value && isProductionOrigin(value)) {
    localStorage.removeItem(STORAGE_KEY);
    return '';
  }
  return value;
}

/** 保存后由调用方触发整页重载：鉴权态、react-query 缓存都属于上一个后端 */
export function setUpstream(raw: string): string {
  const value = normalizeUpstream(raw);
  localStorage.setItem(STORAGE_KEY, value);
  return value;
}

export function clearUpstream(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/** 附加到每个 `/api` 请求上的头；未指定或生产构建返回 {} */
export function upstreamHeaders(): Record<string, string> {
  const value = getUpstream();
  return value ? { [UPSTREAM_HEADER]: value } : {};
}

/**
 * vite proxy 的默认目标（无运行时覆盖时 `/api` 真正去哪）。
 *
 * 面板过去只渲染「默认（vite proxy）」这个**字面量**，把真正的默认目标藏起来了；而默认
 * 目标可以来自 `.env.development.local`（本机就指向生产）。于是「以为在连 dev、其实在连
 * 生产」这种误判无法从界面上排除——这正是 2026-10-05 发生的事。所以默认目标必须显示出来。
 *
 * 取值来源说明（别改成 define：**Vite 的 define 在 dev 下不生效**）：
 * `vite.config.ts` 里 `server.proxy['/api'].target` 取 `env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001'`，
 * 而 `VITE_PROXY_TARGET` 是 VITE_ 前缀变量，dev 下本来就会注入 `import.meta.env`
 *（已实测：transformed 模块里 `import.meta.env` 含该值）。见 vite 源码 `vite:define` 插件：
 * `if (environment.config.consumer === 'client' && !isBuild) return` —— dev 完全不替换用户 define。
 *
 * 未显式配置时返回空串：此时 proxy 用的是 vite.config.ts 内置的 `http://127.0.0.1:3001`，
 * **不可能是生产**，故安全上无需精确显示（面板会注明「未显式配置」）。
 * 唯一有安全含义的情形——默认目标被指到生产——必然是显式配置的，一定取得到值。
 *
 * 生产构建恒返回空串：面板不进 bundle，线上页面没有改指向的入口。
 */
export function devDefaultProxyTarget(): string {
  if (!upstreamEditable) return '';
  // as unknown：ImportMetaEnv 是索引签名（any），直接赋值会触发 no-unsafe-assignment
  const raw = import.meta.env.VITE_PROXY_TARGET as unknown;
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

export type UpstreamSource = 'runtime' | 'default';

export type UpstreamView = {
  /** localStorage 里的运行时覆盖；空串表示没有覆盖 */
  runtime: string;
  /** `/api` 实际会打到的地址（覆盖优先，其次 vite proxy 默认目标） */
  effective: string;
  /** 生效目标是否为生产：面板据此决定要不要红字告警 */
  isProduction: boolean;
  /** 生效来源：本面板填的，还是 vite proxy 默认 */
  source: UpstreamSource;
};

/**
 * 面板展示用的唯一解析口。
 * 抽成纯函数是为了能直接给定 target 断言，不必依赖构建期注入或真实 env。
 */
export function resolveUpstreamView(runtime: string, defaultTarget: string): UpstreamView {
  const effective = runtime || defaultTarget;
  return {
    runtime,
    effective,
    isProduction: effective ? isProductionOrigin(effective) : false,
    source: runtime ? 'runtime' : 'default',
  };
}

/** 当前页面真正生效的转发目标 */
export function currentUpstreamView(): UpstreamView {
  return resolveUpstreamView(getUpstream(), devDefaultProxyTarget());
}

/**
 * dev 下 MSW 是否会吃掉 `/api`（此时后端地址填了也不生效）。
 * 判定只此一份：面板显示的「假数据 / 真实后端」必须和 main.tsx 的启动条件同源，
 * 否则会出现面板说直连、请求却是假数据的错觉。
 */
export function mockInterceptsApi(): boolean {
  return upstreamEditable && import.meta.env.VITE_ENABLE_MSW !== 'false' && !getUpstream();
}

/**
 * 接收桌面端随链接带进来的 `?api=`（桌面端「服务器地址」是跨项目的唯一入口）。
 * 先校验再接管：生产/非法地址一律拒绝且**保留地址栏参数**，让运营者看得见
 * 「这条链接想把控制台指到哪里」——此前的静默接管+抹参数正是 S0 的入口。
 * 合法地址读完即从地址栏抹掉，避免刷新重复覆盖用户之后在面板里改的值。
 */
export function adoptUpstreamFromQuery(): void {
  if (!upstreamEditable || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('api');
  if (!raw) return;
  let next: string;
  try {
    next = normalizeUpstream(raw);
  } catch {
    console.warn('[upstream] 已拒绝 ?api= 指向的地址（生产或非法）：', raw);
    return;
  }
  url.searchParams.delete('api');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  const previous = getUpstream();
  localStorage.setItem(STORAGE_KEY, next);
  // 换了后端必须整页重载：登录态与 react-query 缓存都是上一个后端的
  if (next !== previous) window.location.reload();
}

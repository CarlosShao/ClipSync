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

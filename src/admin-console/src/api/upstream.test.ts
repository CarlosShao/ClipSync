import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPSTREAM_HEADER,
  adoptUpstreamFromQuery,
  clearUpstream,
  devDefaultProxyTarget,
  getUpstream,
  mockInterceptsApi,
  normalizeUpstream,
  resolveUpstreamView,
  setUpstream,
  upstreamHeaders,
} from './upstream';

/**
 * 「共用一个后端入口」的运行时状态回归。
 *
 * 这块逻辑的失败模式都很安静：地址没存上 → 页面一直偷偷连本地；MSW 判定漂移 →
 * 面板写着「直连」而数据全是假的；?api= 解析漂了 → 桌面端交出来的地址被丢掉。
 * 所以逐条钉死，尤其是 MSW 让路这一条（它和 main.tsx 共用同一个函数）。
 */

const KEY = 'clipsync.admin.upstream';

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('normalizeUpstream', () => {
  it('去掉尾斜杠，保留纯 origin', () => {
    expect(normalizeUpstream('  https://staging-api.example.com/  ')).toBe(
      'https://staging-api.example.com'
    );
    expect(normalizeUpstream('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
  });

  it('拒绝带路径/凭据/非 http 的地址（转发目标只能是 origin）', () => {
    for (const bad of [
      '',
      'https://staging-api.example.com/api',
      'ftp://h',
      'localhost:3001',
      'https://u:p@h',
      'https://a b',
    ]) {
      expect(() => normalizeUpstream(bad), bad).toThrow();
    }
  });

  it('S0：拒绝生产域名（含子域），本地 dev 页面不得被指向生产后端', () => {
    for (const prod of [
      'https://api.clipchain.top',
      'https://admin.clipchain.top',
      'https://clipchain.top',
      'http://api.clipchain.top:443',
    ]) {
      expect(() => normalizeUpstream(prod), prod).toThrow(/生产/);
    }
    // 形似但非生产的域名不误伤
    expect(normalizeUpstream('https://api.clipchain.top.example.com')).toBe(
      'https://api.clipchain.top.example.com'
    );
  });
});

describe('运行时后端地址', () => {
  it('未指定时不发上游头，也不关掉 MSW', () => {
    expect(getUpstream()).toBe('');
    expect(upstreamHeaders()).toEqual({});
    expect(mockInterceptsApi()).toBe(true);
  });

  it('指定之后：每个请求带 X-ClipSync-Upstream，MSW 让路', () => {
    setUpstream('https://staging-api.example.com');
    expect(upstreamHeaders()).toEqual({
      [UPSTREAM_HEADER]: 'https://staging-api.example.com',
    });
    expect(mockInterceptsApi()).toBe(false);
  });

  it('恢复默认后回到假数据模式', () => {
    setUpstream('http://127.0.0.1:3001');
    clearUpstream();
    expect(getUpstream()).toBe('');
    expect(mockInterceptsApi()).toBe(true);
  });

  it('S0：历史遗留的生产地址落盘值直接作废（getUpstream 清除并返回空）', () => {
    stubStorage({ [KEY]: 'https://api.clipchain.top' });
    expect(getUpstream()).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(upstreamHeaders()).toEqual({});
  });
});

describe('adoptUpstreamFromQuery（桌面端 ?api= 交接）', () => {
  function stubWindow(href: string) {
    const calls: string[] = [];
    vi.stubGlobal('window', {
      location: {
        href,
        reload: () => void calls.push('reload'),
      },
      history: {
        replaceState: (_s: unknown, _t: string, url: string) => void calls.push(`replace:${url}`),
      },
    });
    return calls;
  }

  it('存下地址、抹掉参数并整页重载（换后端后旧登录态必须作废）', () => {
    const calls = stubWindow(
      'http://localhost:5273/sso?code=abc&api=https%3A%2F%2Fstaging-api.example.com'
    );
    adoptUpstreamFromQuery();
    expect(getUpstream()).toBe('https://staging-api.example.com');
    expect(calls).toEqual(['replace:/sso?code=abc', 'reload']);
  });

  it('地址没变就不重载，避免和桌面端每次点开都打一次白闪', () => {
    stubStorage({ [KEY]: 'https://staging-api.example.com' });
    const calls = stubWindow('http://localhost:5273/?api=https://staging-api.example.com');
    adoptUpstreamFromQuery();
    expect(calls.filter((c) => c === 'reload')).toEqual([]);
  });

  it('非法地址忽略，保留本地已存值', () => {
    stubStorage({ [KEY]: 'http://127.0.0.1:3001' });
    stubWindow('http://localhost:5273/?api=javascript%3Aalert(1)');
    adoptUpstreamFromQuery();
    expect(getUpstream()).toBe('http://127.0.0.1:3001');
  });

  it('S0：?api=生产地址 被拒绝——不落盘、不重载，且保留地址栏参数让运营者看得见', () => {
    stubStorage({ [KEY]: 'http://127.0.0.1:3001' });
    const calls = stubWindow('http://localhost:5273/sso?code=abc&api=https%3A%2F%2Fapi.clipchain.top');
    adoptUpstreamFromQuery();
    // 本地已存值原样保留，未被生产地址覆盖
    expect(getUpstream()).toBe('http://127.0.0.1:3001');
    // 没有抹参数（地址栏仍能看到 ?api= 指向生产），也没有触发重载
    expect(calls).toEqual([]);
  });

  it('S0：从未存过地址时，?api=生产 同样拒绝且不落盘', () => {
    stubWindow('http://localhost:5273/?api=https%3A%2F%2Fapi.clipchain.top');
    adoptUpstreamFromQuery();
    expect(getUpstream()).toBe('');
    expect(upstreamHeaders()).toEqual({});
  });
});

/**
 * 2026-10-05 事故回归：本机 .env.development.local 把 vite proxy 的**默认目标**指到了生产，
 * 而面板只渲染「默认（vite proxy）」这个字面量，操作者据此判定「管理台连的是 dev」——判反了。
 * 这里钉死：默认目标必须能被算出来并被判为生产，界面才有条件显式告警。
 */
describe('resolveUpstreamView（必须暴露真正生效的目标）', () => {
  it('无运行时覆盖：以 vite proxy 默认目标为准，且生产默认目标被判为生产', () => {
    const view = resolveUpstreamView('', 'https://api.clipchain.top');
    expect(view.effective).toBe('https://api.clipchain.top');
    expect(view.source).toBe('default');
    expect(view.isProduction).toBe(true);
  });

  it('默认目标是本地时不误报生产', () => {
    const view = resolveUpstreamView('', 'http://127.0.0.1:3001');
    expect(view.effective).toBe('http://127.0.0.1:3001');
    expect(view.source).toBe('default');
    expect(view.isProduction).toBe(false);
  });

  it('面板里填过地址就以它为准（覆盖优先级），来源标为 runtime', () => {
    const view = resolveUpstreamView('http://127.0.0.1:3001', 'https://api.clipchain.top');
    expect(view.effective).toBe('http://127.0.0.1:3001');
    expect(view.source).toBe('runtime');
    expect(view.isProduction).toBe(false);
  });

  it('两者都没有时不瞎猜：effective 为空且不报生产', () => {
    const view = resolveUpstreamView('', '');
    expect(view.effective).toBe('');
    expect(view.source).toBe('default');
    expect(view.isProduction).toBe(false);
  });
});

describe('devDefaultProxyTarget（面板默认目标取值口）', () => {
  it('未显式配置时返回空串（此时 proxy 用 vite.config 内置的非生产默认值）', () => {
    vi.stubEnv('VITE_PROXY_TARGET', '');
    expect(devDefaultProxyTarget()).toBe('');
  });

  it('去空格并去掉尾斜杠', () => {
    vi.stubEnv('VITE_PROXY_TARGET', '  http://127.0.0.1:3001/  ');
    expect(devDefaultProxyTarget()).toBe('http://127.0.0.1:3001');
  });

  // 2026-10-05 现场复现：.env.development.local 把默认目标指到生产，
  // 面板必须据此判定「直连生产」，而不是只显示「默认（vite proxy）」。
  it('默认目标为生产时：面板取得到它，并被判定为生产', () => {
    vi.stubEnv('VITE_PROXY_TARGET', 'https://api.clipchain.top');
    const target = devDefaultProxyTarget();
    expect(target).toBe('https://api.clipchain.top');
    const view = resolveUpstreamView(getUpstream(), target);
    expect(view.effective).toBe('https://api.clipchain.top');
    expect(view.source).toBe('default');
    expect(view.isProduction).toBe(true);
  });
});

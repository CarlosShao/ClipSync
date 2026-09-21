import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPSTREAM_HEADER,
  adoptUpstreamFromQuery,
  clearUpstream,
  getUpstream,
  mockInterceptsApi,
  normalizeUpstream,
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
});

describe('normalizeUpstream', () => {
  it('去掉尾斜杠，保留纯 origin', () => {
    expect(normalizeUpstream('  https://api.clipchain.top/  ')).toBe('https://api.clipchain.top');
    expect(normalizeUpstream('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
  });

  it('拒绝带路径/凭据/非 http 的地址（转发目标只能是 origin）', () => {
    for (const bad of [
      '',
      'https://api.clipchain.top/api',
      'ftp://h',
      'localhost:3001',
      'https://u:p@h',
      'https://a b',
    ]) {
      expect(() => normalizeUpstream(bad), bad).toThrow();
    }
  });
});

describe('运行时后端地址', () => {
  it('未指定时不发上游头，也不关掉 MSW', () => {
    expect(getUpstream()).toBe('');
    expect(upstreamHeaders()).toEqual({});
    expect(mockInterceptsApi()).toBe(true);
  });

  it('指定之后：每个请求带 X-ClipSync-Upstream，MSW 让路', () => {
    setUpstream('https://api.clipchain.top');
    expect(upstreamHeaders()).toEqual({ [UPSTREAM_HEADER]: 'https://api.clipchain.top' });
    expect(mockInterceptsApi()).toBe(false);
  });

  it('恢复默认后回到假数据模式', () => {
    setUpstream('http://127.0.0.1:3001');
    clearUpstream();
    expect(getUpstream()).toBe('');
    expect(mockInterceptsApi()).toBe(true);
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
      'http://localhost:5273/sso?code=abc&api=https%3A%2F%2Fapi.clipchain.top'
    );
    adoptUpstreamFromQuery();
    expect(getUpstream()).toBe('https://api.clipchain.top');
    expect(calls).toEqual(['replace:/sso?code=abc', 'reload']);
  });

  it('地址没变就不重载，避免和桌面端每次点开都打一次白闪', () => {
    stubStorage({ [KEY]: 'https://api.clipchain.top' });
    const calls = stubWindow('http://localhost:5273/?api=https://api.clipchain.top');
    adoptUpstreamFromQuery();
    expect(calls.filter((c) => c === 'reload')).toEqual([]);
  });

  it('非法地址忽略，保留本地已存值', () => {
    stubStorage({ [KEY]: 'http://127.0.0.1:3001' });
    stubWindow('http://localhost:5273/?api=javascript%3Aalert(1)');
    adoptUpstreamFromQuery();
    expect(getUpstream()).toBe('http://127.0.0.1:3001');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamDevPanel } from './index';

/**
 * 2026-10-05 事故的界面侧回归：操作者的本机 `.env.development.local` 把 vite proxy 的
 * **默认目标**指到了生产，但面板只渲染「默认（vite proxy）」这个字面量，于是他判定
 * 「管理台连的是 dev」——判反了，而那个页面上的每一次退款/改配置都是真实生产操作。
 *
 * 这里直接渲染组件（react-dom/server，不引入新依赖；include 只收 *.test.ts，故用
 * createElement 不用 JSX），钉死「默认目标是生产」时界面必须显式喊出来。
 *
 * ⚠ 两个 env 都要给：真实现场是 `VITE_ENABLE_MSW=false` + 默认目标=生产。
 * MSW 开着时请求根本不到 proxy（面板如实显示「假数据」），此时不声称直连生产是对的语义。
 */

const MSW_OFF = 'false';

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

/** className 拿到的是 CSS module 的 stub，断言只看文本 */
function render(): string {
  return renderToStaticMarkup(createElement(UpstreamDevPanel));
}

beforeEach(() => {
  stubStorage();
  vi.stubEnv('VITE_ENABLE_MSW', MSW_OFF);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('UpstreamDevPanel 必须说清 /api 到底打到哪', () => {
  it('默认目标是生产（= 2026-10-05 现场）：显示该地址并标明「直连生产」', () => {
    vi.stubEnv('VITE_PROXY_TARGET', 'https://api.clipchain.top');
    const html = render();
    // 过去这里只有「默认（vite proxy）」这一个字面量，真值完全看不见
    expect(html).toContain('默认（vite proxy）→ https://api.clipchain.top');
    expect(html).toContain('直连生产');
  });

  it('默认目标是本地：不算生产，标为「直连」', () => {
    vi.stubEnv('VITE_PROXY_TARGET', 'http://127.0.0.1:3001');
    const html = render();
    expect(html).toContain('默认（vite proxy）→ http://127.0.0.1:3001');
    expect(html).not.toContain('直连生产');
  });

  it('未显式配置时不假装知道目标，也不误报生产', () => {
    vi.stubEnv('VITE_PROXY_TARGET', '');
    const html = render();
    expect(html).toContain('未显式配置');
    expect(html).not.toContain('直连生产');
  });

  it('面板里填过地址（runtime）时以它为准，不因默认目标是生产而误报', () => {
    vi.stubEnv('VITE_PROXY_TARGET', 'https://api.clipchain.top');
    stubStorage({ 'clipsync.admin.upstream': 'http://127.0.0.1:3001' });
    const html = render();
    expect(html).toContain('http://127.0.0.1:3001');
    expect(html).not.toContain('直连生产');
  });

  it('MSW 开着时如实显示「假数据」——请求不到 proxy，就不该声称直连生产', () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'true');
    vi.stubEnv('VITE_PROXY_TARGET', 'https://api.clipchain.top');
    const html = render();
    expect(html).toContain('假数据');
    expect(html).not.toContain('直连生产');
  });
});

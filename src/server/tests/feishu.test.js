import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 飞书群告警（迁移 091）
 *
 * 钉住四件事：
 *   ① 未配置 / URL 不是飞书域名 ⇒ **不发任何网络请求**（不能因为配错就静默狂发 ✗）；
 *   ② 配好后发的是 `msg_type:'text'`，带 title/lines ✓；
 *   ③ **同键 5 分钟内只发一条**（故障持续时不刷屏 ✓），不同键互不影响 ✓；
 *   ④ 发送失败/网络异常都只返回结果、**不抛给调用方**（它在错误上报主链路上 ✓）。
 */

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({ default: { query: (...a) => queryMock(...a) } }));
vi.mock('../src/utils/encryption.js', () => ({ decryptField: (v) => `dec:${v}` }));

const { getFeishuConfig, sendFeishuAlert, invalidateFeishuConfigCache, signForFeishu, resetFeishuThrottle } =
  await import('../src/utils/feishu.js');

const withConfig = (url, secretCipher = '') =>
  queryMock.mockResolvedValue({
    rows: [
      { config_key: 'feishu_webhook_url', config_value: secretCipher === null ? url : url },
      { config_key: 'feishu_webhook_secret', config_value: secretCipher },
    ],
  });

beforeEach(() => {
  queryMock.mockReset();
  invalidateFeishuConfigCache();
  resetFeishuThrottle();
});
afterEach(() => vi.unstubAllGlobals());

describe('配置解析', () => {
  it('未填 ⇒ 未启用', async () => {
    withConfig('');
    await expect(getFeishuConfig()).resolves.toMatchObject({ enabled: false, webhookUrl: '' });
  });

  it('填了非飞书域名 ⇒ 未启用（不发请求）', async () => {
    withConfig('https://example.com/hook/abc');
    await expect(getFeishuConfig()).resolves.toMatchObject({ enabled: false });
  });

  it('飞书域名 ⇒ 启用', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
    await expect(getFeishuConfig()).resolves.toMatchObject({ enabled: true });
  });
});

describe('sendFeishuAlert', () => {
  it('未配置 ⇒ not_configured，且不发任何请求', async () => {
    withConfig('');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(sendFeishuAlert({ key: 'http_5xx', title: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'not_configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('配好 ⇒ 发 msg_type=text，带标题与明细', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(sendFeishuAlert({ key: 'http_5xx', title: '服务端错误：boom', lines: ['path: /x'] })).resolves.toEqual({
      ok: true,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('boom');
    expect(body.content.text).toContain('path: /x');
  });

  it('同键节流：5 分钟内第二条被拦；不同键不受影响', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(sendFeishuAlert({ key: 'k1', title: 'a' })).resolves.toEqual({ ok: true });
    await expect(sendFeishuAlert({ key: 'k1', title: 'b' })).resolves.toMatchObject({ reason: 'throttled' });
    await expect(sendFeishuAlert({ key: 'k2', title: 'c' })).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('HTTP 4xx/5xx ⇒ 返回失败但**不抛**', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 })));
    await expect(sendFeishuAlert({ key: 'k', title: 'x' })).resolves.toMatchObject({ reason: 'http_400' });
  });

  it('网络异常 ⇒ network_error，不抛', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(sendFeishuAlert({ key: 'k', title: 'x' })).resolves.toMatchObject({ reason: 'network_error' });
  });

  it('带 secret ⇒ 请求体含 timestamp + sign（飞书签名校验）', async () => {
    withConfig('https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'cipher');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await sendFeishuAlert({ key: 'k', title: 'x' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.timestamp).toMatch(/^\d+$/);
    expect(typeof body.sign).toBe('string');
    expect(body.sign.length).toBeGreaterThan(10);
  });
});

describe('signForFeishu', () => {
  it('稳定输出（同一入参同结果，base64）', () => {
    const a = signForFeishu('secret', 1700000000);
    expect(a).toBe(signForFeishu('secret', 1700000000));
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

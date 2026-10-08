import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 第三方登录 · 设备码流（迁移 089）
 *
 * 钉住四件事：
 *   ① 未配置 Client ID ⇒ 入口不可用（前端据此隐藏按钮，避免"点了没反应"）；
 *   ② **device_code 绝不外发**：只回 opaque 的 pollToken（AES 加密），并且服务端能解回来；
 *   ③ 轮询的中间态（authorization_pending / slow_down）必须与真失败区分开 ——
 *      前者是正常等待，映射成 pending/slow_down，不能当错误；
 *   ④ 各类失败（过期/拒绝/网络错）映射成明确 reason。
 */

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  default: { query: (...a) => queryMock(...a), connect: vi.fn() },
}));
vi.mock('../src/utils/encryption.js', () => ({
  // 可逆的假加密：base64（**不是**明文包裹 —— 否则"外发内容不含 device_code"这条断言自相矛盾）
  encryptField: (s) => `enc64:${Buffer.from(String(s), 'utf8').toString('base64')}`,
  decryptField: (s) =>
    typeof s === 'string' && s.startsWith('enc64:')
      ? Buffer.from(s.slice(6), 'base64').toString('utf8')
      : s,
}));

const { getOAuthConfig, listProviders, startDeviceFlow, pollDeviceFlow, invalidateOAuthConfigCache } =
  await import('../src/services/oauthDevice.js');

const row = (key, value) => ({ config_key: key, config_value: value });
const withConfig = (o = {}) =>
  queryMock.mockResolvedValue({
    rows: [
      row('oauth_github_client_id', o.github ?? ''),
      row('oauth_microsoft_client_id', o.ms ?? ''),
      row('oauth_microsoft_tenant', o.tenant ?? 'common'),
    ],
  });

beforeEach(() => {
  queryMock.mockReset();
  invalidateOAuthConfigCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('配置与入口可见性', () => {
  it('都没配 ⇒ configured 全 false（前端隐藏两个入口）', async () => {
    withConfig({});
    const cfg = await getOAuthConfig();
    expect(listProviders(cfg)).toEqual([
      { provider: 'github', name: 'GitHub', configured: false },
      { provider: 'microsoft', name: 'Microsoft', configured: false },
    ]);
  });

  it('配了 GitHub ⇒ 只有 GitHub 可见', async () => {
    withConfig({ github: 'Ov23liTest' });
    const list = listProviders(await getOAuthConfig());
    expect(list.find((p) => p.provider === 'github')?.configured).toBe(true);
    expect(list.find((p) => p.provider === 'microsoft')?.configured).toBe(false);
  });

  it('未配置时发起 ⇒ not_configured，且不发网络请求', async () => {
    withConfig({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(startDeviceFlow('github')).resolves.toMatchObject({ ok: false, reason: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('startDeviceFlow', () => {
  it('成功：回 user_code / 链接 / interval，且 **不含 device_code 原文**', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            device_code: 'DEVICE-SECRET-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
      }))
    );

    const r = await startDeviceFlow('github');
    expect(r.ok).toBe(true);
    expect(r.userCode).toBe('WDJB-MJHT');
    expect(r.verificationUri).toContain('github.com/login/device');
    expect(r.interval).toBe(5);
    // ★ device_code 只能以加密形式存在于 pollToken 里，不能作为字段外发
    expect(r.deviceCode).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('DEVICE-SECRET-1');
    // pollToken 能解回原 device_code —— 由下面 poll 用例覆盖（真实现是 AES 密文）
    expect(typeof r.pollToken).toBe('string');
    expect(r.pollToken.length).toBeGreaterThan(10);
  });

  it('服务端错误 ⇒ start_failed 带 detail', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: 'invalid_client', error_description: 'bad client id' }) }))
    );
    const r = await startDeviceFlow('github');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('start_failed');
    expect(r.detail).toContain('bad client id');
  });

  it('未知 provider ⇒ unknown_provider', async () => {
    withConfig({});
    await expect(startDeviceFlow('facebook')).resolves.toMatchObject({ ok: false, reason: 'unknown_provider' });
  });
});

describe('pollDeviceFlow：中间态与失败必须分开', () => {
  const pollTokenFor = () =>
    'enc64:' + Buffer.from(JSON.stringify({ provider: 'github', deviceCode: 'DC-1' }), 'utf8').toString('base64');

  it('authorization_pending ⇒ pending（正常等待，不是错误）', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: 'authorization_pending' }) })));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ ok: false, reason: 'pending' });
  });

  it('slow_down ⇒ slow_down', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: 'slow_down' }) })));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ ok: false, reason: 'slow_down' });
  });

  it('expired_token / access_denied ⇒ 各自 reason', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: 'expired_token' }) })));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ reason: 'expired' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: 'access_denied' }) })));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ reason: 'denied' });
  });

  it('成功 ⇒ 返回 accessToken', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'gho_xxx' }) })));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ ok: true, accessToken: 'gho_xxx' });
  });

  it('pollToken 被篡改/不是本 provider ⇒ invalid_poll_token（不请求网络）', async () => {
    withConfig({ github: 'cid-1' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(pollDeviceFlow('github', 'garbage')).resolves.toMatchObject({ reason: 'invalid_poll_token' });
    const msToken =
      'enc64:' + Buffer.from(JSON.stringify({ provider: 'microsoft', deviceCode: 'DC-2' }), 'utf8').toString('base64');
    await expect(pollDeviceFlow('github', msToken)).resolves.toMatchObject({ reason: 'invalid_poll_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('网络异常 ⇒ network_error（不抛给调用方）', async () => {
    withConfig({ github: 'cid-1' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(pollDeviceFlow('github', pollTokenFor())).resolves.toMatchObject({ reason: 'network_error' });
  });
});

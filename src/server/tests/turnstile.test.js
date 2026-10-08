import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 人机验证（Cloudflare Turnstile）· 迁移 088
 *
 * 最要紧的三件事：
 *   ① **默认未启用时零影响** —— 发码接口是桌面端/移动端/管理台共用的，一旦误判成"启用"，
 *      所有没挂 widget 的客户端会立刻登录不了；
 *   ② 半配状态（只填了 site key 或只填了 secret）必须按**未启用**处理，同理不能锁死登录；
 *   ③ 启用后：缺 token 拒绝、校验失败拒绝、**校验服务不可用也拒绝（fail-closed）**——这是安全门控。
 */

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  default: { query: (...args) => queryMock(...args) },
}));
vi.mock('../src/utils/encryption.js', () => ({ decryptField: (v) => `dec:${v}` }));

const { getTurnstileConfig, verifyTurnstile, invalidateTurnstileConfigCache, gateCaptcha } = await import(
  '../src/utils/turnstile.js'
);

const row = (key, value) => ({ config_key: key, config_value: value });
const withConfig = (o) =>
  queryMock.mockResolvedValue({
    rows: [
      row('turnstile_site_key', o.site ?? ''),
      row('turnstile_secret_key', o.secretCipher ?? ''),
      row('turnstile_enabled', o.enabled === undefined ? 'false' : String(o.enabled)),
    ],
  });

beforeEach(() => {
  queryMock.mockReset();
  invalidateTurnstileConfigCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('配置读取：enabled 只在密钥齐全时为真', () => {
  it('全空 ⇒ 未启用', async () => {
    withConfig({});
    await expect(getTurnstileConfig()).resolves.toMatchObject({ enabled: false });
  });

  it('只有 site key ⇒ 未启用（半配不能锁死登录）', async () => {
    withConfig({ site: 'site-x', enabled: true });
    await expect(getTurnstileConfig()).resolves.toMatchObject({ enabled: false });
  });

  it('只有 secret ⇒ 未启用', async () => {
    withConfig({ secretCipher: 'cipher', enabled: true });
    await expect(getTurnstileConfig()).resolves.toMatchObject({ enabled: false });
  });

  it('密钥齐全 + 开关 true ⇒ 启用（secret 解密后使用）', async () => {
    withConfig({ site: 'site-x', secretCipher: 'cipher', enabled: true });
    await expect(getTurnstileConfig()).resolves.toMatchObject({
      siteKey: 'site-x',
      secretKey: 'dec:cipher',
      enabled: true,
    });
  });

  it('开关 false（即使密钥齐全）⇒ 未启用', async () => {
    withConfig({ site: 'site-x', secretCipher: 'cipher', enabled: false });
    await expect(getTurnstileConfig()).resolves.toMatchObject({ enabled: false });
  });
});

describe('verifyTurnstile', () => {
  it('未启用 ⇒ 直接放行（skipped），不发任何网络请求', async () => {
    withConfig({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(verifyTurnstile('whatever')).resolves.toMatchObject({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('启用但没带 token ⇒ 拒绝（missing_token），且不请求 Cloudflare', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(verifyTurnstile('')).resolves.toMatchObject({ ok: false, reason: 'missing_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('启用 + Cloudflare 判成功 ⇒ 放行', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true }) })));
    await expect(verifyTurnstile('tok', '1.2.3.4')).resolves.toMatchObject({ ok: true });
  });

  it('启用 + Cloudflare 判失败 ⇒ 拒绝并带 error-codes', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) })));
    await expect(verifyTurnstile('tok')).resolves.toMatchObject({
      ok: false,
      reason: 'verify_failed',
      codes: ['invalid-input-response'],
    });
  });

  it('★启用 + 校验服务不可用（网络错）⇒ fail-closed 拒绝', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    await expect(verifyTurnstile('tok')).resolves.toMatchObject({ ok: false, reason: 'verify_unavailable' });
  });
});

describe('gateCaptcha：给路由用的门控语义', () => {
  it('未启用 ⇒ ok（放行）', async () => {
    withConfig({});
    await expect(gateCaptcha({ body: {}, headers: {} })).resolves.toMatchObject({ ok: true });
  });

  it('启用 + 缺 token ⇒ 400 且文案可执行', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    const r = await gateCaptcha({ body: {}, headers: {} });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.message).toContain('人机验证');
  });

  it('启用 + 头里带 token 也算（客户端可用 header 传）', async () => {
    withConfig({ site: 's', secretCipher: 'c', enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true }) })));
    await expect(gateCaptcha({ body: {}, headers: { 'x-turnstile-token': 'tok' } })).resolves.toMatchObject({ ok: true });
  });
});

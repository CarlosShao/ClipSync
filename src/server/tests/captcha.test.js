import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 人机验证 provider 抽象（迁移 090）+ 自建滑块
 *
 * 最要紧的几件事：
 *   ① 默认 `off` ⇒ 门控**必须放行**（行为与加此模块之前一致，不能把登录卡住）；
 *   ② `turnstile` 半配（缺 site/secret）⇒ 视为关闭（同理不锁登录）；
 *   ③ 自建滑块：出题返回体里**不能含缺口坐标**（只在签名 token 里）；答对放行、答错/过期/复用拒绝；
 *   ④ 轨迹启发式：点太少或"瞬移"当脚本拒掉。
 */

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({ default: { query: (...a) => queryMock(...a) } }));
const turnstileMock = vi.hoisted(() => ({
  getTurnstileConfig: vi.fn(),
  verifyTurnstile: vi.fn(),
}));
vi.mock('../src/utils/turnstile.js', () => turnstileMock);

const {
  getCaptchaConfig,
  invalidateCaptchaConfigCache,
  issueSliderChallenge,
  verifySlider,
  checkCaptcha,
} = await import('../src/utils/captcha.js');

const withProvider = (p) =>
  queryMock.mockResolvedValue({ rows: [{ config_key: 'captcha_provider', config_value: p }] });

beforeEach(() => {
  queryMock.mockReset();
  turnstileMock.getTurnstileConfig.mockReset();
  turnstileMock.verifyTurnstile.mockReset();
  invalidateCaptchaConfigCache();
});

describe('provider 解析', () => {
  it('默认 off ⇒ 未启用', async () => {
    withProvider('off');
    await expect(getCaptchaConfig()).resolves.toMatchObject({ provider: 'off', enabled: false });
  });

  it('turnstile 但凭据不全 ⇒ 降级为 off（避免锁死登录）', async () => {
    withProvider('turnstile');
    turnstileMock.getTurnstileConfig.mockResolvedValue({ siteKey: '', secretKey: '', enabled: false });
    await expect(getCaptchaConfig()).resolves.toMatchObject({ provider: 'off', enabled: false });
  });

  it('turnstile 凭据齐全 ⇒ 启用', async () => {
    withProvider('turnstile');
    turnstileMock.getTurnstileConfig.mockResolvedValue({ siteKey: 'sk', secretKey: 'sec', enabled: true });
    await expect(getCaptchaConfig()).resolves.toMatchObject({
      provider: 'turnstile',
      enabled: true,
      turnstileSiteKey: 'sk',
    });
  });

  it('self ⇒ 启用（无需任何第三方凭据）', async () => {
    withProvider('self');
    await expect(getCaptchaConfig()).resolves.toMatchObject({ provider: 'self', enabled: true });
  });

  it('未知取值 ⇒ 按 off 处理', async () => {
    withProvider('whatever');
    await expect(getCaptchaConfig()).resolves.toMatchObject({ provider: 'off', enabled: false });
  });
});

describe('门控：off 时必须放行', () => {
  it('off ⇒ checkCaptcha 直接 ok，不调任何校验', async () => {
    withProvider('off');
    await expect(checkCaptcha({ body: {} })).resolves.toEqual({ ok: true });
    expect(turnstileMock.verifyTurnstile).not.toHaveBeenCalled();
  });

  it('turnstile ⇒ 委托 utils/turnstile.js（不重复实现）', async () => {
    withProvider('turnstile');
    turnstileMock.getTurnstileConfig.mockResolvedValue({ siteKey: 'sk', secretKey: 'sec', enabled: true });
    turnstileMock.verifyTurnstile.mockResolvedValue({ ok: true });
    await expect(checkCaptcha({ body: { turnstileToken: 't' }, ip: '1.1.1.1' })).resolves.toEqual({ ok: true });
    expect(turnstileMock.verifyTurnstile).toHaveBeenCalledWith('t', '1.1.1.1');
  });

  it('self + 缺 token ⇒ 400 且文案可执行', async () => {
    withProvider('self');
    const r = await checkCaptcha({ body: {} });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.message).toContain('滑块');
  });
});

describe('自建滑块：出题与校验', () => {
  beforeEach(() => withProvider('self'));

  it('出题返回两张 PNG，且**返回体里不含缺口坐标**，坐标只在 token 里', async () => {
    const c = await issueSliderChallenge();
    expect(c.background.startsWith('data:image/png;base64,')).toBe(true);
    expect(c.piece.startsWith('data:image/png;base64,')).toBe(true);
    expect(c.pieceSize).toBeGreaterThan(20);
    // 返回体里不能出现 x（只有 token 是签名后的不透明串）
    const asText = JSON.stringify({ ...c, background: '', piece: '' });
    expect(asText).not.toMatch(/"x"\s*:/);
    expect(c.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // body.sig
  });

  it('答对 ⇒ 放行；同一 token 复用 ⇒ 拒绝', async () => {
    const c = await issueSliderChallenge();
    // token 的 body 可解（base64）但签名不可伪造；测试里直接解开取 x 模拟"正确答案"
    const body = JSON.parse(Buffer.from(c.token.split('.')[0], 'base64url').toString('utf8'));
    await expect(verifySlider(c.token, body.x, { points: 20, durationMs: 900 })).resolves.toEqual({ ok: true });
    await expect(verifySlider(c.token, body.x, { points: 20, durationMs: 900 })).resolves.toMatchObject({
      ok: false,
      reason: 'reused',
    });
  });

  it('答错（超出容差）⇒ mismatch', async () => {
    const c = await issueSliderChallenge();
    const body = JSON.parse(Buffer.from(c.token.split('.')[0], 'base64url').toString('utf8'));
    await expect(verifySlider(c.token, body.x + 40, { points: 20, durationMs: 900 })).resolves.toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('轨迹"瞬移"⇒ robotic_track', async () => {
    const c = await issueSliderChallenge();
    const body = JSON.parse(Buffer.from(c.token.split('.')[0], 'base64url').toString('utf8'));
    await expect(verifySlider(c.token, body.x, { points: 3, durationMs: 50 })).resolves.toMatchObject({
      ok: false,
      reason: 'robotic_track',
    });
  });

  it('伪造/篡改 token ⇒ invalid_token', async () => {
    const c = await issueSliderChallenge();
    const body = JSON.parse(Buffer.from(c.token.split('.')[0], 'base64url').toString('utf8'));
    const forged = `${Buffer.from(JSON.stringify({ ...body, x: 0 }), 'utf8').toString('base64url')}.${c.token.split('.')[1]}`;
    await expect(verifySlider(forged, 0, { points: 20, durationMs: 900 })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_token',
    });
  });
});

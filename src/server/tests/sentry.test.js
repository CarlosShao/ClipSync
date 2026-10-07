import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 错误追踪（Sentry）接线 · 迁移 086 —— 未配置则全程 no-op
 *
 * 为什么要单独钉住这几件事：
 *   1. **未配置 DSN 时必须零副作用**：不能加载 SDK、不能抛错、`captureError` 必须静默 false。
 *      这是"加了这个功能但没人用"的默认路径，写错了会影响所有环境。
 *   2. **PII 清洗**：一旦漏，就是把用户手机号/邮箱/剪贴板内容/令牌送给第三方。
 *      这条只能靠测试钉——code review 看不出 `event.extra` 里会不会漏字段。
 *   3. **DSN 形状校验**：运营手填自由文本，填错不能让 init 抛错；宁判"未配置"。
 *   4. **缓存与失效**：5s 缓存 + 管理台保存即失效（改完即时生效，不必重启容器）。
 */

const queryMock = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  default: { query: (...args) => queryMock(...args) },
}));

const { isValidDsn, getSentryDsn, invalidateSentryConfigCache, scrubEvent, captureError, isSentryEnabled } =
  await import('../src/utils/sentry.js');

/** 造一行 system_configs（jsonb 列经 pg 解析后是 JS 值） */
const row = (key, value) => ({ config_key: key, config_value: value });

beforeEach(() => {
  queryMock.mockReset();
  invalidateSentryConfigCache();
  delete process.env.SENTRY_DSN;
});

describe('isValidDsn：只认 http(s)://<key>@<host>/<project>', () => {
  it('合法（Sentry 官方与自托管/GlitchTip 两种形状都放行）', () => {
    expect(isValidDsn('https://abc123@o4507123.ingest.sentry.io/4507123456')).toBe(true);
    expect(isValidDsn('http://key@glitchtip.internal/1')).toBe(true);
  });

  it('非法：空 / 说明文字 / 缺 @ / 缺 project / 带空格 / 带路径', () => {
    for (const v of [
      '',
      null,
      undefined,
      '请填 Sentry DSN',
      'https://o4507.ingest.sentry.io/4507', // 缺 publicKey@
      'https://abc123@o4507.ingest.sentry.io', // 缺 projectId
      'https://abc123@o4507.ingest.sentry.io/4507 的 key', // 带空格
      'ftp://abc123@host/1', // 协议不对
    ]) {
      expect(isValidDsn(v), `应判非法：${String(v)}`).toBe(false);
    }
  });

  it('带子路径的 DSN 仍判合法（自托管可能挂在 /sentry/ 下）', () => {
    expect(isValidDsn('https://key@example.com/sentry/42')).toBe(true);
  });
});

describe('getSentryDsn：DB 优先、env 兜底、缓存 5s、可失效', () => {
  it('库里为空且 env 未设 ⇒ 空串（未配置）', async () => {
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', '')] });
    await expect(getSentryDsn()).resolves.toBe('');
  });

  it('库里是合法 DSN ⇒ 原样返回', async () => {
    const dsn = 'https://abc@o1.ingest.sentry.io/2';
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', dsn)] });
    await expect(getSentryDsn()).resolves.toBe(dsn);
  });

  it('库里是非法文本 ⇒ 空串（不让手填的说明文字把 init 搞崩）', async () => {
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', '回头再填')] });
    await expect(getSentryDsn()).resolves.toBe('');
  });

  it('jsonb 对象形状也能取（value 字段）', async () => {
    const dsn = 'https://abc@o1.ingest.sentry.io/3';
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', { value: dsn })] });
    await expect(getSentryDsn()).resolves.toBe(dsn);
  });

  it('缓存 5s：连续两次只查一次库；invalidate 后重新回源', async () => {
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', 'https://a@h/1')] });
    await getSentryDsn();
    await getSentryDsn();
    expect(queryMock).toHaveBeenCalledTimes(1);

    invalidateSentryConfigCache();
    await getSentryDsn();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('读库失败不抛错（按未配置处理），且不覆盖已有快照', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    await expect(getSentryDsn()).resolves.toBe('');
    // 第二次仍失败，也不该抛
    await expect(getSentryDsn()).resolves.toBe('');
  });

  it('env 兜底：库为空但 SENTRY_DSN 已设 ⇒ 用 env（兼容老部署）', async () => {
    process.env.SENTRY_DSN = 'https://envkey@o9.ingest.sentry.io/9';
    queryMock.mockResolvedValue({ rows: [row('sentry_dsn', '')] });
    await expect(getSentryDsn()).resolves.toBe(process.env.SENTRY_DSN);
  });
});

describe('scrubEvent：PII 一律剔除', () => {
  it('请求体 / Cookie / Authorization / 敏感 query → 全清', () => {
    const event = {
      request: {
        data: { content: '我的剪贴板内容', password: 'p@ss' },
        cookies: { session: 'abc' },
        env: { SECRET: 'x' },
        query_string: '?phone=13505110772&token=abc',
        headers: { Authorization: 'Bearer x', 'X-CSRF-Token': 'y', 'User-Agent': 'ok' },
      },
    };
    scrubEvent(event);
    expect(event.request.data).toBeUndefined();
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.env).toBeUndefined();
    expect(event.request.query_string).toBe('[Filtered]');
    expect(event.request.headers.Authorization).toBeUndefined();
    expect(event.request.headers['X-CSRF-Token']).toBeUndefined();
    expect(event.request.headers['User-Agent']).toBe('ok'); // 非敏感头保留，便于定位
  });

  it('extra 里的手机号/邮箱/密钥/剪贴板字段 → [Filtered]', () => {
    const event = {
      extra: { phone: '13505110772', Email: 'a@b.com', sms_access_key_secret: 'k', clipboardContent: 'x', path: '/ok' },
    };
    scrubEvent(event);
    expect(event.extra.phone).toBe('[Filtered]');
    expect(event.extra.Email).toBe('[Filtered]');
    expect(event.extra.sms_access_key_secret).toBe('[Filtered]');
    expect(event.extra.clipboardContent).toBe('[Filtered]');
    expect(event.extra.path).toBe('/ok');
  });

  it('user 段整体删除（不把身份交给第三方）', () => {
    const event = { user: { id: 'u1', phone: '135' }, message: 'boom' };
    scrubEvent(event);
    expect(event.user).toBeUndefined();
    expect(event.message).toBe('boom');
  });

  it('畸形入参不抛错（清洗失败绝不能影响上报链路）', () => {
    expect(() => scrubEvent(undefined)).not.toThrow();
    expect(() => scrubEvent('str')).not.toThrow();
    expect(() => scrubEvent({ request: 'not-an-object', extra: 42 })).not.toThrow();
  });
});

describe('未配置时：captureError 必须是静默 no-op', () => {
  it('返回 false、不抛错、isSentryEnabled 为 false', () => {
    expect(isSentryEnabled()).toBe(false);
    expect(() => captureError(new Error('x'), { path: '/a' })).not.toThrow();
    expect(captureError(new Error('x'))).toBe(false);
    expect(captureError('字符串原因')).toBe(false);
    expect(captureError(null)).toBe(false);
  });
});

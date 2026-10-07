import { describe, it, expect } from 'vitest';
import { normalizeSmtpTls } from '../src/utils/email.js';

/**
 * SMTP TLS 模式按端口归一化（2026-10-07 修）
 *
 * 起因：owner 在生产管理台点「发送测试邮件」报
 *   `58A20199DE7F0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number`
 * 现场配置是 **smtp.qq.com:587 + 勾了 SSL 直连**：587 是 STARTTLS（先明文打招呼再升级），
 * 而 SSL 直连（隐式 TLS）必须配 465。旧实现只做了单向兜底
 * `secure: channel.secure || channel.port === 465`——能救"465 但没勾 SSL"，
 * 救不了"587 却勾了 SSL" ⇒ 按隐式 TLS 去连 587，对端回明文 banner，OpenSSL 报上面那句。
 *
 * 现在双向按端口纠正，并回传 corrected 让调用方告警。本文件把四种组合钉死。
 */

describe('normalizeSmtpTls：按端口决定 TLS 模式（双向纠正）', () => {
  it('465 ⇒ 隐式 TLS（secure:true），且不需要 requireTLS', () => {
    expect(normalizeSmtpTls(465, true)).toEqual({ secure: true, requireTLS: false, corrected: false });
  });

  it('465 但没勾 SSL ⇒ 纠正为 secure:true 并标记 corrected', () => {
    expect(normalizeSmtpTls(465, false)).toEqual({ secure: true, requireTLS: false, corrected: true });
    expect(normalizeSmtpTls(465, undefined)).toEqual({ secure: true, requireTLS: false, corrected: true });
  });

  it('587 + 勾了 SSL ⇒ 纠正为 STARTTLS（secure:false + requireTLS:true）并标记 corrected ★本次线上故障', () => {
    expect(normalizeSmtpTls(587, true)).toEqual({ secure: false, requireTLS: true, corrected: true });
  });

  it('587 + 未勾 SSL ⇒ STARTTLS，无需纠正', () => {
    expect(normalizeSmtpTls(587, false)).toEqual({ secure: false, requireTLS: true, corrected: false });
  });

  it('25 / 其它端口 ⇒ 一律按 STARTTLS', () => {
    for (const p of [25, 2525, 1025]) {
      expect(normalizeSmtpTls(p, false)).toEqual({ secure: false, requireTLS: true, corrected: false });
      expect(normalizeSmtpTls(p, true)).toEqual({ secure: false, requireTLS: true, corrected: true });
    }
  });

  it('端口缺失/非法 ⇒ 回落到 587 + STARTTLS（表单必填，这里是防御）', () => {
    expect(normalizeSmtpTls(undefined, false)).toEqual({ secure: false, requireTLS: true, corrected: false });
    expect(normalizeSmtpTls(null, true)).toEqual({ secure: false, requireTLS: true, corrected: true });
    expect(normalizeSmtpTls('abc', false)).toEqual({ secure: false, requireTLS: true, corrected: false });
    expect(normalizeSmtpTls('465', true)).toEqual({ secure: true, requireTLS: false, corrected: false });
  });

  it('requireTLS 只在 STARTTLS 模式下为真（该模式下拒绝明文降级发送凭据）', () => {
    expect(normalizeSmtpTls(465, true).requireTLS).toBe(false);
    expect(normalizeSmtpTls(587, false).requireTLS).toBe(true);
  });
});

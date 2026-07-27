/**
 * TOTP (RFC 6238) 实现，基于 Node 内置 crypto，无第三方依赖。
 * 用于两步验证（2FA）：生成随机 base32 密钥、校验 Authenticator 输入的 6 位动态码。
 */
import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 解码（忽略空格/连字符，RFC 4648 无填充） */
function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const ch of input.toUpperCase()) {
    if (ch === ' ' || ch === '-') continue;
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

/** 生成随机 base32 密钥（默认 20 字节 = 160 bit，对应 32 个字符） */
export function generateSecret(byteLength = 20) {
  const buf = crypto.randomBytes(byteLength);
  let secret = '';
  for (const b of buf) {
    secret += BASE32_ALPHABET[b & 31];
  }
  return secret;
}

/** 生成指定时间步的动态码 */
function tokenForCounter(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return code.toString().padStart(digits, '0');
}

/** 校验动态码，允许 ±window 个时间步漂移（默认 ±1 = ±30s） */
export function verifyToken(secret, token, window = 1, timeStep = 30, digits = 6) {
  const cleaned = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const forTime = Date.now();
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const counter = Math.floor((forTime + errorWindow * timeStep * 1000) / 1000 / timeStep);
    if (tokenForCounter(secret, counter, digits) === cleaned) return true;
  }
  return false;
}

/** 生成 otpauth:// URI，供 Authenticator App 扫描 */
export function buildOtpauthUri(secret, account, issuer = 'ClipSync') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
